/**
 * Where to send someone after they sign in — and the check that keeps that from
 * being an open redirect.
 *
 * A deep link has to survive a sign-in, or a link to `/admin/users/8f2c…` is
 * only useful to someone already signed in. The mechanism is a `?next=` on the
 * login URL, and the mechanism's hazard is that the value is attacker-supplied:
 * a login page that redirects wherever it is told is a phishing page one hop
 * from a real, correct sign-in — and the hop happens *after* the user typed
 * their password, which is the worst possible moment to hand control away.
 *
 * So only a path on this origin is accepted. Two forms have to be refused, and
 * the second is the one that gets missed: an absolute URL (`https://evil.test`)
 * is obvious, and a protocol-relative one (`//evil.test`) starts with `/` and
 * looks internal to a naive check while the browser treats it as another
 * origin. A backslash is refused with them, because browsers have historically
 * normalised `\` to `/` in URLs.
 *
 * Kept apart from `auth-context.tsx` so it can be tested without a router, a
 * provider or a DOM — which is what makes the hostile cases below cheap enough
 * to enumerate properly.
 */

/** Where an unauthenticated visitor is sent. */
export const LOGIN_PATH = '/login';

/** The query parameter carrying where the user was going. */
export const RETURN_TO_PARAM = 'next';

/** True for a path this console may redirect to. */
export function isInternalPath(target: string): boolean {
  return (
    target.startsWith('/') &&
    !target.startsWith('//') &&
    !target.startsWith('/\\') &&
    !target.includes('\\')
  );
}

/** The login URL for a target, dropping anything that is not an internal path. */
export function loginUrlFor(target: string | null): string {
  if (target === null || !isInternalPath(target)) return LOGIN_PATH;
  return `${LOGIN_PATH}?${RETURN_TO_PARAM}=${encodeURIComponent(target)}`;
}

/** Sanitises a `?next=` value into somewhere safe to land. */
export function safeReturnTo(target: string | null, fallback = '/'): string {
  return target !== null && isInternalPath(target) ? target : fallback;
}
