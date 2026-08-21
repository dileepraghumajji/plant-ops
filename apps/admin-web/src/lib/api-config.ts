/**
 * Where the IAM lives, from the browser's point of view.
 *
 * `NEXT_PUBLIC_` because this runs in a browser: the value is inlined into the
 * client bundle at build time and is not a secret — it is the same URL anyone
 * can read out of the network tab. Nothing else about the IAM is configured
 * here; the console learns its menu, its permissions and its error codes from
 * the API rather than from its own environment.
 *
 * ## Why the default is a path and not an origin
 *
 * Build-time substitution is the whole problem (Doc 11 §8, gap 2): a value
 * baked into the bundle binds that bundle to one hostname, so a second customer
 * needs a second build — which is a per-customer fork by another name, and Doc
 * 11 §3 allows exactly one image set. The way out is to bake in something that
 * is true everywhere. A *relative* base is: `/api` resolves against whatever
 * origin served the page, so the same bytes work on `localhost`, on a dedicated
 * instance, and inside a client's network, and the only thing that has to be
 * per-deployment is the proxy in front — which is configuration, not a build.
 *
 * It costs nothing at the transport either. `HttpTransport` composes a request
 * URL as `baseUrl + path` (`libs/iam-client/src/http.ts`), so `/api` +
 * `/auth/login` is `/api/auth/login` — a same-origin request the browser sends
 * without a preflight and without any `CORS_ALLOWED_ORIGINS` entry. That single
 * concatenation is the line this whole arrangement rests on, so
 * `specs/api-config.spec.ts` asserts it rather than trusting it.
 *
 * Setting `NEXT_PUBLIC_IAM_API_URL` to an absolute origin still does what it
 * always did, and the local dev flow is unchanged: `apps/admin-web/.env.local`
 * names `http://localhost:3000` because the console's dev server holds 4200 and
 * nothing proxies between them.
 */

/**
 * Same-origin, under `/api`. Deliberately a path with no host.
 *
 * The prefix is stripped by the proxy before the request reaches the API, which
 * is why it is absent from every route in Doc 06 §1 — the API still serves
 * `/iam`, `/auth`, `/health` and `/ready` at its root with no global prefix.
 */
const DEFAULT_API_URL = '/api';

/**
 * The configured base, or the same-origin default.
 *
 * Blank counts as unset. An empty environment variable is what an unfilled
 * template produces — a `.env` line copied but never edited — and treating it
 * as "the origin root" would send `/auth/login` to the console's own Next
 * server, where it 404s with nothing to say about why. The default is the
 * answer that is right far more often than it is wrong.
 *
 * Exported as a function so it can be tested for what it does with an absent
 * value: the constant below is fixed the moment this module is first imported,
 * and under `next/jest` that import already sees `.env.local`.
 */
export function resolveApiBase(configured: string | undefined): string {
  const trimmed = configured?.trim() ?? '';
  return trimmed === '' ? DEFAULT_API_URL : trimmed;
}

/**
 * Read once, at module scope.
 *
 * `process.env.NEXT_PUBLIC_*` is a *substitution*, not a lookup: Next replaces
 * the whole expression at build time. It has to be written out literally —
 * `process.env[name]` with a computed key would survive into the bundle and
 * evaluate to `undefined` in a browser.
 */
export const IAM_API_URL: string = resolveApiBase(
  process.env.NEXT_PUBLIC_IAM_API_URL,
);

/**
 * How a base renders in the footer, which exists so a tester always knows which
 * API they are on.
 *
 * An absolute base loses its scheme, as it always has — `iam.plantops.example`
 * says more per pixel than `https://iam.plantops.example`. A relative base has
 * no scheme and no host to strip, and running the old regex over it would print
 * a bare `/api`, which answers a question nobody asked: the interesting fact is
 * that the API is wherever this page came from. So it is named as such.
 */
export function apiLabelFor(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');

  // `scheme://host` and the protocol-relative `//host` are both "somewhere
  // else, named": strip the part the reader does not need.
  const absolute = /^([a-z][a-z0-9+.-]*:)?\/\//i;
  if (absolute.test(base)) return base.replace(absolute, '');

  return base === '' ? 'same origin' : `same origin ${base}`;
}

/** Shown in the sidebar footer so a tester always knows which API they are on. */
export const IAM_API_LABEL: string = apiLabelFor(IAM_API_URL);
