/**
 * `RefreshService` against fakes — the four outcomes, and the seam either side
 * of them (Doc 03 §4).
 *
 * The *decision* is the database's and is proved against a real Postgres in
 * `refresh-rotation.integration.spec.ts`, which is the only place a row lock and
 * a grace window can be observed. What this suite pins down is what the service
 * does with each answer: which token comes back, what is written to the replay
 * cache and when, and — the part with teeth — that every refusal is the same
 * refusal, whatever produced it.
 */

import { IamErrorCode, SubjectType, type TokenPairResponse } from '@plantops/contracts';
import { IamException } from '../common/iam.exception';
import { RefreshService } from './refresh.service';
import { RefreshReplayCache } from './refresh-replay.cache';
import {
  formatRefreshToken,
  hashRefreshSecret,
  mintRefreshSecret,
  parseRefreshToken,
} from './refresh-token.util';
import type { RotateRefreshInput, RotationResult } from './session.service';
import type { SessionService } from './session.service';
import type { TokenService } from './token.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

/** A minimal in-memory stand-in for the two Redis commands the cache uses. */
class FakeStore {
  readonly entries = new Map<string, string>();
  failing = false;

  async set(key: string, value: string): Promise<'OK' | null> {
    if (this.failing) throw new Error('redis is down');
    // `NX`: the first proposal for a key wins and every later one is told so.
    if (this.entries.has(key)) return null;
    this.entries.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    if (this.failing) throw new Error('redis is down');
    return this.entries.get(key) ?? null;
  }
}

interface Harness {
  service: RefreshService;
  store: FakeStore;
  calls: RotateRefreshInput[];
  /** What the fake database will answer, and with which stored secret. */
  outcome: RotationResult;
}

function harnessFor(outcome: RotationResult): Harness {
  const store = new FakeStore();
  const calls: RotateRefreshInput[] = [];
  const state: Harness = {
    store,
    calls,
    outcome,
    service: undefined as unknown as RefreshService,
  };

  const sessions = {
    rotateRefreshToken: async (input: RotateRefreshInput): Promise<RotationResult> => {
      calls.push(input);
      return state.outcome;
    },
  } as unknown as SessionService;

  const tokens = {
    issueAccessToken: (input: { sessionId: string }) => ({
      accessToken: `access-for-${input.sessionId}`,
      expiresIn: 900,
      claims: {},
    }),
  } as unknown as TokenService;

  state.service = new RefreshService(
    tokens,
    sessions,
    new RefreshReplayCache(store, 15),
  );
  return state;
}

const tokenFor = (secret: string) => formatRefreshToken(SESSION_ID, secret);

const subject = { outcome: 'rotated', clientId: CLIENT_ID, userId: USER_ID } as const;

describe('RefreshService', () => {
  describe('a normal rotation', () => {
    it('returns a new refresh token and a fresh access token', async () => {
      const presented = mintRefreshSecret();
      const { service } = harnessFor(subject);

      const response = await service.refresh(tokenFor(presented));

      expect(response.access_token).toBe(`access-for-${SESSION_ID}`);
      expect(response.expires_in).toBe(900);
      expect(response.refresh_token).not.toBe(tokenFor(presented));
      // Same session, new secret: rotation keeps `session.id` (Doc 03 §4).
      expect(parseRefreshToken(response.refresh_token)?.sessionId).toBe(SESSION_ID);
    });

    it('hands the database the presented secret and the one it minted', async () => {
      const presented = mintRefreshSecret();
      const { service, calls } = harnessFor(subject);

      const response = await service.refresh(tokenFor(presented));

      expect(calls).toHaveLength(1);
      expect(calls[0].sessionId).toBe(SESSION_ID);
      expect(calls[0].presentedSecret).toBe(presented);
      expect(calls[0].successorSecret).toBe(
        parseRefreshToken(response.refresh_token)?.secret,
      );
    });

    it('elects the successor under the hash of the token it replaced', async () => {
      const presented = mintRefreshSecret();
      const { service, store } = harnessFor(subject);

      const response = await service.refresh(tokenFor(presented));

      // Keyed by the *old* token's hash, because that is what the client that
      // lost the race will present.
      const entry = [...store.entries].find(([key]) =>
        key.includes(hashRefreshSecret(presented)),
      );
      expect(entry?.[1]).toBe(parseRefreshToken(response.refresh_token)?.secret);
    });

    it('still succeeds when the replay cache cannot be reached', async () => {
      const { service, store } = harnessFor(subject);
      store.failing = true;

      // The rotation is sound and this client has earned its token; what is
      // lost is the window, and only for this generation.
      await expect(service.refresh(tokenFor(mintRefreshSecret()))).resolves.toEqual(
        expect.objectContaining({ access_token: expect.any(String) }),
      );
    });
  });

  describe('an in-grace replay — the two-tabs race', () => {
    /** Rotates once, then presents the same token again. */
    const raceOn = async (): Promise<{
      first: TokenPairResponse;
      second: TokenPairResponse;
    }> => {
      const presented = mintRefreshSecret();
      const harness = harnessFor(subject);

      const first = await harness.service.refresh(tokenFor(presented));
      harness.outcome = { outcome: 'replay', clientId: CLIENT_ID, userId: USER_ID };
      const second = await harness.service.refresh(tokenFor(presented));

      return { first, second };
    };

    it('returns the successor the winner already issued, not a third token', async () => {
      const { first, second } = await raceOn();

      // The property the whole grace window exists for: both clients converge
      // on one token. Diverge here and the loser is silently one generation
      // behind, and loses its session at its *next* refresh.
      expect(second.refresh_token).toBe(first.refresh_token);
    });

    it('mints a fresh access token rather than replaying a stored one', async () => {
      const { second } = await raceOn();

      // Only the refresh token has to be identical. Re-signing costs one
      // signature and keeps an access token out of Redis entirely.
      expect(second.access_token).toBe(`access-for-${SESSION_ID}`);
      expect(second.expires_in).toBe(900);
    });

    it('proposes the same successor from both requests', async () => {
      const presented = mintRefreshSecret();
      const harness = harnessFor(subject);
      await harness.service.refresh(tokenFor(presented));

      harness.outcome = { outcome: 'replay', clientId: CLIENT_ID, userId: USER_ID };
      await harness.service.refresh(tokenFor(presented));

      // The point of electing before rotating: whichever request had won the
      // row, it would have installed this same secret. The second call's own
      // candidate was minted, rejected by the write-once cache, and dropped.
      expect(harness.calls).toHaveLength(2);
      expect(harness.calls[1].successorSecret).toBe(harness.calls[0].successorSecret);
      expect(harness.store.entries.size).toBe(1);
    });

    it('converges even when the cache and the row pick different winners', async () => {
      // The cache elects whoever writes first; the row lock elects whoever gets
      // there first, and nothing keeps those the same request. Here the request
      // that elects is the one the row rejects — and the rotation that follows
      // must still install the elected secret, or the replayer is handed a
      // token no session recognises.
      const presented = mintRefreshSecret();
      const harness = harnessFor({
        outcome: 'replay',
        clientId: CLIENT_ID,
        userId: USER_ID,
      });

      await harness.service.refresh(tokenFor(presented)).catch(() => null);
      const elected = [...harness.store.entries.values()][0];

      harness.outcome = subject;
      const rotation = await harness.service.refresh(tokenFor(presented));

      expect(parseRefreshToken(rotation.refresh_token)?.secret).toBe(elected);
    });

    it('refuses a stale replay without revoking', async () => {
      // What the database answers when the election never reached the request
      // that rotated: the proposal in hand is not the hash that was installed.
      // Handing it over would look like success and revoke the session at the
      // *next* refresh. One person logs in again instead.
      const { service } = harnessFor({
        outcome: 'stale',
        clientId: CLIENT_ID,
        userId: USER_ID,
      });

      await expect(service.refresh(tokenFor(mintRefreshSecret()))).rejects.toThrow(
        IamException,
      );
    });

    it.each([
      ['the entry is gone', (store: FakeStore) => store.entries.clear()],
      ['the cache is unreachable', (store: FakeStore) => void (store.failing = true)],
    ])('proposes its own candidate when %s', async (_case, breakStore) => {
      const presented = mintRefreshSecret();
      const harness = harnessFor(subject);
      await harness.service.refresh(tokenFor(presented));
      const elected = harness.calls[0].successorSecret;

      breakStore(harness.store);
      await harness.service.refresh(tokenFor(presented));

      // Which is what makes the database answer `stale` rather than `replay`:
      // the proposal no longer matches the hash the winner installed, and only
      // the row is in a position to notice.
      expect(harness.calls[1].successorSecret).not.toBe(elected);
    });

    it('rotates normally while the cache is unreachable', async () => {
      const harness = harnessFor(subject);
      harness.store.failing = true;

      const response = await harness.service.refresh(tokenFor(mintRefreshSecret()));

      // Only the *replay* half of Doc 03 §4 depends on the cache. A client that
      // is not racing anyone should not notice the outage at all.
      expect(parseRefreshToken(response.refresh_token)?.secret).toBe(
        harness.calls[0].successorSecret,
      );
    });
  });

  describe('refusals', () => {
    it.each([
      ['a token that does not parse', 'not-a-refresh-token'],
      ['a token whose session id is malformed', `nope~${mintRefreshSecret()}`],
    ])('refuses %s without reaching the database', async (_case, token) => {
      const { service, calls } = harnessFor(subject);

      await expect(service.refresh(token)).rejects.toThrow(IamException);
      expect(calls).toHaveLength(0);
    });

    // `reuse` — the session has just been revoked and audited by the row itself;
    // `invalid` — there is no live session behind the token at all.
    it.each(['reuse', 'invalid'] as const)('refuses on %s', async (outcome) => {
      const { service } = harnessFor(
        outcome === 'invalid'
          ? { outcome: 'invalid' }
          : { outcome, clientId: CLIENT_ID, userId: USER_ID },
      );

      await expect(service.refresh(tokenFor(mintRefreshSecret()))).rejects.toMatchObject(
        { code: IamErrorCode.INVALID_CREDENTIALS },
      );
    });

    it('gives byte-identical refusals for every reason it has', async () => {
      const messages = new Set<string>();

      for (const outcome of [
        { outcome: 'invalid' } as const,
        { outcome: 'reuse', clientId: CLIENT_ID, userId: USER_ID } as const,
      ]) {
        const { service } = harnessFor(outcome);
        await service.refresh(tokenFor(mintRefreshSecret())).catch((error: unknown) => {
          messages.add((error as IamException).message);
        });
      }

      const { service } = harnessFor(subject);
      await service.refresh('garbage').catch((error: unknown) => {
        messages.add((error as IamException).message);
      });

      // A message that differs by branch tells the holder of a stolen token how
      // much the owner already knows — the same leak as a status that differs.
      expect(messages.size).toBe(1);
    });
  });

  it('issues the access token for the subject the database named', async () => {
    const issued: unknown[] = [];
    const { service } = harnessFor(subject);
    // Reaching past the harness on purpose: the subject of the new token must
    // come from the row, never from anything the caller sent.
    const tokens = (service as unknown as { tokens: TokenService }).tokens;
    const original = tokens.issueAccessToken.bind(tokens);
    tokens.issueAccessToken = ((input: Parameters<typeof original>[0]) => {
      issued.push(input);
      return original(input);
    }) as typeof tokens.issueAccessToken;

    await service.refresh(tokenFor(mintRefreshSecret()));

    expect(issued[0]).toEqual({
      subjectId: USER_ID,
      subjectType: SubjectType.USER,
      clientId: CLIENT_ID,
      sessionId: SESSION_ID,
    });
  });
});
