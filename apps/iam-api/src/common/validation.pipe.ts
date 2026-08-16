/**
 * Request validation, on zod (Doc 06 §2 — 400 `VALIDATION_FAILED`).
 *
 * zod rather than `class-validator` because the workspace already validates
 * its environment and its contracts with zod, and a second validation library
 * means two places where "required" and "optional" are decided differently.
 *
 * ## Why the global pipe needs a DTO class
 *
 * Nest hands a pipe the parameter's *class*, so the schema has to be reachable
 * from one. `createZodDto` produces that class:
 *
 * ```ts
 * const loginSchema = z.object({ email: z.email(), clientSlug: z.string() });
 * export class LoginDto extends createZodDto(loginSchema) {}
 *
 * ⁣@Post('login')
 * login(@Body() body: LoginDto) { … }   // body is parsed, typed, and stripped
 * ```
 *
 * It must be a `class … extends`, not `const LoginDto = createZodDto(…)`:
 * TypeScript only emits `design:paramtypes` metadata for a type that is also a
 * value, and a type alias erases to `Object`, at which point the pipe has no
 * schema to find.
 *
 * ## The pass-through, and where it stops
 *
 * A parameter whose type carries no schema is passed through untouched. That is
 * required for `@Param('id') id: string` and `@Query() q: string`, whose
 * metatypes are primitives that no schema could be attached to.
 *
 * It stops at `@Body()`. A body is the one input that arrives as an
 * attacker-shaped object and travels into the repository layer, so a body the
 * pipe cannot validate is refused at request time rather than waved through:
 *
 * ```ts
 * ⁣@Post()
 * create(@Body() body: SomeInterface) { … }   // throws — no schema to enforce
 * ```
 *
 * **`Object` and `undefined` metatypes count as failures, not as exemptions**,
 * and that is the whole point rather than an edge case. The two mistakes this
 * rule exists to catch — an interface, and the `const … = createZodDto(…)` alias
 * the section above warns about — *both* erase to `Object`. Skipping `Object`
 * would leave the rule catching nothing at all. A body annotated with no type
 * at all (metatype `undefined`) is the same failure with less information.
 *
 * `String`, `Number` and `Boolean` remain allowed on a body, because a primitive
 * cannot carry unvalidated fields into a repository: that is `@Body('email')
 * email: string`, a property extraction, which nothing in this API uses today
 * and which stays available without weakening anything.
 *
 * The refusal is a plain `Error`, not an {@link IamException}. Reaching it is a
 * wiring bug in *this* codebase, not a malformed request — the caller did
 * nothing wrong and there is no field-level complaint to hand back. So it takes
 * the filter's 500 path, where the message is logged with the request id and
 * never returned (`http-exception.filter.ts`). Failing every request to the
 * route is deliberate: the alternative is a route that quietly accepts anything,
 * which is the failure this file's own header has warned about since Session 5
 * without being able to enforce it.
 *
 * ## Two properties worth naming
 *
 * Parsing **replaces** the value with zod's output, so coercions and defaults
 * reach the handler and the handler's type is honest. And `z.object` strips
 * unknown keys by default, so an extra field in the body cannot reach a
 * repository — the mass-assignment hole that a validator which only *checks*
 * leaves open.
 */

import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { IamErrorDetail } from '@plantops/contracts';
import { type ZodType, z } from 'zod';
import { IamException } from './iam.exception';

/** The static side of a DTO class produced by {@link createZodDto}. */
export interface ZodDtoClass<T = unknown> {
  new (): T;
  readonly zodSchema: ZodType<T>;
}

/**
 * Builds the base class for a validated DTO. Extend it; do not alias it.
 */
export function createZodDto<S extends ZodType>(
  schema: S,
): ZodDtoClass<z.output<S>> {
  class ZodDto {
    static readonly zodSchema = schema;
  }
  return ZodDto as unknown as ZodDtoClass<z.output<S>>;
}

function hasSchema(metatype: unknown): metatype is ZodDtoClass {
  return (
    typeof metatype === 'function' &&
    (metatype as Partial<ZodDtoClass>).zodSchema !== undefined
  );
}

/**
 * The DTO class behind a parameter's metatype, or `undefined`.
 *
 * The same test the pipe makes, exported for `openapi/` — which needs to answer
 * "what does this handler accept?" from exactly the artefact that decides
 * "what will this handler accept?". Reading the schema from anywhere else is how
 * a generated document ends up describing a validator that no longer exists.
 */
export function zodSchemaOf(metatype: unknown): ZodDtoClass | undefined {
  return hasSchema(metatype) ? metatype : undefined;
}

/**
 * Metatypes a `@Body()` may carry without a schema.
 *
 * Only the primitives, and only because a `string`, `number` or `boolean` has
 * no fields to mass-assign. Everything else — a class, an interface's `Object`,
 * an `Array`, an unannotated parameter's `undefined` — could be an object
 * reaching a repository unvalidated and unstripped.
 */
const BODY_SAFE_METATYPES: readonly unknown[] = Object.freeze([
  String,
  Number,
  Boolean,
]);

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!hasSchema(metadata.metatype)) {
      if (metadata.type === 'body') refuseUnvalidatableBody(metadata);
      return value;
    }

    const result = metadata.metatype.zodSchema.safeParse(value);
    if (result.success) return result.data;

    throw IamException.validationFailed(toDetails(result.error));
  }
}

/**
 * Refuses a `@Body()` the pipe has no schema for. See the header for why this
 * is a 500 rather than a 400, and why `Object` is a failure rather than an
 * exemption.
 */
function refuseUnvalidatableBody(metadata: ArgumentMetadata): void {
  if (BODY_SAFE_METATYPES.includes(metadata.metatype)) return;

  const declared =
    typeof metadata.metatype === 'function'
      ? metadata.metatype.name
      : 'no type annotation';

  throw new Error(
    `A @Body() parameter declared as \`${declared}\` carries no zod schema, so ` +
      'the pipe cannot validate or strip it and the raw parsed JSON would reach ' +
      'the handler. Declare the body as `class X extends createZodDto(schema) {}` ' +
      '— an interface, a `type` alias, `unknown` and `Record<string, unknown>` ' +
      'all erase to `Object` and produce exactly this error. See ' +
      'common/validation.pipe.ts.',
  );
}

/**
 * zod issues → the `details` array of the envelope.
 *
 * Only the path and zod's message are copied. The issue's `input`/`received`
 * fields are dropped deliberately: echoing a rejected value back would put a
 * malformed password or token into an error body and, from there, into
 * whatever logs that body.
 */
function toDetails(error: z.ZodError): IamErrorDetail[] {
  return error.issues.map((issue) => ({
    // Dotted for objects, bracketed for array indices: `roles[0].key`.
    field: issue.path.reduce<string>(
      (path, segment) =>
        typeof segment === 'number'
          ? `${path}[${segment}]`
          : path === ''
            ? String(segment)
            : `${path}.${String(segment)}`,
      '',
    ),
    message: issue.message,
  }));
}
