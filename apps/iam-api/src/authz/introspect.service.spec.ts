/**
 * Token introspection (Doc 06 §11).
 *
 * The verifier is real — `TokenService` with a real keypair — because the one
 * thing worth proving about a rejection is that it comes from an actual
 * signature check rather than from a stub agreeing with the test. What is faked
 * is the revocation pair, since the property under test is which of them is
 * consulted, in what order, and what happens when neither can answer.
 */

import type { RevocationChecker, RevocationFallback } from '@plantops/auth-kit';
import { SubjectType, type JwtClaims } from '@plantops/contracts';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { parseEnv } from '@plantops/config';
import { KeysService } from '../auth/keys.service';
import { TokenService } from '../auth/token.service';
import { IntrospectService } from './introspect.service';

const KEYPAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const env = parseEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app:pw@localhost:6543/plantops_iam',
  DATABASE_DIRECT_URL: 'postgresql://owner:pw@localhost:5432/plantops_iam',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SIGNING_KEY_ID: 'test-key',
  JWT_PRIVATE_KEY: KEYPAIR.privateKey,
  JWT_PUBLIC_KEY: KEYPAIR.publicKey,
  PLATFORM_BOOTSTRAP_SECRET: 'x'.repeat(48),
});

class FakeRevocations implements RevocationChecker {
  revoked = new Set<string>();
  failing = false;
  readonly asked: string[] = [];

  async isRevoked(sessionId: string): Promise<boolean> {
    this.asked.push(sessionId);
    if (this.failing) throw new Error('redis unavailable');
    return this.revoked.has(sessionId);
  }
}

class FakeSessions implements RevocationFallback {
  revoked = new Set<string>();
  failing = false;
  readonly asked: JwtClaims[] = [];

  async isRevoked(claims: JwtClaims): Promise<boolean> {
    this.asked.push(claims);
    if (this.failing) throw new Error('database unavailable');
    return this.revoked.has(claims.sid);
  }
}

function createService() {
  const tokens = new TokenService(env, new KeysService(env));
  const revocations = new FakeRevocations();
  const sessions = new FakeSessions();
  const service = new IntrospectService(tokens, revocations, sessions);

  const issue = (overrides: Partial<Parameters<TokenService['issueAccessToken']>[0]> = {}) =>
    tokens.issueAccessToken({
      subjectId: randomUUID(),
      subjectType: SubjectType.USER,
      clientId: randomUUID(),
      sessionId: randomUUID(),
      ...overrides,
    });

  return { service, tokens, revocations, sessions, issue };
}

describe('POST /iam/introspect', () => {
  it('reports a live token with exactly the five fields Doc 06 §11 names', async () => {
    const { service, issue } = createService();
    const issued = issue();

    const result = await service.introspect(issued.accessToken);

    expect(result).toEqual({
      active: true,
      sub: issued.claims.sub,
      sty: issued.claims.sty,
      cid: issued.claims.cid,
      sid: issued.claims.sid,
    });
    // Not `iat`/`exp`: they are in the token the caller already holds, and
    // echoing them invites a consumer to trust this response's expiry over the
    // signed one.
    expect(Object.keys(result)).toHaveLength(5);
  });

  it('reports a revoked session inactive, with no identity at all', async () => {
    const { service, revocations, issue } = createService();
    const issued = issue();
    revocations.revoked.add(issued.claims.sid);

    expect(await service.introspect(issued.accessToken)).toEqual({ active: false });
  });

  it('reports a forged token inactive and never asks about its session', async () => {
    const { service, revocations, issue } = createService();
    const [header, payload] = issue().accessToken.split('.');

    expect(await service.introspect(`${header}.${payload}.forged`)).toEqual({
      active: false,
    });
    // The `sid` in an unverified token is attacker-chosen; looking it up would
    // leak whether a guessed session exists through response timing.
    expect(revocations.asked).toEqual([]);
  });

  it('reports garbage inactive rather than failing', async () => {
    const { service } = createService();

    expect(await service.introspect('not-a-token')).toEqual({ active: false });
    expect(await service.introspect('a.b.c')).toEqual({ active: false });
  });

  it('reports an expired token inactive', async () => {
    const { service, tokens } = createService();
    // Signed an hour ago: past the 15-minute lifetime and past the 60 s skew
    // leeway every verifier in the fleet applies (Doc 03 §6).
    const stale = tokens.issueAccessToken(
      {
        subjectId: randomUUID(),
        subjectType: SubjectType.USER,
        clientId: randomUUID(),
        sessionId: randomUUID(),
      },
      new Date(Date.now() - 3_600_000),
    );

    expect(await service.introspect(stale.accessToken)).toEqual({ active: false });
  });

  it('falls back to the database when the revocation cache cannot answer', async () => {
    const { service, revocations, sessions, issue } = createService();
    const issued = issue();
    revocations.failing = true;

    expect(await service.introspect(issued.accessToken)).toEqual({
      active: true,
      sub: issued.claims.sub,
      sty: issued.claims.sty,
      cid: issued.claims.cid,
      sid: issued.claims.sid,
    });
    expect(sessions.asked).toHaveLength(1);
  });

  it('reports the token inactive when neither source can answer', async () => {
    const { service, revocations, sessions, issue } = createService();
    revocations.failing = true;
    sessions.failing = true;

    // `AuthGuard`'s `onRevocationUnavailable: 'deny'`, applied to the same
    // question. A consumer trusting `active` during an outage would honour
    // sessions the IAM itself was refusing.
    expect(await service.introspect(issue().accessToken)).toEqual({ active: false });
  });

  it('does not require the token to belong to the calling tenant', async () => {
    const { service, issue } = createService();
    // Deliberate: the caller already holds the token, and a JWS payload is
    // base64 — every field below is readable without asking. See the service
    // header for why refusing would break a multi-tenant module to protect
    // nothing.
    const foreign = issue({ clientId: randomUUID() });

    expect(await service.introspect(foreign.accessToken)).toMatchObject({
      active: true,
      cid: foreign.claims.cid,
    });
  });
});
