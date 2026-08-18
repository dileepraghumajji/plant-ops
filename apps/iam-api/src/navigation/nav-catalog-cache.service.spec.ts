/**
 * The nav-catalog cache — Doc 05 §6's `app_nav_version`, against an in-memory
 * Redis.
 *
 * The property under test is the same one `grants-cache.service.spec.ts` exists
 * for, one table over: **can a catalog written before an edit ever be served
 * after one?** Everything else here is protocol — which keys, what stamp, which
 * failures fall back to Postgres — and none of it is a claim about ioredis, so a
 * real server would only make the suite slower.
 *
 * The fake is behavioural rather than a stub: it stores values, honours `INCR`,
 * and records the TTL it was handed, so each assertion is about observable state.
 * Its shape is deliberately the grants cache's, because the two services speak
 * the same protocol and a divergence between the doubles would hide a divergence
 * between the implementations.
 */

import { NavCatalogCacheService, NAV_CATALOG_TTL_SECONDS } from './nav-catalog-cache.service';
import type { NavCatalog } from './prune';

const APPLICATION_ID = '00000000-0000-4000-8000-0000000000a1';
const KEY = `nav:${APPLICATION_ID}`;
const VERSION_KEY = `${KEY}:v`;

const CATALOG: NavCatalog = {
  nodes: [
    {
      id: '00000000-0000-4000-8000-0000000000n1',
      parent_id: null,
      kind: 'menu',
      key: 'ops.dc',
      label: 'Delivery Challans',
      route: '/dc',
      icon: 'truck',
      is_public: false,
    },
  ],
  gates: { '00000000-0000-4000-8000-0000000000n1': ['gatepass.dc.read'] },
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
            this.values.set(key, String(Number(this.values.get(key) ?? '0') + 1));
          });
          return chain;
        },
        expire: (key: string, ttl: number) => {
          queued.push(() => {
            // Redis ignores `EXPIRE` on a missing key; so does this, which is
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

function createCache(): { cache: NavCatalogCacheService; redis: FakeRedis } {
  const redis = new FakeRedis();
  return {
    cache: new NavCatalogCacheService(redis as unknown as never),
    redis,
  };
}

describe('nav catalog cache (Doc 05 §6)', () => {
  it('reports a miss, with a version to write under, on an empty cache', () => {
    const { cache } = createCache();

    return expect(cache.read(APPLICATION_ID)).resolves.toEqual({
      catalog: null,
      version: 0,
    });
  });

  it('serves back exactly what was written, keyed by application', async () => {
    const { cache, redis } = createCache();

    await cache.write(APPLICATION_ID, CATALOG, 0);

    // One entry per application and nothing tenant-specific in the key: these
    // are catalog tables (migrations 0008–0009), so the same entry serves every
    // tenant and enablement is decided elsewhere.
    expect(redis.values.has(KEY)).toBe(true);
    await expect(cache.read(APPLICATION_ID)).resolves.toEqual({
      catalog: CATALOG,
      version: 0,
    });
  });

  it('stores the version inside the entry, not beside it', async () => {
    const { cache, redis } = createCache();

    await cache.write(APPLICATION_ID, CATALOG, 7);

    expect(JSON.parse(redis.values.get(KEY) as string)).toEqual({ ...CATALOG, v: 7 });
  });

  it('bounds the entry by its TTL and outlives it with the counter', async () => {
    const { cache, redis } = createCache();

    await cache.bump(APPLICATION_ID);
    await cache.write(APPLICATION_ID, CATALOG, 1);

    expect(redis.ttls.get(KEY)).toBe(NAV_CATALOG_TTL_SECONDS);
    // Were the counter to expire first, a live entry stamped `v: 1` would be
    // compared against a missing counter, read as 0, and discarded — correct, and
    // a cache that has quietly stopped working.
    expect(redis.ttls.get(VERSION_KEY)).toBeGreaterThan(
      redis.ttls.get(KEY) as number,
    );
  });

  it('treats a catalog written before an edit as a miss', async () => {
    const { cache } = createCache();

    await cache.write(APPLICATION_ID, CATALOG, 0);
    await expect(cache.read(APPLICATION_ID)).resolves.toEqual({
      catalog: CATALOG,
      version: 0,
    });

    // Doc 05 §6: a nav-node or `menu_permission` edit bumps
    // `app_nav_version[applicationId]`, and cached trees for that app are stale.
    // The bump never has to find the entry.
    await cache.bump(APPLICATION_ID);

    await expect(cache.read(APPLICATION_ID)).resolves.toEqual({
      catalog: null,
      version: 1,
    });
  });

  it('invalidates an application that was never cached', async () => {
    const { cache } = createCache();

    // `INCR` on a missing counter creates it at 1, already ahead of the `v: 0` an
    // entry written without one carries — so an edit that races the first-ever
    // read still wins.
    await cache.bump(APPLICATION_ID);
    await cache.write(APPLICATION_ID, CATALOG, 0);

    await expect(cache.read(APPLICATION_ID)).resolves.toEqual({
      catalog: null,
      version: 1,
    });
  });

  it('invalidates one application without touching another', async () => {
    const { cache } = createCache();
    const other = '00000000-0000-4000-8000-0000000000a2';

    await cache.write(APPLICATION_ID, CATALOG, 0);
    await cache.write(other, CATALOG, 0);
    await cache.bump(APPLICATION_ID);

    expect((await cache.read(APPLICATION_ID)).catalog).toBeNull();
    expect((await cache.read(other)).catalog).toEqual(CATALOG);
  });

  it('discards an unreadable entry rather than throwing', async () => {
    const { cache, redis } = createCache();

    redis.values.set(KEY, 'not json');

    await expect(cache.read(APPLICATION_ID)).resolves.toEqual({
      catalog: null,
      version: 0,
    });
  });

  it('reports a miss with no version when Redis cannot answer', async () => {
    const { cache, redis } = createCache();

    await cache.write(APPLICATION_ID, CATALOG, 0);
    redis.failing = true;

    // Postgres is authoritative and reachable, so an outage degrades navigation
    // to two queries rather than to an error — and the null version is what stops
    // the caller writing an entry it cannot stamp correctly.
    await expect(cache.read(APPLICATION_ID)).resolves.toEqual({
      catalog: null,
      version: null,
    });
  });

  it('writes nothing when there is no version to stamp', async () => {
    const { cache, redis } = createCache();

    await cache.write(APPLICATION_ID, CATALOG, null);

    expect(redis.values.size).toBe(0);
  });

  it('never throws out of a write or an invalidation', async () => {
    const { cache, redis } = createCache();
    redis.failing = true;

    // Both run after their transaction has committed. A cache that could fail a
    // completed manifest upload would make Redis load-bearing for rows that have
    // already landed.
    await expect(cache.write(APPLICATION_ID, CATALOG, 0)).resolves.toBeUndefined();
    await expect(cache.bump(APPLICATION_ID)).resolves.toBeUndefined();
  });
});
