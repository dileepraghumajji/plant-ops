/**
 * The single place in the system where verified claims become **branded**
 * claims (Doc 07 §5 PROVENANCE).
 *
 * `markClaimsVerified` is the only constructor of `VerifiedClaims`, and
 * `applyRlsContext` accepts nothing else — that is what makes it impossible to
 * feed the tenant of a request from its body, a header, or a query parameter.
 * The brand is only as strong as the discipline about who applies it, so it is
 * applied here, in a file whose entire job is to be reviewed:
 *
 * - It is called by `AuthGuard` and by nothing else.
 * - It is called *after* signature, expiry and revocation have all passed —
 *   the guard's own ordering, not this file's assumption.
 * - It copies exactly the four fields the RLS context reads, so an extra claim
 *   on a token cannot smuggle anything through.
 *
 * The one other implementation of this in the workspace is `FixtureAuthGuard`
 * in `rls-context.integration.spec.ts`, which exists only inside a spec file
 * and is called out there for the same reason.
 */

import { Injectable } from '@nestjs/common';
import type { VerifiedClaimsSink } from '@plantops/auth-kit';
import type { JwtClaims } from '@plantops/contracts';
import { markClaimsVerified } from '@plantops/db';
import { setVerifiedClaims } from '../common/verified-claims';

@Injectable()
export class RequestClaimsSink implements VerifiedClaimsSink {
  accept(request: unknown, claims: JwtClaims): void {
    setVerifiedClaims(
      request,
      markClaimsVerified({
        cid: claims.cid,
        sub: claims.sub,
        sty: claims.sty,
        sid: claims.sid,
      }),
    );
  }
}
