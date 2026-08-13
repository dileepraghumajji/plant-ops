/**
 * `PasswordResetService` against fakes — the seam either side of the database
 * (Doc 03 §7).
 *
 * The *decisions* belong to `iam.auth_request_password_reset` and
 * `iam.auth_complete_password_reset`, and are proved against a real Postgres in
 * `account-state.integration.spec.ts` — a grace-free single-use token, an
 * expiry judged by `now()`, and a spend that is atomic with the password it
 * sets are all things only a row lock can demonstrate.
 *
 * What this suite pins down is what the service does around those answers: that
 * the token which reaches delivery is the one whose *hash* reached the database
 * and never the other way round, that a transport failure changes nothing the
 * caller can see, and that every refusal is the same refusal.
 */

import { IamErrorCode } from '@plantops/contracts';
import { hashSecret, verifySecret } from '@plantops/db';
import type { EnvConfig } from '@plantops/config';
import { IamException } from '../common/iam.exception';
import type { DatabaseService } from '../database/database.service';
import type { PasswordResetDelivery, PasswordResetMessage } from './password-reset.delivery';
import { PasswordResetService } from './password-reset.service';
import { hashResetToken } from './password-reset.util';
import type { SessionService } from './session.service';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';

interface RecordedQuery {
  sql: string;
  parameters: unknown[];
}

class FakeDelivery implements PasswordResetDelivery {
  readonly sent: PasswordResetMessage[] = [];
  failing = false;

  async deliver(message: PasswordResetMessage): Promise<void> {
    if (this.failing) throw new Error('mail transport unavailable');
    this.sent.push(message);
  }
}

interface Harness {
  service: PasswordResetService;
  delivery: FakeDelivery;
  queries: RecordedQuery[];
  published: string[];
  /** Rows the fake database returns, shifted off one call at a time. */
  rows: unknown[][];
}

function harness(rows: unknown[][] = []): Harness {
  const queries: RecordedQuery[] = [];
  const published: string[] = [];
  const delivery = new FakeDelivery();

  const database = {
    dataSource: {
      query: async (sql: string, parameters: unknown[] = []): Promise<unknown[]> => {
        queries.push({ sql, parameters });
        return rows.shift() ?? [];
      },
    },
  } as unknown as DatabaseService;

  const sessions = {
    publishRevocations: async (ids: readonly string[]): Promise<void> => {
      published.push(...ids);
    },
  } as unknown as SessionService;

  const env = { PASSWORD_RESET_TTL_SECONDS: 3600 } as EnvConfig;

  return {
    service: new PasswordResetService(env, delivery, database, sessions),
    delivery,
    queries,
    published,
    rows,
  };
}

describe('PasswordResetService.request', () => {
  it('hands the database a hash and the delivery channel the token', async () => {
    const state = harness([[{ issued: true }]]);

    await state.service.request({ email: 'ana@example.test', clientSlug: 'acme' });

    const [message] = state.delivery.sent;
    const storedHash = state.queries[0]?.parameters[2];
    // The one property that matters on this path: what is stored is a function
    // of what is sent, and the raw token never crosses into Postgres.
    expect(storedHash).toBe(hashResetToken(message.token));
    expect(storedHash).not.toBe(message.token);
  });

  it('delivers nothing when the database issued nothing', async () => {
    const state = harness([[{ issued: false }]]);

    await state.service.request({ email: 'nobody@example.test', clientSlug: 'acme' });

    // Unknown address, locked account, disabled account, suspended tenant — the
    // function says no, and the difference stops here rather than reaching an
    // inbox.
    expect(state.delivery.sent).toHaveLength(0);
  });

  it('says nothing to the caller either way', async () => {
    const issued = harness([[{ issued: true }]]);
    const refused = harness([[{ issued: false }]]);

    // Both resolve, both with `undefined`. There is no return value for a
    // controller to accidentally turn into a different status code.
    await expect(
      issued.service.request({ email: 'ana@example.test', clientSlug: 'acme' }),
    ).resolves.toBeUndefined();
    await expect(
      refused.service.request({ email: 'nobody@example.test', clientSlug: 'acme' }),
    ).resolves.toBeUndefined();
  });

  it('swallows a delivery failure', async () => {
    const state = harness([[{ issued: true }]]);
    state.delivery.failing = true;

    // The row is written and audited; turning a transport outage into a 500
    // would tell an attacker which addresses are real by which ones fail.
    await expect(
      state.service.request({ email: 'ana@example.test', clientSlug: 'acme' }),
    ).resolves.toBeUndefined();
  });

  it('sets the expiry from the configured TTL', async () => {
    const state = harness([[{ issued: true }]]);
    const before = Date.now();

    await state.service.request({ email: 'ana@example.test', clientSlug: 'acme' });

    const expiresAt = Date.parse(state.queries[0]?.parameters[3] as string);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    expect(state.delivery.sent[0]?.expiresAt.toISOString()).toBe(
      new Date(expiresAt).toISOString(),
    );
  });
});

describe('PasswordResetService.complete', () => {
  it('hashes the new password with argon2id, never storing it', async () => {
    const state = harness([[{ outcome: 'completed', revoked_sessions: [] }]]);

    await state.service.complete({ token: 'a-token', newPassword: 'a-long-passphrase' });

    const storedHash = state.queries[0]?.parameters[1] as string;
    expect(storedHash).toMatch(/^\$argon2id\$/);
    expect(storedHash).not.toContain('a-long-passphrase');
    // A real hash of the real password, not a lookalike.
    await expect(verifySecret(storedHash, 'a-long-passphrase')).resolves.toBe(true);
  });

  it('looks the token up by hash', async () => {
    const state = harness([[{ outcome: 'completed', revoked_sessions: [] }]]);

    await state.service.complete({ token: 'a-token', newPassword: 'a-long-passphrase' });

    expect(state.queries[0]?.parameters[0]).toBe(hashResetToken('a-token'));
  });

  it('publishes the sessions the reset revoked (Doc 03 §6)', async () => {
    const state = harness([
      [{ outcome: 'completed', revoked_sessions: [SESSION_ID] }],
    ]);

    await state.service.complete({ token: 'a-token', newPassword: 'a-long-passphrase' });

    expect(state.published).toEqual([SESSION_ID]);
  });

  it('tolerates a null session array', async () => {
    const state = harness([[{ outcome: 'completed', revoked_sessions: null }]]);

    await expect(
      state.service.complete({ token: 'a-token', newPassword: 'a-long-passphrase' }),
    ).resolves.toBeUndefined();
    expect(state.published).toEqual([]);
  });

  it('refuses an invalid outcome with a 401', async () => {
    const state = harness([[{ outcome: 'invalid', revoked_sessions: [] }]]);

    await expect(
      state.service.complete({ token: 'a-token', newPassword: 'a-long-passphrase' }),
    ).rejects.toMatchObject({ code: IamErrorCode.INVALID_CREDENTIALS });
  });

  it('refuses when the function returned no row at all', async () => {
    // Not "declined" — the function did not run. Failing closed is the only
    // safe reading, since the alternative is setting a password on no evidence.
    const state = harness([[]]);

    await expect(
      state.service.complete({ token: 'a-token', newPassword: 'a-long-passphrase' }),
    ).rejects.toBeInstanceOf(IamException);
  });

  it('gives every refusal the same message', async () => {
    const invalid = harness([[{ outcome: 'invalid', revoked_sessions: [] }]]);
    const missing = harness([[]]);

    const first = await invalid.service
      .complete({ token: 'a', newPassword: 'a-long-passphrase' })
      .catch((error: IamException) => error);
    const second = await missing.service
      .complete({ token: 'b', newPassword: 'a-long-passphrase' })
      .catch((error: IamException) => error);

    // A message that differs by branch is the same leak as a status that does.
    expect((first as IamException).message).toBe((second as IamException).message);
    expect((first as IamException).getStatus()).toBe(401);
  });

  it('publishes nothing when the token was refused', async () => {
    const state = harness([[{ outcome: 'invalid', revoked_sessions: [SESSION_ID] }]]);

    await state.service
      .complete({ token: 'a-token', newPassword: 'a-long-passphrase' })
      .catch(() => undefined);

    // Belt and braces against a future refactor: a refusal revokes nothing, so
    // it must not publish a revocation either.
    expect(state.published).toEqual([]);
  });
});

describe('argon2id, not the reset token hash', () => {
  it('keeps the two hashes distinct for the same input', async () => {
    // The same string, hashed for two different purposes: the credential the
    // human chose gets the memory-hard function, the 256-bit bearer secret gets
    // the fast deterministic one. Confusing them would be a silent downgrade.
    const value = 'a-long-passphrase';
    expect(hashResetToken(value)).not.toBe(await hashSecret(value));
    expect(hashResetToken(value)).not.toMatch(/^\$argon2/);
  });
});
