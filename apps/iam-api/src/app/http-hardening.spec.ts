/**
 * HTTP hardening, asserted over real HTTP against the real `AppModule`.
 *
 * Three claims, and each one is only worth making about the assembled
 * application:
 *
 * - **Body ceilings are enforced, and a refusal still comes back in the
 *   envelope.** Before this, `body-parser` reported an oversized or malformed
 *   body by calling `next(err)` outside Nest, and Express answered with its
 *   default HTML page — a response `isIamErrorResponse` rejects. Asserting the
 *   envelope here is what proves the parser sits *inside* the filter's reach.
 * - **The manifest and bulk-upload routes have larger ceilings than everything
 *   else**, and all three numbers come from the environment.
 * - **`x-powered-by` is gone and `nosniff` is present** on every response,
 *   including the ones no handler produces.
 *
 * The limits are overridden to small numbers rather than exercised at their
 * shipped values: a 4 MB request would make the suite measure the loopback
 * interface, and overriding them also proves the environment variables are
 * actually wired to the parsers. The shipped defaults get their own assertion
 * against the constants Doc 06 §1 publishes.
 */

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { NoPermissionRequired, Public } from '@plantops/auth-kit';
import {
  DEFAULT_BULK_UPLOAD_BODY_LIMIT_BYTES,
  DEFAULT_MANIFEST_BODY_LIMIT_BYTES,
  DEFAULT_REQUEST_BODY_LIMIT_BYTES,
} from '@plantops/config';
import {
  IAM_ROUTE_PREFIX,
  IamErrorCode,
  type IamErrorResponse,
  isIamErrorResponse,
} from '@plantops/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BULK_USER_UPLOAD_ROUTE_PATH,
  MANIFEST_ROUTE_PATH,
} from '../common/body-parser.middleware';
import { createZodDto } from '../common/validation.pipe';
import { type Harness, createHarness, testEnv } from '../testing/app-harness';
import { CONTENT_TYPE_OPTIONS_HEADER } from './http-hardening';

/** Small enough to keep the suite fast, distinct enough to tell apart. */
const GLOBAL_LIMIT = 2_048;
const MANIFEST_LIMIT = 16_384;
const BULK_UPLOAD_LIMIT = 8_192;

class EchoDto extends createZodDto(z.object({ padding: z.string() })) {}

// A fixture controller for a spec about something else. The pipeline it
// runs through is the real one, so an ungated route still has to say so.
@NoPermissionRequired('test fixture')
@Controller('__hardening')
@Public()
class EchoController {
  @Post('echo')
  @HttpCode(200)
  echo(@Body() body: EchoDto): { length: number } {
    return { length: body.padding.length };
  }
}

/** A JSON body of approximately `bytes` bytes. */
const padded = (bytes: number) => JSON.stringify({ padding: 'x'.repeat(bytes) });

const post = (harness: Harness, path: string, body: string, token?: string) =>
  fetch(`${harness.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body,
  });

describe('HTTP hardening (Doc 06 §1)', () => {
  let harness: Harness;
  /** The real route the larger ceiling is attached to, with a concrete id. */
  let manifestPath: string;

  beforeAll(async () => {
    harness = await createHarness({
      controllers: [EchoController],
      env: testEnv({
        REQUEST_BODY_LIMIT_BYTES: String(GLOBAL_LIMIT),
        MANIFEST_BODY_LIMIT_BYTES: String(MANIFEST_LIMIT),
        BULK_UPLOAD_BODY_LIMIT_BYTES: String(BULK_UPLOAD_LIMIT),
      }),
    });
    manifestPath = MANIFEST_ROUTE_PATH.replace(':id', randomUUID());
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('body ceiling', () => {
    it('accepts a body under the limit', async () => {
      const response = await post(harness, '/__hardening/echo', padded(512));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ length: 512 });
    });

    it('refuses a body over the limit in the envelope, not as an HTML page', async () => {
      const response = await post(
        harness,
        '/__hardening/echo',
        padded(GLOBAL_LIMIT * 2),
      );
      const body = (await response.json()) as IamErrorResponse;

      expect(response.status).toBe(400);
      // The envelope — and a `requestId` in particular — is only there if the
      // refusal travelled through `HttpExceptionFilter`.
      expect(isIamErrorResponse(body)).toBe(true);
      expect(body.error.code).toBe(IamErrorCode.VALIDATION_FAILED);
      expect(body.error.requestId).toEqual(expect.any(String));
      // The caller cannot act on "too large" without the number.
      expect(body.error.message).toContain(String(GLOBAL_LIMIT));
    });

    it('refuses malformed JSON in the envelope too', async () => {
      const response = await post(harness, '/__hardening/echo', '{"padding":');
      const body = (await response.json()) as IamErrorResponse;

      expect(response.status).toBe(400);
      expect(isIamErrorResponse(body)).toBe(true);
      expect(body.error.code).toBe(IamErrorCode.VALIDATION_FAILED);
      // Never the parser's own text: it quotes the fragment it choked on, which
      // is caller-supplied and may be a password (`http-exception.filter.ts`).
      expect(body.error.message).toBe('The request body is not valid JSON');
    });
  });

  describe('the manifest exemption', () => {
    it('accepts a manifest body far larger than the global ceiling', async () => {
      const { accessToken } = harness.tokenFor();
      const response = await post(
        harness,
        manifestPath,
        padded(GLOBAL_LIMIT * 4),
        accessToken,
      );
      const body = (await response.json()) as IamErrorResponse;

      // The body is nonsense as a manifest, so this route still refuses it —
      // the claim under test is *which* refusal. Reaching the schema at all
      // means the larger ceiling let it through the parser.
      expect(body.error.message).not.toContain('byte limit');
      expect(response.status).not.toBe(413);
    });

    it('still has a ceiling of its own', async () => {
      const { accessToken } = harness.tokenFor();
      const response = await post(
        harness,
        manifestPath,
        padded(MANIFEST_LIMIT * 2),
        accessToken,
      );
      const body = (await response.json()) as IamErrorResponse;

      expect(response.status).toBe(400);
      expect(body.error.code).toBe(IamErrorCode.VALIDATION_FAILED);
      expect(body.error.message).toContain(String(MANIFEST_LIMIT));
    });

    it('exempts the manifest route only', async () => {
      const { accessToken } = harness.tokenFor();
      const otherRegistryRoute = `${IAM_ROUTE_PREFIX}/applications`;
      const response = await post(
        harness,
        otherRegistryRoute,
        padded(GLOBAL_LIMIT * 4),
        accessToken,
      );
      const body = (await response.json()) as IamErrorResponse;

      expect(response.status).toBe(400);
      expect(body.error.message).toContain(String(GLOBAL_LIMIT));
    });
  });

  describe('the bulk-upload exemption', () => {
    it('accepts an upload larger than the global ceiling', async () => {
      const { accessToken } = harness.tokenFor();
      const response = await post(
        harness,
        BULK_USER_UPLOAD_ROUTE_PATH,
        padded(GLOBAL_LIMIT * 2),
        accessToken,
      );
      const body = (await response.json()) as IamErrorResponse;

      // The body is nonsense as an upload, so this route still refuses it — the
      // claim under test is *which* refusal. Reaching the schema at all means
      // the larger ceiling let it through the parser.
      expect(body.error.message).not.toContain('byte limit');
    });

    it('still has a ceiling of its own', async () => {
      const { accessToken } = harness.tokenFor();
      const response = await post(
        harness,
        BULK_USER_UPLOAD_ROUTE_PATH,
        padded(BULK_UPLOAD_LIMIT * 2),
        accessToken,
      );
      const body = (await response.json()) as IamErrorResponse;

      expect(response.status).toBe(400);
      expect(body.error.code).toBe(IamErrorCode.VALIDATION_FAILED);
      expect(body.error.message).toContain(String(BULK_UPLOAD_LIMIT));
    });

    it('exempts the bulk route only, not the rest of /iam/users', async () => {
      const { accessToken } = harness.tokenFor();
      const response = await post(
        harness,
        `${IAM_ROUTE_PREFIX}/users`,
        padded(GLOBAL_LIMIT * 2),
        accessToken,
      );
      const body = (await response.json()) as IamErrorResponse;

      expect(response.status).toBe(400);
      expect(body.error.message).toContain(String(GLOBAL_LIMIT));
    });
  });

  describe('response headers', () => {
    /**
     * A handled success, a router 404 and a filtered error — the three ways a
     * response leaves this application. `x-powered-by` is set by Express before
     * any of this codebase runs, so a check on one of them proves nothing about
     * the others.
     */
    const everyKindOfResponse = async (): Promise<Response[]> => [
      await post(harness, '/__hardening/echo', padded(8)),
      await harness.get('/no-such-route'),
      await post(harness, '/__hardening/echo', '{'),
    ];

    it('never advertises the server', async () => {
      for (const response of await everyKindOfResponse()) {
        expect(response.headers.get('x-powered-by')).toBeNull();
      }
    });

    it('sends nosniff on every response', async () => {
      for (const response of await everyKindOfResponse()) {
        expect(response.headers.get(CONTENT_TYPE_OPTIONS_HEADER)).toBe('nosniff');
      }
    });
  });
});

describe('the shipped ceilings (Doc 06 §1)', () => {
  /**
   * The numbers Doc 06 §1 publishes. An external team plans an upload against
   * the documented figure, so a change to either default is a documentation
   * change — this is what makes that true rather than hoped for.
   */
  it('are the documented defaults', () => {
    expect(DEFAULT_REQUEST_BODY_LIMIT_BYTES).toBe(65_536);
    expect(DEFAULT_MANIFEST_BODY_LIMIT_BYTES).toBe(4_194_304);
    expect(DEFAULT_BULK_UPLOAD_BODY_LIMIT_BYTES).toBe(1_048_576);
  });

  it('leaves the bulk ceiling above the largest schema-valid upload', () => {
    // `MAX_BULK_USER_ROWS` caps an upload at 500 rows, and every field in a row
    // is separately bounded — roughly 300 kB at every maximum at once, or about
    // twice that once a CSV's line breaks are JSON-escaped. Below that number, a
    // size refusal would pre-empt the row-count error that names the problem.
    expect(DEFAULT_BULK_UPLOAD_BODY_LIMIT_BYTES).toBeGreaterThan(600_000);
  });

  it('leaves the manifest ceiling above the largest schema-valid manifest', () => {
    // `manifest.dto.ts` caps a document at 200 permissions and 200 nav nodes,
    // each node with up to 50 `requires` keys of 160 characters — about 2.1 MB
    // in total. Below that number, a size refusal would pre-empt the field-level
    // error an operator actually needs.
    expect(DEFAULT_MANIFEST_BODY_LIMIT_BYTES).toBeGreaterThan(2_200_000);
  });
});
