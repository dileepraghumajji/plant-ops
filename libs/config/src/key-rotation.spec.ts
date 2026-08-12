/**
 * The rotation ordering (Doc 03 §1).
 *
 * Every test here is about a step being refused, because that is the only
 * failure mode worth guarding: each out-of-order rotation *succeeds* as an
 * operation and breaks tokens minutes later, somewhere else, in a fleet whose
 * operator has just changed the keys and is looking at the wrong thing.
 */

import {
  PROPAGATION_WAIT_SECONDS,
  RETENTION_WAIT_SECONDS,
  RotationOrderError,
  RotationStep,
  planActivate,
  planPublish,
  planRetire,
  serializeRetiredPublicKeys,
  type KeyEnvState,
} from './key-rotation.js';

const PEM_A = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----';
const PEM_B = '-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----';
const PRIVATE_B = '-----BEGIN PRIVATE KEY-----\nbbbb\n-----END PRIVATE KEY-----';

const T0 = new Date('2026-06-01T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const CURRENT: KeyEnvState = {
  signingKeyId: 'key-a',
  privateKey: '-----BEGIN PRIVATE KEY-----\naaaa\n-----END PRIVATE KEY-----',
  publicKey: PEM_A,
  retiredPublicKeys: {},
};

const INCOMING = { kid: 'key-b', privateKey: PRIVATE_B, publicKey: PEM_B };

describe('step 1 — publish', () => {
  it('adds the new public key to JWKS and leaves signing alone', () => {
    const plan = planPublish({ current: CURRENT, incoming: INCOMING, now: T0 });

    expect(plan.next.signingKeyId).toBe('key-a');
    expect(plan.next.privateKey).toBe(CURRENT.privateKey);
    expect(plan.next.retiredPublicKeys).toEqual({ 'key-b': PEM_B });
  });

  it('does not put the new private key anywhere in the environment', () => {
    // A key in JWT_PRIVATE_KEY is a key that signs. Publishing it here would
    // collapse steps 1 and 3 into one and skip the propagation wait entirely.
    const plan = planPublish({ current: CURRENT, incoming: INCOMING, now: T0 });

    expect(JSON.stringify(plan.next)).not.toContain(PRIVATE_B);
  });

  it('schedules activation one propagation window out', () => {
    const plan = planPublish({ current: CURRENT, incoming: INCOMING, now: T0 });

    expect(plan.nextStep).toBe(RotationStep.ACTIVATE);
    expect(plan.nextStepEarliestAt).toEqual(at(PROPAGATION_WAIT_SECONDS));
  });

  it('refuses to reuse the current kid', () => {
    // Same kid for different key material makes the old and new keys
    // indistinguishable to every verifier — the one thing kid exists to prevent.
    expect(() =>
      planPublish({
        current: CURRENT,
        incoming: { ...INCOMING, kid: 'key-a' },
        now: T0,
      }),
    ).toThrow(RotationOrderError);
  });

  it('refuses a kid that is already published', () => {
    expect(() =>
      planPublish({
        current: { ...CURRENT, retiredPublicKeys: { 'key-b': PEM_B } },
        incoming: INCOMING,
        now: T0,
      }),
    ).toThrow(/already published/);
  });
});

describe('step 3 — activate', () => {
  const published: KeyEnvState = {
    ...CURRENT,
    retiredPublicKeys: { 'key-b': PEM_B },
  };

  it('switches the signer and retains the outgoing public key in one step', () => {
    const plan = planActivate({
      current: published,
      kid: 'key-b',
      privateKey: PRIVATE_B,
      publishedAt: T0,
      now: at(PROPAGATION_WAIT_SECONDS),
    });

    expect(plan.next.signingKeyId).toBe('key-b');
    expect(plan.next.privateKey).toBe(PRIVATE_B);
    expect(plan.next.publicKey).toBe(PEM_B);
    // Atomic: there is never a moment where key-a has stopped signing but is
    // no longer published either.
    expect(plan.next.retiredPublicKeys).toEqual({ 'key-a': PEM_A });
  });

  it('refuses a key that was never published', () => {
    expect(() =>
      planActivate({
        current: CURRENT,
        kid: 'key-b',
        privateKey: PRIVATE_B,
        publishedAt: T0,
        now: at(PROPAGATION_WAIT_SECONDS),
      }),
    ).toThrow(/not published in JWKS/);
  });

  it('refuses to activate before JWKS propagation completes', () => {
    // Signing with a kid consumers have not fetched yet 401s every request
    // until their cache expires.
    expect(() =>
      planActivate({
        current: published,
        kid: 'key-b',
        privateKey: PRIVATE_B,
        publishedAt: T0,
        now: at(PROPAGATION_WAIT_SECONDS - 1),
      }),
    ).toThrow(/propagation is not complete/);
  });

  it('allows the wait to be forced, for a compromised key', () => {
    const plan = planActivate({
      current: published,
      kid: 'key-b',
      privateKey: PRIVATE_B,
      publishedAt: T0,
      now: at(1),
      force: true,
    });

    expect(plan.next.signingKeyId).toBe('key-b');
  });

  it('waits at least one full JWKS cache lifetime', () => {
    // A consumer that fetched one millisecond before the publish holds a stale
    // set for the whole max-age; the leeway covers clock disagreement about
    // when that ends.
    expect(PROPAGATION_WAIT_SECONDS).toBe(300 + 60);
  });
});

describe('step 4 — retire', () => {
  const rotated: KeyEnvState = {
    signingKeyId: 'key-b',
    privateKey: PRIVATE_B,
    publicKey: PEM_B,
    retiredPublicKeys: { 'key-a': PEM_A },
  };

  it('removes the key once nothing it signed can still be live', () => {
    const plan = planRetire({
      current: rotated,
      kid: 'key-a',
      deactivatedAt: T0,
      now: at(RETENTION_WAIT_SECONDS),
    });

    expect(plan.next.retiredPublicKeys).toEqual({});
    expect(plan.nextStep).toBeNull();
  });

  it('refuses while tokens signed by that key may still be valid', () => {
    expect(() =>
      planRetire({
        current: rotated,
        kid: 'key-a',
        deactivatedAt: T0,
        now: at(RETENTION_WAIT_SECONDS - 1),
      }),
    ).toThrow(/must stay published until/);
  });

  it('retains for one access-token lifetime plus the verifier leeway', () => {
    // Without the leeway term the key is withdrawn while verifiers are still,
    // correctly, accepting the last tokens it signed (Doc 03 §6).
    expect(RETENTION_WAIT_SECONDS).toBe(900 + 60);
  });

  it('refuses to retire the current signing key', () => {
    // Would leave the IAM signing with a key absent from its own JWKS.
    expect(() =>
      planRetire({
        current: rotated,
        kid: 'key-b',
        deactivatedAt: T0,
        now: at(RETENTION_WAIT_SECONDS),
      }),
    ).toThrow(/current signing key/);
  });

  it('refuses a kid that is not published', () => {
    expect(() =>
      planRetire({
        current: rotated,
        kid: 'key-z',
        deactivatedAt: T0,
        now: at(RETENTION_WAIT_SECONDS),
      }),
    ).toThrow(/nothing to retire/);
  });
});

describe('the full sequence', () => {
  it('never leaves an in-flight token without its verification key', () => {
    // Walk all three steps and assert the invariant at every intermediate
    // state: the signer's own key is published, and so is its predecessor,
    // until the predecessor's tokens have expired.
    const publish = planPublish({ current: CURRENT, incoming: INCOMING, now: T0 });
    expect(publishedKids(publish.next)).toEqual(
      expect.arrayContaining(['key-a', 'key-b']),
    );

    const activate = planActivate({
      current: publish.next,
      kid: 'key-b',
      privateKey: PRIVATE_B,
      publishedAt: T0,
      now: at(PROPAGATION_WAIT_SECONDS),
    });
    expect(publishedKids(activate.next)).toEqual(
      expect.arrayContaining(['key-a', 'key-b']),
    );

    const retire = planRetire({
      current: activate.next,
      kid: 'key-a',
      deactivatedAt: at(PROPAGATION_WAIT_SECONDS),
      now: at(PROPAGATION_WAIT_SECONDS + RETENTION_WAIT_SECONDS),
    });
    expect(publishedKids(retire.next)).toEqual(['key-b']);
  });
});

describe('serializeRetiredPublicKeys', () => {
  it('produces a single-line value the env schema parses back', () => {
    const serialized = serializeRetiredPublicKeys({ 'key-a': PEM_A });

    expect(serialized).not.toContain('\n');
    expect(JSON.parse(serialized)).toEqual({ 'key-a': PEM_A.replace(/\n/g, '\\n') });
  });
});

/** Every kid a verifier would find in JWKS for a given env state. */
function publishedKids(state: KeyEnvState): string[] {
  return [...new Set([state.signingKeyId, ...Object.keys(state.retiredPublicKeys)])];
}
