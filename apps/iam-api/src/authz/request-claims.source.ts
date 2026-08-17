/**
 * The read side of `auth/verified-claims.sink.ts`.
 *
 * `AuthGuard` hands verified claims to the sink, which brands them and stores
 * them on the request under a module-private symbol. `PermissionGuard` runs
 * next and needs the same subject — so this is the adapter that hands them back,
 * and it is deliberately the *only* one: `verifiedClaimsOf` is not something
 * `auth-kit` could call, because the store and the brand both live in this
 * application (Doc 08 §2).
 *
 * It returns the branded `VerifiedClaims` rather than a copy. The port asks for
 * four fields and this has exactly those four plus a brand, so it satisfies the
 * interface — and returning the branded value is what lets `IamGrantsSource`
 * apply an RLS context from it without anybody calling `markClaimsVerified` a
 * second time (Doc 07 §5 keeps that to one call site).
 */

import { Injectable } from '@nestjs/common';
import type { VerifiedClaimsSource } from '@plantops/auth-kit';
import type { VerifiedClaims } from '@plantops/db';
import { verifiedClaimsOf } from '../common/verified-claims';

@Injectable()
export class RequestClaimsSource implements VerifiedClaimsSource {
  claimsOf(request: unknown): VerifiedClaims | undefined {
    return verifiedClaimsOf(request);
  }
}
