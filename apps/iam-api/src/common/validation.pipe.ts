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
 * schema to find and waves the body through unvalidated.
 *
 * A parameter whose type carries no schema is passed through untouched, which
 * is what keeps `@Param('id') id: string` working.
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

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!hasSchema(metadata.metatype)) return value;

    const result = metadata.metatype.zodSchema.safeParse(value);
    if (result.success) return result.data;

    throw IamException.validationFailed(toDetails(result.error));
  }
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
