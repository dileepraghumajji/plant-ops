/**
 * Password verification (Doc 03 §3, §7).
 *
 * The correctness half is nearly trivial — argon2 either matches or it does
 * not. The half worth testing is the enumeration defence, which is easy to
 * break by accident and produces no failing behaviour when it breaks: an
 * early return for an unknown user leaves every response correct and every
 * timing wrong.
 */

import { ARGON2_OPTIONS, hashSecret } from '@plantops/db';
import {
  DUMMY_HASH,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
  verifyPasswordCandidate,
} from './password.util';

const PASSWORD = 'correct-horse-battery-staple';

describe('verifyPasswordCandidate', () => {
  let storedHash: string;

  beforeAll(async () => {
    storedHash = await hashSecret(PASSWORD);
  });

  it('accepts the right password and refuses a wrong one', async () => {
    await expect(verifyPasswordCandidate(storedHash, PASSWORD)).resolves.toBe(true);
    await expect(verifyPasswordCandidate(storedHash, 'not-it')).resolves.toBe(false);
  });

  it.each([
    ['no user row at all', null],
    ['a user with no password identity', undefined],
    ['an empty hash column', ''],
  ])('refuses when there is %s', async (_label, hash) => {
    await expect(verifyPasswordCandidate(hash, PASSWORD)).resolves.toBe(false);
  });

  it('carries argon2 parameters identical to a stored hash', () => {
    // The dummy only closes the timing gap if it costs what a real
    // verification costs. A parameter change on one side and not the other
    // re-opens it silently, so the two are compared rather than assumed.
    const parameters = (hash: string) => hash.split('$')[3];

    expect(parameters(DUMMY_HASH)).toBe(parameters(storedHash));
    expect(DUMMY_HASH).toContain(
      `m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}`,
    );
  });

  it('does the work even when there is nobody to authenticate', async () => {
    // The failure this catches: a malformed dummy would make `verifySecret`
    // bail out without hashing, and "no such user" would answer in a
    // millisecond while "wrong password" took fifty — a measurable oracle for
    // which email addresses exist (Doc 03 §3).
    const started = process.hrtime.bigint();
    await verifyPasswordCandidate(null, PASSWORD);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // A real argon2id verification at these parameters is tens of
    // milliseconds. The bound is deliberately far below that: this asserts
    // that hashing happened at all, not how fast the machine is.
    expect(elapsedMs).toBeGreaterThan(5);
  });
});

describe('passwordSchema (Doc 03 §7)', () => {
  it('requires a minimum length', () => {
    expect(passwordSchema.safeParse('x'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(
      false,
    );
    expect(passwordSchema.safeParse('x'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
  });

  it('bounds the length, because argon2 hashes whatever it is given', () => {
    // Not a policy: an unbounded field is unbounded memory-hard work per
    // request, which is a denial of service with a valid-looking body.
    expect(passwordSchema.safeParse('x'.repeat(10_000)).success).toBe(false);
  });

  it('imposes no composition rules', () => {
    // Length is the term that matters; "one uppercase, one symbol" pushes
    // people toward `Password1!` and is not what NIST 800-63B recommends.
    expect(passwordSchema.safeParse('all lowercase words here').success).toBe(true);
  });
});
