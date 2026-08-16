/**
 * The Express-level settings every boot of this application must share.
 *
 * `AppModule` carries the pipeline (guards, pipe, interceptor, filter,
 * middleware) precisely so that a test which builds the module gets the real
 * one. Two things cannot live there, because they are properties of the Express
 * instance rather than of the Nest module:
 *
 * - **`bodyParser: false`.** Body parsing is registered as Nest middleware
 *   instead (`common/body-parser.middleware.ts`), so an oversized or malformed
 *   body reaches `HttpExceptionFilter` rather than Express's HTML error page.
 *   Leaving Nest's own parser on would put it *ahead* of that middleware, and
 *   its 100 kB default would silently become the real limit.
 * - **`x-powered-by`.** Express sets it in its own `init` handler, before any
 *   middleware runs, and switching it off is a setting rather than a header
 *   edit.
 *
 * So they live here, in one function two entry points call — `main.ts` and
 * `testing/app-harness.ts`. That is what makes the assertions in
 * `http-hardening.spec.ts` statements about production rather than about a
 * replica of it.
 */

import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Options every `NestFactory.create` / `createNestApplication` call must pass.
 *
 * Spread it rather than copying `bodyParser: false` — the constraint it
 * encodes is not obvious at the call site, and a copy is a copy that drifts.
 */
export const NEST_APP_OPTIONS: NestApplicationOptions = Object.freeze({
  bodyParser: false,
});

/** `X-Content-Type-Options` — the one blanket header a JSON API earns. */
export const CONTENT_TYPE_OPTIONS_HEADER = 'X-Content-Type-Options';

export function hardenExpress(app: NestExpressApplication): void {
  // Version-fingerprints the stack for anyone scanning, and buys nothing.
  app.disable('x-powered-by');

  // `nosniff` rather than `helmet`. Helmet's value is almost entirely in
  // headers that govern how a *document* is rendered — CSP, frame-ancestors,
  // referrer policy — and this API returns no documents. `nosniff` is the one
  // that still applies: it stops a browser from content-sniffing a JSON
  // response into something it will execute, which is the shape of the attack
  // where an error body echoing caller-supplied text becomes script.
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader(CONTENT_TYPE_OPTIONS_HEADER, 'nosniff');
    next();
  });
}
