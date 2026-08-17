/**
 * The placeholder authenticated route (roadmap Session 6).
 *
 * It exists to prove one thing that nothing else can prove until the feature
 * modules land: that the RLS context set by `TenantContextInterceptor`
 * actually reached the transaction the handler is running in. So it does not
 * report the claims it was given — that would only prove the interceptor read
 * them — it asks **Postgres** what `app.current_client_id` and
 * `app.is_platform_admin` are set to, inside the same transaction.
 *
 * That distinction is the whole value of the endpoint. An interceptor that
 * parses claims correctly and applies them to the wrong connection, or outside
 * a transaction, looks identical from the application side and is a complete
 * isolation failure at the database.
 *
 * Since Session 8 the claims are real: `AuthGuard` verifies a bearer token and
 * `RequestClaimsSink` brands it, so this route now reports what Postgres
 * believes about a genuinely authenticated caller. The fail-closed backstop
 * against a route that ever loses its guard is `@Claims()` itself, which throws
 * `AUTH_REQUIRED` rather than handing a handler no subject — this controller no
 * longer carries its own copy of that check.
 */

import { Controller, Get } from '@nestjs/common';
import { NoPermissionRequired } from '@plantops/auth-kit';
import { IAM_ROUTE_PREFIX } from '@plantops/contracts';
import { RLS_SETTINGS, type VerifiedClaims } from '@plantops/db';
import { Claims } from '../common/claims.decorator';
import { entityManager } from '../common/transaction-context';

/** What the *database* believes about the caller, not what the app assumed. */
export interface WhoAmIResponse {
  subjectId: string;
  subjectType: 'user' | 'service';
  sessionId: string;
  /** `app.current_client_id`, read back from the live transaction. */
  clientId: string | null;
  /** `app.current_user_id` — null for a service account, by design (Doc 07 §6). */
  userId: string | null;
  /** `app.is_platform_admin`, derived from bindings and never asserted. */
  isPlatformAdmin: boolean;
}

@Controller(IAM_ROUTE_PREFIX)
@NoPermissionRequired(
  'Reports the RLS context the caller\'s own token established. It reveals ' +
    'nothing a subject does not already know about themselves, and gating it ' +
    'would make the diagnostic unavailable to precisely the subject whose ' +
    'context is wrong.',
)
export class WhoAmIController {
  @Get('whoami')
  async whoami(@Claims() claims: VerifiedClaims): Promise<WhoAmIResponse> {
    // `current_setting(name, true)` — the second argument returns null for an
    // unset setting instead of raising, which is what makes the *absence* of a
    // context observable here rather than a 500.
    const [row] = (await entityManager().query(
      `select nullif(current_setting($1, true), '') as client_id,
              nullif(current_setting($2, true), '') as user_id,
              coalesce(current_setting($3, true), 'false') as is_platform_admin`,
      [RLS_SETTINGS.CLIENT_ID, RLS_SETTINGS.USER_ID, RLS_SETTINGS.IS_PLATFORM_ADMIN],
    )) as {
      client_id: string | null;
      user_id: string | null;
      is_platform_admin: string;
    }[];

    return {
      subjectId: claims.sub,
      subjectType: claims.sty,
      sessionId: claims.sid,
      clientId: row?.client_id ?? null,
      userId: row?.user_id ?? null,
      isPlatformAdmin: row?.is_platform_admin === 'true',
    };
  }
}
