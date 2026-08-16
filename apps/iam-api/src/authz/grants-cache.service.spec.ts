/**
 * The versioned grants cache (Doc 04 §6–7).
 *
 * Against an in-memory Redis rather than a real one, because every property
 * under test is a property of *this* service's protocol — which keys it writes,
 * what it stamps them with, and when it declines to trust what it read back.
 * ioredis's own behaviour is not in question; what is in question is whether an
 * entry written before an invalidation can ever be served after one, and that
 * is decided here, in the comparison between `v` and the counter.
 *
 * The fake is behavioural, in the tradition of `testing/app-harness.ts`'s: it
 * stores values, honours `INCR`, and records the TTL it was given, so the
 * assertions are about observable state rather than about calls made.
 */

import { GRANTS_CACHE_TTL_SECONDS, SubjectType, grantsCacheKey } from '@plantops/contracts';
import type { EnvConfig } from '@plantops/config';
import { GrantsCacheService } from './grants-cache.service';
import type { SubjectRef } from './resolver.service';

const SUBJECT: SubjectRef = {
  clientId: '00000000-0000-4000-8000-0000000000c1',
  type: SubjectType.USER,
  id: '00000000-0000-4000-8000-0000000000a1',
};

const KEY = grantsCacheKey(SUBJECT.clientId, SUBJECT.type, SUBJECT.id);
const VERSION_KEY = `${KEY}:v`;

const GRANTS = {
  permissions: ['gatepass.dc.approve'],
  scopes: { 'gatepass.dc.approve': ['g.pa'] },
};

/** Just enough ioredis to run this service, and nothing it does not call. */
class FakeRedis {
  failing = false;
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  readonly client = {
    mget: async (...keys: string[]): Promise<(string | null)[]> => {
      this.assertUp();
      return keys.map((key) => this.values.get(key) ?? null);
    },

    // `pipeline` and `multi` differ in atomicity, not in effect, and nothing
    // this service does depends on the difference — `bumpMany` chose the
    // pipeline precisely because independent `INCR`s need no transaction. One
    // implementation for both keeps the fake from claiming a distinction it does
    // not model.
    pipeline: () => this.client.multi(),

    multi: () => {
      const queued: Array<() => void> = [];
      const chain = {
        set: (key: string, value: string, _mode: 'EX', ttl: number) => {
          queued.push(() => {
            this.values.set(key, value);
            this.ttls.set(key, ttl);
          });
          return chain;
        },
        incr: (key: string) => {
          queued.push(() => {
            const next = Number(this.values.get(key) ?? '0') + 1;
            this.values.set(key, String(next));
          });
          return chain;
        },
        expire: (key: string, ttl: number) => {
          queued.push(() => {
            // Redis ignores EXPIRE on a missing key; so does this, which is
            // what makes the "counter outlives the entry" assertion honest.
            if (this.values.has(key)) this.ttls.set(key, ttl);
          });
          return chain;
        },
        exec: async (): Promise<Array<[Error | null, unknown]>> => {
          this.assertUp();
          queued.forEach((run) => run());
          return queued.map(() => [null, 'OK'] as [Error | null, unknown]);
        },
      };
      return chain;
    },
  };

  private assertUp(): void {
    if (this.failing) throw new Error('redis unavailable');
  }
}

function createCache(): { cache: GrantsCacheService; redis: FakeRedis } {
  const redis = new FakeRedis();
  const env = { GRANTS_CACHE_TTL_SECONDS } as EnvConfig;
  return {
    cache: new GrantsCacheService(env, redis as unknown as never),
    redis,
  };
}

describe('grants cache', () => {
  it('reports a miss, with a version to write under, on an empty cache', () => {
    const { cache } = createCache();

    return expect(cache.read(SUBJECT)).resolves.toEqual({ grants: null, version: 0 });
  });

  it('serves back exactly what was written, under the Doc 04 §6 key', async () => {
    const { cache, redis } = createCache();

    await cache.write(SUBJECT, GRANTS, 0);

    expect(redis.values.has(KEY)).toBe(true);
    await expect(cache.read(SUBJECT)).resolves.toEqual({ grants: GRANTS, version: 0 });
  });

  it('stores the version inside the entry, not beside it', async () => {
    const { cache, redis } = createCache();

    await cache.write(SUBJECT, GRANTS, 7);

    // `CachedGrants` is `ResolvedGrants & { v }` — the contract publishes the
    // stamp as part of the value so a holder can check it without a second read.
    expect(JSON.parse(redis.values.get(KEY) as string)).toEqual({ ...GRANTS, v: 7 });
  });

  it('bounds the entry by the configured TTL and outlives it with the counter', async () => {
    const { cache, redis } = createCache();

    await cache.bump(SUBJECT);
    await cache.write(SUBJECT, GRANTS, 1);

    // ≤10 minutes (Doc 04 §6). The counter's longer TTL is what stops a live
    // entry meeting an expired counter, being compared against 0, and being
    // discarded — a cache that quietly stops working.
    expect(redis.ttls.get(KEY)).toBe(GRANTS_CACHE_TTL_SECONDS);
    expect(redis.ttls.get(VERSION_KEY)).toBeGreaterThan(
      redis.ttls.get(KEY) as number,
    );
  });

  it('treats an entry written before an invalidation as a miss', async () => {
    const { cache } = createCache();

    await cache.write(SUBJECT, GRANTS, 0);
    await expect(cache.read(SUBJECT)).resolves.toEqual({ grants: GRANTS, version: 0 });

    // Doc 04 §7's whole mechanism: the mutation moves the counter and never has
    // to find the entry, let alone enumerate the subjects of a role.
    await cache.bump(SUBJECT);

    await expect(cache.read(SUBJECT)).resolves.toEqual({ grants: null, version: 1 });
  });

  it('invalidates a subject who was never cached', async () => {
    const { cache } = createCache();

    // `INCR` on a missing counter creates it at 1, which is already ahead of
    // the `v: 0` an entry written without one carries. So an invalidation that
    // races the first-ever resolve still wins.
    await cache.bump(SUBJECT);
    await cache.write(SUBJECT, GRANTS, 0);

    await expect(cache.read(SUBJECT)).resolves.toEqual({ grants: null, version: 1 });
  });

  it('discards an unreadable entry rather than throwing', async () => {
    const { cache, redis } = createCache();

    redis.values.set(KEY, 'not json');

    await expect(cache.read(SUBJECT)).resolves.toEqual({ grants: null, version: 0 });
  });

  it('reports a miss with no version when Redis cannot answer', async () => {
    const { cache, redis } = createCache();

    await cache.write(SUBJECT, GRANTS, 0);
    redis.failing = true;

    // Unlike the revocation cache, uncertainty here has a strictly better
    // answer available — Postgres — so an outage degrades to a resolve rather
    // than to a denial. The null version is what stops the caller writing an
    // entry it cannot stamp correctly.
    await expect(cache.read(SUBJECT)).resolves.toEqual({ grants: null, version: null });
  });

  it('writes nothing when there is no version to stamp', async () => {
    const { cache, redis } = createCache();

    await cache.write(SUBJECT, GRANTS, null);

    expect(redis.values.size).toBe(0);
  });

  it('never throws out of a write or an invalidation', async () => {
    const { cache, redis } = createCache();
    redis.failing = true;

    // Both run after their transaction has committed. A cache that could fail
    // a completed unbind would make Redis load-bearing for a write that has
    // already landed.
    await expect(cache.write(SUBJECT, GRANTS, 0)).resolves.toBeUndefined();
    await expect(cache.bump(SUBJECT)).resolves.toBeUndefined();
  });

  it('invalidates a whole role’s worth of subjects in one round-trip', async () => {
    const { cache, redis } = createCache();

    // The fan-out shape of Doc 04 §7's role-level rows: `InvalidationService`
    // resolves "everyone bound to this role" to a subject list and hands it over
    // whole, rather than looping `bump` per person.
    const subjects: SubjectRef[] = Array.from({ length: 4 }, (_, index) => ({
      ...SUBJECT,
      id: `00000000-0000-4000-8000-00000000000${index}`,
    }));

    await cache.bumpMany(subjects);

    for (const subject of subjects) {
      const key = grantsCacheKey(subject.clientId, subject.type, subject.id);
      expect(redis.values.get(`${key}:v`)).toBe('1');
    }
  });

  it('bumps a subject named twice in a batch only once', async () => {
    const { cache, redis } = createCache();

    // One person bound to the same role at three plants is three binding rows
    // and one cache entry. Incrementing three times would be harmless but would
    // mean the batch size tracked bindings rather than subjects.
    await cache.bumpMany([SUBJECT, SUBJECT, SUBJECT]);

    expect(redis.values.get(VERSION_KEY)).toBe('1');
  });

  it('does nothing at all for an empty batch', async () => {
    const { cache, redis } = createCache();

    // A role nobody is bound to still gets its permissions edited. The publish
    // path short-circuits on this too, so an empty fan-out costs no round-trip.
    await cache.bumpMany([]);

    expect(redis.values.size).toBe(0);
  });

  it('never throws out of a batched invalidation either', async () => {
    const { cache, redis } = createCache();
    redis.failing = true;

    await expect(cache.bumpMany([SUBJECT])).resolves.toBeUndefined();
  });

  it('keeps subjects and tenants in separate entries', async () => {
    const { cache, redis } = createCache();

    const other: SubjectRef = { ...SUBJECT, type: SubjectType.SERVICE };
    await cache.write(SUBJECT, GRANTS, 0);
    await cache.write(other, { permissions: [], scopes: {} }, 0);

    expect(redis.values.size).toBe(2);
    await expect(cache.read(other)).resolves.toEqual({
      grants: { permissions: [], scopes: {} },
      version: 0,
    });
  });
});
