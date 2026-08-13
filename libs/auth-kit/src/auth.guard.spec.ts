/**
 * `AuthGuard` (Doc 03 §6).
 *
 * The assertions worth having here are mostly negative — what the guard
 * *refuses*, and what it refuses to reveal. A guard that admits the right
 * requests is trivially satisfied by returning `true`; the properties that take
 * work are deny-by-default, uniform refusals, and the ordering that keeps an
 * unverified `sid` from ever reaching the revocation store.
 */

import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubjectType, type JwtClaims } from '@plantops/contracts';
import {
  AuthGuard,
  IS_PUBLIC_METADATA,
  type AuthGuardOptions,
  type RevocationFallback,
  type VerifiedClaimsSink,
} from './auth.guard';
import { TokenRejection, TokenVerificationError } from './claims';
import type { TokenVerifier } from './jwks-verifier';
import type { RevocationChecker } from './revocation-cache';

const CLAIMS: JwtClaims = {
  iss: 'plantops-iam',
  sub: 'user-1',
  sty: SubjectType.USER,
  cid: 'client-1',
  sid: 'session-1',
  iat: 1_700_000_000,
  exp: 1_700_000_900,
};

/** A request object shaped like the one Express hands a guard. */
function requestWith(authorization?: string) {
  return { headers: authorization === undefined ? {} : { authorization } };
}

function contextFor(request: unknown, isPublic = false): ExecutionContext {
  const handler = () => undefined;
  class TestController {}
  const context = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  if (isPublic) Reflect.defineMetadata(IS_PUBLIC_METADATA, true, handler);
  return context;
}

interface Harness {
  guard: AuthGuard;
  verifier: { verify: jest.Mock };
  revocations: { isRevoked: jest.Mock };
  fallback: { isRevoked: jest.Mock };
  sink: { accept: jest.Mock };
}

function buildGuard(options: AuthGuardOptions = {}, withFallback = true): Harness {
  const verifier = { verify: jest.fn().mockResolvedValue(CLAIMS) };
  const revocations = { isRevoked: jest.fn().mockResolvedValue(false) };
  const fallback = { isRevoked: jest.fn().mockResolvedValue(false) };
  const sink = { accept: jest.fn() };

  const guard = new AuthGuard(
    new Reflector(),
    verifier as TokenVerifier,
    revocations as RevocationChecker,
    sink as VerifiedClaimsSink,
    withFallback ? (fallback as RevocationFallback) : null,
    options,
  );

  return { guard, verifier, revocations, fallback, sink };
}

describe('AuthGuard', () => {
  it('admits a verified, unrevoked token and hands the claims to the sink', async () => {
    const { guard, sink } = buildGuard();

    await expect(
      guard.canActivate(contextFor(requestWith('Bearer good-token'))),
    ).resolves.toBe(true);

    // The sink is the only route from a token to an RLS context (Doc 07 §5);
    // a guard that returned true without calling it would authenticate the
    // request and leave the database with no tenant.
    expect(sink.accept).toHaveBeenCalledWith(expect.anything(), CLAIMS);
  });

  it('refuses a request with no Authorization header', async () => {
    const { guard, verifier } = buildGuard();

    await expect(
      guard.canActivate(contextFor(requestWith())),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['no token after the scheme', 'Bearer '],
    ['extra segments', 'Bearer one two'],
  ])('refuses a header with %s', async (_label, header) => {
    const { guard } = buildGuard();

    await expect(
      guard.canActivate(contextFor(requestWith(header))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a lower-case scheme but takes the token verbatim', async () => {
    const { guard, verifier } = buildGuard();

    await guard.canActivate(contextFor(requestWith('bearer AbC.dEf.GhI')));

    // RFC 7235 makes the scheme case-insensitive; the token is the signed
    // document and must not be re-cased or trimmed on the way through.
    expect(verifier.verify).toHaveBeenCalledWith('AbC.dEf.GhI');
  });

  it('lets a @Public() route through without attaching claims', async () => {
    const { guard, verifier, sink } = buildGuard();

    await expect(
      guard.canActivate(contextFor(requestWith(), true)),
    ).resolves.toBe(true);

    // Public means *unauthenticated*, not privileged: no claims, so the
    // transaction wrapper applies no RLS context and no tenant row matches.
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(sink.accept).not.toHaveBeenCalled();
  });

  it('refuses a revoked session even though its token still verifies', async () => {
    const { guard, revocations, sink } = buildGuard();
    revocations.isRevoked.mockResolvedValue(true);

    await expect(
      guard.canActivate(contextFor(requestWith('Bearer good-token'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sink.accept).not.toHaveBeenCalled();
  });

  it('checks revocation only after verification', async () => {
    const { guard, verifier, revocations } = buildGuard();
    verifier.verify.mockRejectedValue(
      new TokenVerificationError(TokenRejection.BAD_SIGNATURE, 'nope'),
    );

    await expect(
      guard.canActivate(contextFor(requestWith('Bearer forged'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // A `sid` read out of an unverified token is attacker-chosen. Looking it up
    // would leak, through timing, whether a guessed session exists.
    expect(revocations.isRevoked).not.toHaveBeenCalled();
  });

  it('reports every refusal as the same bare 401', async () => {
    const reasons = [
      TokenRejection.EXPIRED,
      TokenRejection.UNKNOWN_KEY,
      TokenRejection.BAD_SIGNATURE,
      TokenRejection.WRONG_ISSUER,
    ];

    const messages = new Set<string>();
    for (const reason of reasons) {
      const { guard, verifier } = buildGuard();
      verifier.verify.mockRejectedValue(new TokenVerificationError(reason, reason));

      await guard
        .canActivate(contextFor(requestWith('Bearer t')))
        .catch((error: UnauthorizedException) => {
          messages.add(error.message);
        });
    }

    // Telling an expired token from an unknown `kid` tells an attacker whether
    // a forged key id was a near miss (Doc 06 §2).
    expect(messages.size).toBe(1);
  });

  describe('when the revocation cache cannot answer', () => {
    it('falls back to the database', async () => {
      const { guard, revocations, fallback } = buildGuard();
      revocations.isRevoked.mockRejectedValue(new Error('redis unavailable'));
      fallback.isRevoked.mockResolvedValue(false);

      await expect(
        guard.canActivate(contextFor(requestWith('Bearer good-token'))),
      ).resolves.toBe(true);
      // The whole claim set, not just `sid`: a service token's `sid` is backed
      // by no row, and the fallback needs `sty` to know that (Doc 03 §5).
      expect(fallback.isRevoked).toHaveBeenCalledWith(CLAIMS);
    });

    it('denies when the database cannot answer either', async () => {
      const { guard, revocations, fallback } = buildGuard();
      revocations.isRevoked.mockRejectedValue(new Error('redis unavailable'));
      fallback.isRevoked.mockRejectedValue(new Error('postgres unavailable'));

      // Uncertainty about revocation has to fall to refusal, or a cache outage
      // becomes a window in which every revoked session works again.
      await expect(
        guard.canActivate(contextFor(requestWith('Bearer good-token'))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('denies when there is no fallback at all', async () => {
      const { guard, revocations } = buildGuard({}, false);
      revocations.isRevoked.mockRejectedValue(new Error('redis unavailable'));

      // The posture of a consuming module, which owns no `session` table.
      await expect(
        guard.canActivate(contextFor(requestWith('Bearer good-token'))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('admits instead where a deployment explicitly chose availability', async () => {
      const { guard, revocations } = buildGuard(
        { onRevocationUnavailable: 'allow' },
        false,
      );
      revocations.isRevoked.mockRejectedValue(new Error('redis unavailable'));

      await expect(
        guard.canActivate(contextFor(requestWith('Bearer good-token'))),
      ).resolves.toBe(true);
    });
  });
});
