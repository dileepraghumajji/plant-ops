/**
 * `ZodValidationPipe` — what it validates, and what it now refuses to wave
 * through (Doc 06 §2).
 *
 * Two suites, because the claims are of two kinds. The pass-through rules are a
 * function of `ArgumentMetadata` — six combinations of `type` and `metatype`
 * that no HTTP request could enumerate readably — so they are asserted against
 * the pipe directly. The fail-closed body is a claim about the *assembled*
 * pipeline (that the pipe is registered, that its throw reaches the filter, and
 * that the route answers an error rather than a 200) and goes through the
 * harness.
 *
 * The case that matters is the one that used to pass silently: a handler whose
 * body type carries no schema received the raw parsed JSON — unvalidated,
 * unstripped, and mass-assignable into the repository layer. Every `@Body()` on
 * the real surface is a proper DTO class, so this closes a latent gap rather
 * than fixing a live bug, which is exactly when it is cheap to close.
 */

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { NoPermissionRequired, Public } from '@plantops/auth-kit';
import { IamErrorCode, type IamErrorResponse } from '@plantops/contracts';
import { z } from 'zod';
import { type Harness, createHarness } from '../testing/app-harness';
import { IamException } from './iam.exception';
import { SkipTransaction } from './transaction-context';
import { ZodValidationPipe, createZodDto } from './validation.pipe';

const widgetSchema = z.object({
  name: z.string().min(3, 'name must be at least 3 characters'),
  count: z.coerce.number().int().positive(),
});

class WidgetDto extends createZodDto(widgetSchema) {}

/** The mistake: a body typed by something that erases to `Object`. */
interface PlainWidget {
  name: string;
  count: number;
}

/** The same erasure by a different route — a `type` alias over the schema. */
type AliasedWidget = z.infer<typeof widgetSchema>;

// A fixture controller for a spec about something else. The pipeline it
// runs through is the real one, so an ungated route still has to say so.
@NoPermissionRequired('test fixture')
@Controller('__validation')
@Public()
@SkipTransaction()
class ValidationController {
  @Post('typed')
  @HttpCode(200)
  typed(@Body() body: WidgetDto): WidgetDto {
    return body;
  }

  @Post('interface')
  @HttpCode(200)
  untyped(@Body() body: PlainWidget): PlainWidget {
    return body;
  }

  @Post('aliased')
  @HttpCode(200)
  aliased(@Body() body: AliasedWidget): AliasedWidget {
    return body;
  }

  /** A bulk body — `Array`, not `Object`, and equally unvalidated. */
  @Post('array')
  @HttpCode(200)
  bulk(@Body() body: PlainWidget[]): PlainWidget[] {
    return body;
  }
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** What Nest hands the pipe as `metatype` — a constructor, or nothing. */
type Metatype = ArgumentMetadata['metatype'];

describe('ZodValidationPipe pass-through', () => {
  const pipe = new ZodValidationPipe();

  const meta = (
    type: ArgumentMetadata['type'],
    metatype?: Metatype,
  ): ArgumentMetadata => ({ type, metatype, data: undefined });

  const passThrough: Array<[ArgumentMetadata['type'], Metatype, string]> = [
    ['param', String, 'a uuid path segment'],
    ['query', String, 'a raw query string'],
    // Nest's `Paramtype` has no `headers` member: `@Headers()` and every
    // `createParamDecorator` — `@Claims()` included — arrive as `custom`.
    ['custom', String, 'a header value read through @Headers()'],
    ['custom', undefined, '@Claims(), whose value the pipe never sees a type for'],
  ];

  it.each(passThrough)('passes a %s through untouched — %s', (type, metatype) => {
    const value = { untouched: true };
    expect(pipe.transform(value, meta(type, metatype))).toBe(value);
  });

  it('passes a schemaless object through on a query, as before', () => {
    // Unchanged on purpose: the new rule is about bodies. A query is a flat
    // string map that no repository is handed wholesale.
    const value = { page: '2' };
    expect(pipe.transform(value, meta('query', Object))).toBe(value);
  });

  const allowedBodies: Array<[Metatype, string]> = [
    [String, "@Body('email') email: string"],
    [Number, "@Body('count') count: number"],
    [Boolean, "@Body('enabled') enabled: boolean"],
  ];

  it.each(allowedBodies)(
    'allows a %p body — %s has no fields to mass-assign',
    (metatype) => {
      expect(pipe.transform('anything', meta('body', metatype))).toBe('anything');
    },
  );

  const refusedBodies: Array<[Metatype, string]> = [
    [Object, 'an interface, a `type` alias, `unknown`, `Record<string, unknown>`'],
    [undefined, 'no type annotation at all'],
    [Array, 'a bare array'],
  ];

  it.each(refusedBodies)('refuses a %p body — %s', (metatype) => {
    expect(() => pipe.transform({}, meta('body', metatype))).toThrow(
      /carries no zod schema/,
    );
  });

  it('names the fix in the error, not just the problem', () => {
    let thrown: unknown;
    try {
      pipe.transform({}, meta('body', Object));
    } catch (error) {
      thrown = error;
    }

    // A developer-facing error that does not say what to do instead is a error
    // whose reader ends up here reading this file.
    expect((thrown as Error).message).toMatch(/createZodDto/);
    // Not an IamException: the caller did nothing wrong, so this must not be
    // reported as a 400 with an empty `details` array.
    expect(thrown).not.toBeInstanceOf(IamException);
  });

  it('still validates and strips a body that does carry a schema', () => {
    const parsed = pipe.transform(
      { name: 'valve', count: '3', sneaked: 'in' },
      meta('body', WidgetDto),
    );

    // Coerced, and the unknown key gone — the two properties the header names.
    expect(parsed).toEqual({ name: 'valve', count: 3 });
  });
});

describe('ZodValidationPipe through the assembled app', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ controllers: [ValidationController] });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('validates, coerces and strips a properly declared body', async () => {
    const response = await harness.get(
      '/__validation/typed',
      post({ name: 'valve', count: '3', sneaked: 'in' }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'valve', count: 3 });
  });

  it('still answers VALIDATION_FAILED with field details for a bad body', async () => {
    const response = await harness.get(
      '/__validation/typed',
      post({ name: 'no', count: -1 }),
    );
    const body = (await response.json()) as IamErrorResponse;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe(IamErrorCode.VALIDATION_FAILED);
    expect(body.error.details?.map((detail) => detail.field)).toEqual([
      'name',
      'count',
    ]);
  });

  it.each([
    ['interface', 'a body typed by an interface'],
    ['aliased', 'a body typed by a `z.infer` alias'],
    ['array', 'a bulk body typed as an array'],
  ])('refuses %s at request time — %s', async (route) => {
    const response = await harness.get(
      `/__validation/${route}`,
      // A body that would have sailed straight through to the handler before,
      // extra key and all.
      post({ name: 'valve', count: 3, is_platform_admin: true }),
    );
    const body = (await response.json()) as IamErrorResponse;

    // Not a 200. The route is broken until its author declares a DTO, which is
    // the point: the symptom of the mistake used to be a route that worked.
    expect(response.status).toBe(500);
    expect(body.error.code).toBe(IamErrorCode.INTERNAL_ERROR);
    // And the developer-facing text stays out of the response, like every other
    // 500 (`http-exception.filter.ts`). It is in the log, with the request id.
    expect(body.error.message).not.toMatch(/zod|createZodDto/);
  });
});
