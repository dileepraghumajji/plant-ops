/**
 * The transaction-local RLS context (Doc 07 §5).
 *
 * ## The rule this file exists to enforce
 *
 * `app.current_client_id`, `app.current_user_id` and `app.is_platform_admin`
 * are sourced **only** from verified JWT claims. Never from a request body,
 * header, query parameter, path segment, or any other client-supplied field
 * (Doc 07 §5 PROVENANCE, Invariant I0/I5).
 *
 * RLS is the last line of defence, and it trusts these three settings totally.
 * One interceptor that sets the tenant from `req.body.clientId` or an
 * `X-Client-Id` header collapses isolation across the whole system — and the
 * database will then enforce the *wrong* tenant faithfully and silently.
 *
 * ## How it is enforced rather than requested
 *
 * {@link applyRlsContext} accepts one argument: a {@link VerifiedClaims}. That
 * type carries a brand keyed on a module-private symbol, so a plain object —
 * `req.body`, a hand-built literal, a parsed header — is not assignable to it
 * and the call does not compile. The only way to obtain one is
 * {@link markClaimsVerified}, which the AuthGuard calls after signature and
 * revocation checks pass (Session 8).
 *
 * Note what the signature does *not* offer: there is no `clientId` parameter,
 * and no `isPlatformAdmin` parameter. The tenant comes from `cid`; the platform
 * flag is **derived** from the subject's binding at the platform scope root
 * (Doc 04 §10), never passed in — so no caller can assert it.
 *
 * A lint gate (`eslint.config.mjs`) backs this up by refusing direct
 * `set_config('app.…')` calls anywhere outside this file, so the type brand
 * cannot simply be sidestepped with raw SQL.
 */

import type { EntityManager, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from './schema.js';
import { PLATFORM_CLIENT_SLUG } from './migrations/0011-bootstrap-seed.js';

/**
 * Module-private brand. Not exported, so no code outside this file can name it,
 * and therefore no object literal elsewhere can satisfy {@link VerifiedClaims}.
 */
declare const VERIFIED: unique symbol;

/**
 * JWT claims that have actually been verified — signature, expiry (with the
 * shared 60 s leeway) and revocation.
 *
 * Structurally unforgeable: the brand cannot be written by any other module.
 */
export interface VerifiedClaims {
  readonly [VERIFIED]: true;
  /** `cid` — the tenant. The only trustworthy source of tenant (Doc 07 §5). */
  readonly cid: string;
  /** `sub` — user id or service-account id. */
  readonly sub: string;
  /** `sty` — subject type. */
  readonly sty: 'user' | 'service';
  /** `sid` — session id, for revocation. */
  readonly sid: string;
}

/** The shape a verifier hands over, before branding. */
export type UnverifiedClaimsInput = Omit<VerifiedClaims, typeof VERIFIED>;

/**
 * Brands claims as verified.
 *
 * **Call this from exactly one place** — `AuthGuard`, after the signature,
 * expiry and revocation checks have all passed (Doc 03 §6). Calling it anywhere
 * else re-opens the hole this module closes; the lint gate flags it.
 */
export function markClaimsVerified(claims: UnverifiedClaimsInput): VerifiedClaims {
  return claims as VerifiedClaims;
}

/** The three settings, named once so nothing else has to spell them. */
export const RLS_SETTINGS = {
  CLIENT_ID: 'app.current_client_id',
  USER_ID: 'app.current_user_id',
  IS_PLATFORM_ADMIN: 'app.is_platform_admin',
} as const;

/** A `QueryRunner` or `EntityManager` — whichever the caller's txn is on. */
type Executor = Pick<EntityManager, 'query'> | Pick<QueryRunner, 'query'>;

/**
 * Is this subject bound at the platform scope root (Doc 04 §10)?
 *
 * Derived, never asserted. Platform authority is a binding in the platform
 * tenant — exactly like every other grant in the system — so revoking it is an
 * ordinary unbind rather than a special case.
 */
async function derivePlatformAdmin(
  executor: Executor,
  subjectId: string,
  subjectType: VerifiedClaims['sty'],
): Promise<boolean> {
  const subjectColumn = subjectType === 'user' ? 'user_id' : 'service_account_id';
  const rows = (await executor.query(
    `select exists (
       select 1
         from "${IAM_SCHEMA}"."role_binding" rb
         join "${IAM_SCHEMA}"."client" c on c.id = rb.client_id
        where c.slug = $1
          and rb.${subjectColumn} = $2
          and (rb.expires_at is null or rb.expires_at > now())
     ) as is_platform_admin`,
    [PLATFORM_CLIENT_SLUG, subjectId],
  )) as { is_platform_admin: boolean }[];

  return rows[0]?.is_platform_admin ?? false;
}

/**
 * Applies the RLS context for the current transaction.
 *
 * **Must run inside a transaction.** The third argument to `set_config` is
 * `true` — transaction-local — which is what keeps the context from leaking
 * between requests that share a pooled connection (Doc 07 §5). Outside a
 * transaction the setting would apply to the whole session and be handed to
 * whoever gets that connection next.
 *
 * ## Ordering: tenant first, then derive, then the flag
 *
 * The platform lookup runs **after** `app.current_client_id` is set and before
 * `app.is_platform_admin`, and the order is not cosmetic. The app role is
 * subject to RLS on `role_binding` and `client` (Doc 07 §5.1), whose policies
 * read `is_platform_admin or <tenant> = app.current_client_id`. Run the lookup
 * with no context and both arms are false, so it returns zero rows and every
 * subject — including the seeded platform identity — is derived as *not* a
 * platform admin. Measured on PostgreSQL 17 as `plantops_app`: false with no
 * context, true with the tenant set. See finding 18 in
 * `docs/CHANGELOG-validation-fixes.md`.
 *
 * Setting the tenant first also narrows the check rather than widening it: the
 * lookup now only sees bindings inside the caller's own tenant, so platform
 * authority requires a token whose `cid` *is* the platform client **and** a
 * binding at the platform root under that subject. Setting the flag last
 * matters for the same reason in reverse — were it set first, the policy's
 * `is_platform_admin` arm would make the lookup's own read unconditional.
 *
 * It is a single indexed existence check on the hot path; Session 21 caches
 * the result alongside grants.
 */
export async function applyRlsContext(
  executor: Executor,
  claims: VerifiedClaims,
): Promise<void> {
  await executor.query(`select set_config($1, $2, true)`, [
    RLS_SETTINGS.CLIENT_ID,
    claims.cid,
  ]);
  // A service account has no user id; the audit writer distinguishes the two by
  // this being null (Doc 07 §6), so it must be empty rather than the subject id.
  await executor.query(`select set_config($1, $2, true)`, [
    RLS_SETTINGS.USER_ID,
    claims.sty === 'user' ? claims.sub : '',
  ]);

  const isPlatformAdmin = await derivePlatformAdmin(executor, claims.sub, claims.sty);

  await executor.query(`select set_config($1, $2, true)`, [
    RLS_SETTINGS.IS_PLATFORM_ADMIN,
    isPlatformAdmin ? 'true' : 'false',
  ]);
}
