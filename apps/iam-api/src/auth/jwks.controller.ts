/**
 * `GET /iam/.well-known/jwks.json` — the public keys consuming modules verify
 * with (Doc 03 §1, Doc 06 §12).
 *
 * This endpoint is the reason a module never calls the IAM to check a
 * signature: it fetches these keys once, caches them, and verifies locally.
 * Three consequences follow, and each is a line of code below.
 *
 * - **Unauthenticated.** A verifier has no token yet — requiring one to fetch
 *   the keys that verify tokens is a bootstrap it cannot complete. The response
 *   contains public keys, which is what "public" means.
 * - **`Cache-Control: max-age`.** Doc 03 §1 step 2 says to wait for JWKS
 *   propagation before switching signers. The wait is only meaningful if the
 *   caching window is a stated number rather than each consumer's guess, so the
 *   response states it and `tools/rotate-keys.ts` computes the activation delay
 *   from the same constant.
 * - **No transaction.** Key material comes from the environment; opening a
 *   database transaction to serve it would make signature verification across
 *   the fleet depend on Postgres being up.
 */

import { Controller, Get, Header } from '@nestjs/common';
import { IAM_ROUTE_PREFIX, type JwksResponse } from '@plantops/contracts';
import { RateLimit } from '../common/rate-limit.decorator';
import { SkipTransaction } from '../common/transaction-context';
import { JWKS_CACHE_MAX_AGE_SECONDS, KeysService } from './keys.service';

/**
 * Deliberately generous, and deliberately not exempt.
 *
 * Not exempt, because an unauthenticated public endpoint with no limit is a
 * free amplifier. Generous, because a 429 here does not degrade one caller — it
 * stops a whole module fleet from verifying *any* token, and fleets behind one
 * NAT share an address. `failOpen` for the same reason: if Redis is down, the
 * right outcome is serving public keys, not a fleet-wide auth outage.
 */
const JWKS_RATE_LIMIT = { limit: 600, windowSeconds: 60, failOpen: true } as const;

@Controller(IAM_ROUTE_PREFIX)
@SkipTransaction()
export class JwksController {
  constructor(private readonly keys: KeysService) {}

  @Get('.well-known/jwks.json')
  @RateLimit(JWKS_RATE_LIMIT)
  @Header('Cache-Control', `public, max-age=${JWKS_CACHE_MAX_AGE_SECONDS}`)
  @Header('Content-Type', 'application/jwk-set+json')
  jwks(): JwksResponse {
    return this.keys.jwks();
  }
}
