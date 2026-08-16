/**
 * JSON body parsing, with a stated ceiling and an envelope on failure
 * (Doc 06 §1–2).
 *
 * ## Why the parser is Nest middleware and not `NestFactory`'s own
 *
 * Nest registers `body-parser` on the Express instance *before* its router, so
 * a body that exceeds the limit fails outside Nest entirely: `body-parser`
 * calls `next(err)`, no filter is on the stack, and Express answers with its
 * default HTML error page. The same is true of malformed JSON. Both are the
 * one thing `http-exception.filter.ts` exists to prevent — a response no
 * consumer's `isIamErrorResponse` can read.
 *
 * Middleware applied through `MiddlewareConsumer` is different: Nest wraps it
 * in `RouterProxy`, which awaits it and hands a rejection to the exceptions
 * handler. So the parser is registered here, awaited, and its `next(err)`
 * convention converted into a thrown {@link IamException} — which then takes
 * the ordinary filter path and comes back in the envelope with a `requestId`.
 *
 * This is why `app/http-hardening.ts` boots the application with
 * `bodyParser: false`: with Nest's own parser left on, it would run first, its
 * 100 kB default would win, and both middlewares below would be no-ops
 * (`body-parser` skips a request another instance already parsed).
 *
 * ## Why an oversized body is a 400 and not a 413
 *
 * Doc 06 §2's code table is closed — `iam-client`, admin-web and every future
 * module branch on it, so adding `PAYLOAD_TOO_LARGE` is a spec change rather
 * than an implementation detail. `VALIDATION_FAILED` is the honest existing
 * fit: the request was refused for the shape of what it sent, before any
 * handler saw it. The message carries the actual byte ceiling, so a caller can
 * act on it without a new code to branch on.
 *
 * ## Three ceilings
 *
 * Two routes carry a *document* rather than a form, and each gets its own,
 * larger limit; everything else gets the tight one.
 *
 * - The manifest upload carries an application's entire permission and nav
 *   catalogue (Doc 02 §2).
 * - The bulk user upload carries a tenant's staff list (Doc 06 §8) — up to
 *   `MAX_BULK_USER_ROWS` rows, as CSV text or as a JSON array.
 *
 * All three come from the environment (`REQUEST_BODY_LIMIT_BYTES`,
 * `MANIFEST_BODY_LIMIT_BYTES`, `BULK_UPLOAD_BODY_LIMIT_BYTES`) and all three are
 * published in Doc 06 §1. Each exemption is validated in `env.schema.ts` to be
 * at least the global one: a route that silently refuses bodies every other
 * route accepts is the least guessable failure this arrangement can produce.
 */

import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import { IAM_ROUTE_PREFIX, IamErrorCode } from '@plantops/contracts';
import { type NextFunction, type Request, type Response, json } from 'express';
import { ENV } from '../config/config.module';
import { IamException } from './iam.exception';

/**
 * The route the larger ceiling applies to.
 *
 * Kept here rather than in `applications.controller.ts` because it is the
 * middleware's route table, not the controller's: `AppModule` needs it to
 * decide which of the two middlewares below runs, and the controller needs
 * only its own path segment. `http-hardening.spec.ts` asserts the two still
 * describe the same route.
 */
export const MANIFEST_ROUTE_PATH = `${IAM_ROUTE_PREFIX}/applications/:id/manifest`;

/**
 * The bulk user upload's route, for the same reason (Doc 06 §8).
 *
 * A literal path rather than a parameterised one, and it has to stay above
 * `/iam/users/:id` in the *controller* for Nest's router to reach it — but this
 * table is the middleware's, and `MiddlewareConsumer` matches the string it is
 * given rather than the router's ordering. `http-hardening.spec.ts` asserts the
 * two still describe the same route.
 */
export const BULK_USER_UPLOAD_ROUTE_PATH = `${IAM_ROUTE_PREFIX}/users/bulk`;

/**
 * `body-parser`'s error taxonomy, as far as this file cares.
 *
 * Every entry is a *caller* fault, which is what separates them from the
 * default branch: an unrecognised failure is a server fault and is rethrown so
 * the filter reports it as `INTERNAL_ERROR` with its stack logged.
 */
const CALLER_FAULTS: Readonly<Record<string, (limit: number) => string>> =
  Object.freeze({
    'entity.too.large': (limit) =>
      `The request body exceeds the ${limit} byte limit for this route`,
    'entity.parse.failed': () => 'The request body is not valid JSON',
    'encoding.unsupported': () => 'The request body uses an unsupported encoding',
    'charset.unsupported': () => 'The request body uses an unsupported charset',
    'request.aborted': () => 'The request body was not fully received',
  });

/** What `body-parser` attaches to the errors it reports. */
interface BodyParserError {
  type?: string;
}

/**
 * A `body-parser` JSON middleware, awaited and re-thrown into the filter.
 *
 * The parser instance is built once in the constructor — it compiles its own
 * limit and content-type matcher, and rebuilding it per request would do that
 * work on every call for no gain.
 */
abstract class JsonBodyParser implements NestMiddleware {
  private readonly parse: ReturnType<typeof json>;

  protected constructor(private readonly limitBytes: number) {
    this.parse = json({ limit: limitBytes });
  }

  async use(
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    assertUnparsed(request);
    try {
      await new Promise<void>((resolve, reject) => {
        this.parse(request, response, (error?: unknown) =>
          error ? reject(error) : resolve(),
        );
      });
    } catch (error) {
      throw this.translate(error);
    }
    next();
  }

  /**
   * `body-parser`'s error → an {@link IamException}, or the error untouched.
   *
   * Untouched is the important half: a failure this table does not name is not
   * something the caller did, and reporting it as `VALIDATION_FAILED` would
   * blame them for a server fault *and* lose the stack the filter would
   * otherwise log.
   */
  private translate(error: unknown): unknown {
    const type = (error as BodyParserError | null)?.type;
    const message = type === undefined ? undefined : CALLER_FAULTS[type];
    if (message === undefined) return error;

    return new IamException(
      IamErrorCode.VALIDATION_FAILED,
      message(this.limitBytes),
    );
  }
}

/**
 * Refuses to run at all if something already drained the request stream.
 *
 * That something can only be Nest's built-in parser, which means the
 * application was booted without `NEST_APP_OPTIONS` — and the consequence is
 * silent: the built-in parser's 100 kB default becomes the real ceiling, both
 * middlewares here become no-ops, and the limits published in Doc 06 §1 stop
 * being true. Left to itself the symptom is `raw-body`'s "stream is not
 * readable" reported as an `INTERNAL_ERROR`, which names neither the cause nor
 * the fix; this names both.
 *
 * The check is a plain `Error` for the same reason `validation.pipe.ts`'s is:
 * the caller did nothing wrong, so there is no envelope code that fits, and the
 * filter's 500 path logs the message with the request id without returning it.
 */
function assertUnparsed(request: Request): void {
  const declaresBody =
    request.headers['content-length'] !== undefined ||
    request.headers['transfer-encoding'] !== undefined;
  if (!declaresBody || request.readable) return;

  throw new Error(
    'The request body was already consumed before this middleware ran, which ' +
      'means the application was created without `NEST_APP_OPTIONS` and Nest ' +
      "registered its own body parser ahead of it. The published limits are not " +
      'in force. See app/http-hardening.ts.',
  );
}

/** The ceiling every route but the manifest upload gets. */
@Injectable()
export class JsonBodyMiddleware extends JsonBodyParser {
  constructor(@Inject(ENV) env: EnvConfig) {
    super(env.REQUEST_BODY_LIMIT_BYTES);
  }
}

/** The manifest upload's larger ceiling — see the header. */
@Injectable()
export class ManifestBodyMiddleware extends JsonBodyParser {
  constructor(@Inject(ENV) env: EnvConfig) {
    super(env.MANIFEST_BODY_LIMIT_BYTES);
  }
}

/** The bulk user upload's larger ceiling — see the header. */
@Injectable()
export class BulkUploadBodyMiddleware extends JsonBodyParser {
  constructor(@Inject(ENV) env: EnvConfig) {
    super(env.BULK_UPLOAD_BODY_LIMIT_BYTES);
  }
}
