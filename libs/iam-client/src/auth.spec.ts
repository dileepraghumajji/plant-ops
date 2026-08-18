import type { TokenPairResponse } from '@plantops/contracts';

import { MemoryTokenStore, TokenSession, type StoredTokens } from './auth.js';

const pair = (n: number, expiresIn = 900): TokenPairResponse => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: expiresIn,
});

/** A clock the test moves by hand — no timers, no flakiness. */
const clock = (start = 1_700_000_000_000) => {
  let value = start;
  return {
    now: () => value,
    advanceSeconds: (seconds: number) => {
      value += seconds * 1000;
    },
  };
};

/** A refresh that never resolves until the test says so. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('MemoryTokenStore', () => {
  it('round-trips and clears', () => {
    const store = new MemoryTokenStore();
    expect(store.read()).toBeNull();

    const tokens: StoredTokens = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: null,
    };
    store.write(tokens);
    expect(store.read()).toEqual(tokens);

    store.write(null);
    expect(store.read()).toBeNull();
  });
});

describe('TokenSession', () => {
  it('has no token before anything is adopted', async () => {
    const session = new TokenSession(async () => pair(1));

    expect(await session.accessToken()).toBeNull();
    expect(await session.isAuthenticated()).toBe(false);
  });

  it('derives the expiry from expires_in at the moment of adoption', async () => {
    const time = clock();
    const session = new TokenSession(async () => pair(2), { now: time.now });

    await session.adopt(pair(1, 900));

    expect(await session.tokens()).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: time.now() + 900_000,
    });
  });

  it('keeps a service-account token, which has no refresh half', async () => {
    const session = new TokenSession(async () => pair(2));

    await session.adopt({ access_token: 'svc-1', expires_in: 300 });

    const tokens = await session.tokens();
    expect(tokens?.refreshToken).toBeNull();
    expect(await session.accessToken()).toBe('svc-1');
  });

  it('renews before the token lapses, not after', async () => {
    const time = clock();
    const exchange = jest.fn(async () => pair(2));
    const session = new TokenSession(exchange, {
      now: time.now,
      refreshLeewaySeconds: 30,
    });
    await session.adopt(pair(1, 900));

    time.advanceSeconds(860); // 40s of life left — outside the leeway
    expect(await session.accessToken()).toBe('access-1');
    expect(exchange).not.toHaveBeenCalled();

    time.advanceSeconds(20); // 20s left — inside it
    expect(await session.accessToken()).toBe('access-2');
    expect(exchange).toHaveBeenCalledWith('refresh-1');
  });

  it('does not renew a service token it cannot renew', async () => {
    const time = clock();
    const exchange = jest.fn(async () => pair(2));
    const session = new TokenSession(exchange, { now: time.now });
    await session.adopt({ access_token: 'svc-1', expires_in: 300 });

    time.advanceSeconds(299);

    expect(await session.accessToken()).toBe('svc-1');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('shares one exchange between every concurrent refresh', async () => {
    const gate = deferred<TokenPairResponse>();
    const exchange = jest.fn(() => gate.promise);
    const session = new TokenSession(exchange);
    await session.adopt(pair(1));

    const flights = [session.refresh(), session.refresh(), session.refresh()];
    gate.resolve(pair(2));
    const results = await Promise.all(flights);

    expect(exchange).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.access_token)).toEqual([
      'access-2',
      'access-2',
      'access-2',
    ]);
  });

  it('starts a fresh exchange once the shared one has settled', async () => {
    const exchange = jest.fn(async () => pair(2));
    const session = new TokenSession(exchange);
    await session.adopt(pair(1));

    await session.refresh();
    await session.refresh();

    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it('drops the session when the refresh token is refused', async () => {
    const ended = jest.fn();
    const session = new TokenSession(
      async () => {
        throw new Error('reuse detected');
      },
      { onSessionEnded: ended },
    );
    await session.adopt(pair(1));

    await expect(session.refresh()).rejects.toThrow('reuse detected');
    expect(await session.tokens()).toBeNull();
    expect(ended).toHaveBeenCalledWith('refresh_failed');
  });

  describe('reauthorize', () => {
    it('refreshes when the failed token is still the stored one', async () => {
      const exchange = jest.fn(async () => pair(2));
      const session = new TokenSession(exchange);
      await session.adopt(pair(1));

      expect(await session.reauthorize('access-1')).toBe(true);
      expect(await session.accessToken()).toBe('access-2');
      expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('retries without refreshing when another call already renewed', async () => {
      const exchange = jest.fn(async () => pair(2));
      const session = new TokenSession(exchange);
      await session.adopt(pair(9));

      // 'access-1' is a token this session has never held: some earlier request
      // failed with it and the winner of the race has already stored a newer one.
      expect(await session.reauthorize('access-1')).toBe(true);
      expect(exchange).not.toHaveBeenCalled();
    });

    it('collapses a burst of 401s into one exchange', async () => {
      const gate = deferred<TokenPairResponse>();
      const exchange = jest.fn(() => gate.promise);
      const session = new TokenSession(exchange);
      await session.adopt(pair(1));

      const decisions = [
        session.reauthorize('access-1'),
        session.reauthorize('access-1'),
        session.reauthorize('access-1'),
      ];
      gate.resolve(pair(2));

      expect(await Promise.all(decisions)).toEqual([true, true, true]);
      expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('declines when there is nothing to refresh with', async () => {
      const session = new TokenSession(async () => pair(2));
      await session.adopt({ access_token: 'svc-1', expires_in: 300 });

      expect(await session.reauthorize('svc-1')).toBe(false);
    });

    it('declines, rather than throwing, when the refresh is refused', async () => {
      const session = new TokenSession(async () => {
        throw new Error('revoked');
      });
      await session.adopt(pair(1));

      expect(await session.reauthorize('access-1')).toBe(false);
      expect(await session.tokens()).toBeNull();
    });

    it('declines when there is no session at all', async () => {
      const session = new TokenSession(async () => pair(2));
      expect(await session.reauthorize('anything')).toBe(false);
    });
  });

  it('clear() forgets the tokens and says why', async () => {
    const ended = jest.fn();
    const session = new TokenSession(async () => pair(2), { onSessionEnded: ended });
    await session.adopt(pair(1));

    await session.clear();

    expect(await session.tokens()).toBeNull();
    expect(ended).toHaveBeenCalledWith('logout');
  });

  it('restores tokens from another source', async () => {
    const store = new MemoryTokenStore();
    const session = new TokenSession(async () => pair(2), { store });

    await session.restore({
      accessToken: 'from-elsewhere',
      refreshToken: null,
      expiresAt: null,
    });

    expect(await session.accessToken()).toBe('from-elsewhere');
    expect(store.read()?.accessToken).toBe('from-elsewhere');
  });

  it('uses the store it was given, so a browser can persist tokens itself', async () => {
    const written: (StoredTokens | null)[] = [];
    const store = {
      read: () => written[written.length - 1] ?? null,
      write: (tokens: StoredTokens | null) => {
        written.push(tokens);
      },
    };
    const session = new TokenSession(async () => pair(2), { store });

    await session.adopt(pair(1));
    await session.clear();

    expect(written).toHaveLength(2);
    expect(written[0]?.accessToken).toBe('access-1');
    expect(written[1]).toBeNull();
  });
});
