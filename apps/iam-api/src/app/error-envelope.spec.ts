/**
 * The Doc 06 §2 acceptance criteria, asserted over real HTTP against the real
 * `AppModule`.
 *
 * "Every error response is `{ error: { code, message, requestId } }`" is a
 * claim about the assembled application, not about the filter class, so this
 * suite goes through the socket. The cases chosen are the ones where an
 * envelope is easiest to lose: a 404 raised by the router before any handler
 * exists, a 500 thrown from deep inside a handler, and a validation failure
 * produced by a pipe that runs after the filter is already on the stack.
 */

import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { NoPermissionRequired, Public } from '@plantops/auth-kit';
import {
  IamErrorCode,
  type IamErrorResponse,
  isIamErrorResponse,
} from '@plantops/contracts';
import { QueryFailedError } from 'typeorm';
import { z } from 'zod';
import { IamException } from '../common/iam.exception';
import { REQUEST_ID_HEADER } from '../common/request-id.middleware';
import { createZodDto } from '../common/validation.pipe';
import { type Harness, createHarness } from '../testing/app-harness';

const createWidgetSchema = z.object({
  name: z.string().min(3, 'name must be at least 3 characters'),
  count: z.coerce.number().int().positive(),
  nested: z.object({ tag: z.string() }).optional(),
});

class CreateWidgetDto extends createZodDto(createWidgetSchema) {}

/**
 * One route per failure mode the real surface cannot produce yet.
 *
 * `@Public()` because these are about the *filter*, not about the guard: with
 * authentication required they would all answer 401 and the envelope claims
 * would go untested. The guard's own behaviour is `auth.guard.spec.ts`.
 */
// A fixture controller for a spec about something else. The pipeline it
// runs through is the real one, so an ungated route still has to say so.
@NoPermissionRequired('test fixture')
@Controller('__test')
@Public()
class FailingController {
  @Get('boom')
  boom(): never {
    // The kind of thing a driver throws: a message quoting internal hosts.
    throw new Error('connection to db-primary.internal:5432 refused for user app');
  }

  @Get('duplicate')
  duplicate(): never {
    const error = new QueryFailedError(
      'insert into "iam"."client" ...',
      ['acme', 'secret-value'],
      new Error('duplicate key value violates unique constraint "client_slug_key"'),
    );
    (error as QueryFailedError & { code?: string }).code = '23505';
    throw error;
  }

  @Get('denied')
  denied(): never {
    throw IamException.scopeDenied();
  }

  @Post('widgets')
  @HttpCode(200)
  create(@Body() body: CreateWidgetDto): CreateWidgetDto {
    return body;
  }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('error envelope (Doc 06 §2)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ controllers: [FailingController] });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('answers an unknown route with NOT_FOUND in the envelope', async () => {
    const response = await harness.get('/no-such-route');
    const body = (await response.json()) as IamErrorResponse;

    expect(response.status).toBe(404);
    expect(isIamErrorResponse(body)).toBe(true);
    expect(body.error.code).toBe(IamErrorCode.NOT_FOUND);
  });

  it('maps a thrown IamException to its Doc 06 §2 status and code', async () => {
    const response = await harness.get('/__test/denied');
    const body = (await response.json()) as IamErrorResponse;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe(IamErrorCode.SCOPE_DENIED);
    // A denial must not hint at whether the target exists elsewhere.
    expect(body.error.message).not.toMatch(/exist|found|tenant|client/i);
  });

  it('reports an unanticipated failure as INTERNAL_ERROR without leaking its message', async () => {
    const response = await harness.get('/__test/boom');
    const body = (await response.json()) as IamErrorResponse;

    expect(response.status).toBe(500);
    expect(isIamErrorResponse(body)).toBe(true);
    expect(body.error.code).toBe(IamErrorCode.INTERNAL_ERROR);
    // The whole point of the fixed message: no host, no port, no role name.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('db-primary.internal');
    expect(serialised).not.toContain('user app');
  });

  it('turns a unique violation into 409 CONFLICT, without the constraint name', async () => {
    const response = await harness.get('/__test/duplicate');
    const body = (await response.json()) as IamErrorResponse;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe(IamErrorCode.CONFLICT);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('client_slug_key');
    // Bound parameters are the real hazard — they are hashes and secrets.
    expect(serialised).not.toContain('secret-value');
  });

  it('carries a request id on every error, and echoes a well-formed inbound one', async () => {
    const requestId = 'trace-abc-123';
    const response = await harness.get('/no-such-route', {
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
    const body = (await response.json()) as IamErrorResponse;

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(requestId);
    expect(body.error.requestId).toBe(requestId);
  });

  it('gives every request a distinct id when none is supplied', async () => {
    const [first, second] = (await Promise.all([
      harness.get('/no-such-route').then((r) => r.json()),
      harness.get('/no-such-route').then((r) => r.json()),
    ])) as IamErrorResponse[];

    expect(first.error.requestId).not.toBe(second.error.requestId);
  });
});

describe('validation (Doc 06 §2 — 400 VALIDATION_FAILED)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ controllers: [FailingController] });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('rejects a bad body with field-level details', async () => {
    const response = await fetch(
      `${harness.baseUrl}/__test/widgets`,
      json({ name: 'ab', count: -1 }),
    );
    const body = (await response.json()) as IamErrorResponse;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe(IamErrorCode.VALIDATION_FAILED);
    expect(body.error.details).toEqual(
      expect.arrayContaining([
        { field: 'name', message: 'name must be at least 3 characters' },
        expect.objectContaining({ field: 'count' }),
      ]),
    );
  });

  it('names a nested field by its path', async () => {
    const response = await fetch(
      `${harness.baseUrl}/__test/widgets`,
      json({ name: 'valid', count: 1, nested: { tag: 42 } }),
    );
    const body = (await response.json()) as IamErrorResponse;

    expect(body.error.details).toEqual([
      expect.objectContaining({ field: 'nested.tag' }),
    ]);
  });

  it('never echoes the rejected value back', async () => {
    const response = await fetch(
      `${harness.baseUrl}/__test/widgets`,
      json({ name: 'ab', count: 1, password: 'hunter2' }),
    );

    expect(JSON.stringify(await response.json())).not.toContain('hunter2');
  });

  it('strips unknown keys instead of passing them to the handler', async () => {
    const response = await fetch(
      `${harness.baseUrl}/__test/widgets`,
      // `isAdmin` is the mass-assignment case: a validator that only *checks*
      // would leave it on the object all the way into a repository.
      json({ name: 'valid', count: '3', isAdmin: true }),
    );

    expect(response.status).toBe(200);
    // `count` also proves the parsed output replaces the raw body: it arrived
    // as a string and reaches the handler as a number.
    expect(await response.json()).toEqual({ name: 'valid', count: 3 });
  });
});
