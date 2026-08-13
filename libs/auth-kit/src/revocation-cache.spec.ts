/**
 * The revoked-`sid` cache (Doc 03 §6).
 *
 * Two properties carry the weight: the key namespace, because the IAM writes
 * these entries and other processes read them and a mismatch would silently
 * mean "no session is ever revoked"; and the refusal to answer `false` when the
 * store is broken, because that is the difference between a cache miss and an
 * outage.
 */

import { REVOKED_SESSION_KEY_PREFIX } from '@plantops/contracts';
import { RevocationCache, type RevocationStore } from './revocation-cache';

const TTL = 960;

function storeSpy() {
  const keys = new Map<string, string>();
  return {
    keys,
    calls: [] as unknown[][],
    set: jest.fn(async (key: string, value: string, mode: string, ttl: number) => {
      keys.set(key, `${value}|${mode}|${ttl}`);
      return 'OK';
    }),
    exists: jest.fn(async (key: string) => (keys.has(key) ? 1 : 0)),
  };
}

describe('RevocationCache', () => {
  it('writes one self-expiring key per revoked session', async () => {
    const store = storeSpy();
    const cache = new RevocationCache(store as unknown as RevocationStore, {
      ttlSeconds: TTL,
    });

    await cache.revoke('session-1');

    // `EX` in the same command, not a following `EXPIRE`: a connection lost
    // between two commands would otherwise leave an entry that never expires.
    expect(store.set).toHaveBeenCalledWith(
      `${REVOKED_SESSION_KEY_PREFIX}session-1`,
      '1',
      'EX',
      TTL,
    );
  });

  it('reads back a revoked session and only that session', async () => {
    const store = storeSpy();
    const cache = new RevocationCache(store as unknown as RevocationStore, {
      ttlSeconds: TTL,
    });

    await cache.revoke('session-1');

    await expect(cache.isRevoked('session-1')).resolves.toBe(true);
    await expect(cache.isRevoked('session-2')).resolves.toBe(false);
  });

  it('uses the shared key namespace, so other processes find the same entries', async () => {
    const store = storeSpy();
    const cache = new RevocationCache(store as unknown as RevocationStore, {
      ttlSeconds: TTL,
    });

    await cache.isRevoked('session-9');

    // A module that guessed a different prefix would find no revocations and
    // honour force-logout never — a failure with no symptom at all.
    expect(store.exists).toHaveBeenCalledWith(`${REVOKED_SESSION_KEY_PREFIX}session-9`);
  });

  it('throws rather than answering "not revoked" when the store is down', async () => {
    const store = storeSpy();
    store.exists.mockRejectedValue(new Error('redis unavailable'));
    const cache = new RevocationCache(store as unknown as RevocationStore, {
      ttlSeconds: TTL,
    });

    // The distinction this preserves: a *miss* means not revoked, an *error*
    // means unknown. Collapsing the two would silently un-revoke every session
    // in the system for the duration of an outage.
    await expect(cache.isRevoked('session-1')).rejects.toThrow('redis unavailable');
  });
});
