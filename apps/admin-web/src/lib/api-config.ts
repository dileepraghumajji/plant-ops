/**
 * Where the IAM lives, from the browser's point of view.
 *
 * `NEXT_PUBLIC_` because this runs in a browser: the value is inlined into the
 * client bundle at build time and is not a secret — it is the same URL anyone
 * can read out of the network tab. Nothing else about the IAM is configured
 * here; the console learns its menu, its permissions and its error codes from
 * the API rather than from its own environment.
 *
 * The default is the local API's port from `.env.example` (`PORT=3000`), which
 * also explains why this console's dev server runs on 4200 — the two would
 * otherwise fight for the same port, and `CORS_ALLOWED_ORIGINS` already names
 * `http://localhost:4200`.
 */

const DEFAULT_API_URL = 'http://localhost:3000';

/**
 * Read once, at module scope.
 *
 * `process.env.NEXT_PUBLIC_*` is a *substitution*, not a lookup: Next replaces
 * the whole expression at build time. It has to be written out literally —
 * `process.env[name]` with a computed key would survive into the bundle and
 * evaluate to `undefined` in a browser.
 */
export const IAM_API_URL: string =
  process.env.NEXT_PUBLIC_IAM_API_URL ?? DEFAULT_API_URL;

/** Shown in the sidebar footer so a tester always knows which API they are on. */
export const IAM_API_LABEL: string = IAM_API_URL.replace(/^https?:\/\//, '');
