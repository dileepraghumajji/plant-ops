/**
 * What the resolver does *around* the query (Doc 04 §4–6).
 *
 * The SQL itself is proved against a real Postgres in
 * `authz.integration.spec.ts`; a fake manager can only assert that a statement
 * was sent, not that it returns the right rows. What this file pins is
 * everything the query cannot say for itself:
 *
 * - **The cache-hit path is database-free.** Session 21's Definition of Done in
 *   as many words, and unprovable from the integration suite, where a hit and a
 *   miss return the same body. Here the manager counts, so a hit that quietly
 *   resolved anyway is a failing test rather than a slower deployment.
 * - **The entry is written under the version observed before the resolve.** The
 *   ordering that makes a racing invalidation degrade to a wasted round-trip
 *   instead of to stale grants being stamped current.
 * - **The subject column follows `sty`**, so a service account's bindings are
 *   never read out of `user_id`.
 * - **`?applicationId=` never touches the cache**, in either direction.
 */

import { SubjectType, type ResolvedGrants } from '@plantops/contracts';
import type { EntityManager } from 'typeorm';
import type { CacheRead, GrantsCacheService } from './grants-cache.service';
import { ResolverService, type SubjectRef } from './resolver.service';

const USER: SubjectRef = {
  clientId: '00000000-0000-4000-8000-0000000000c1',
  type: SubjectType.USER,
  id: '00000000-0000-4000-8000-0000000000a1',
};

const SERVICE: SubjectRef = { ...USER, type: SubjectType.SERVICE };

const APPROVE = 'gatepass.dc.approve';

/** Records every statement and replays queued result sets, in order. */
class FakeManager {
  readonly queries: { sql: string; parameters?: unknown[] }[] = [];
  readonly rows: unknown[][] = [];

  readonly manager = {
    query: (sql: string, parameters?: unknown[]): Promise<unknown[]> => {
      this.queries.push({ sql, parameters });
      return Promise.resolve(this.rows.shift() ?? []);
    },
  } as unknown as EntityManager;
}

/** A cache whose reads a test dictates and whose writes it can inspect. */
class FakeCache {
  next: CacheRead = { grants: null, version: 0 };
  readonly reads: SubjectRef[] = [];
  readonly writes: { grants: ResolvedGrants; version: number | null }[] = [];
  readonly bumps: SubjectRef[] = [];
  /** Set to move the counter on while the resolve is in flight. */
  onRead: (() => void) | null = null;

  read = async (subject: SubjectRef): Promise<CacheRead> => {
    this.reads.push(subject);
    // Snapshot first: `onRead` stands in for an invalidation landing *after*
    // this read has answered, which is the race the version scheme is about.
    const answer = this.next;
    this.onRead?.();
    return answer;
  };

  write = async (
    _subject: SubjectRef,
    grants: ResolvedGrants,
    version: number | null,
  ): Promise<void> => {
    this.writes.push({ grants, version });
  };

  bump = async (subject: SubjectRef): Promise<void> => {
    this.bumps.push(subject);
  };
}

function createResolver(): {
  resolver: ResolverService;
  database: FakeManager;
  cache: FakeCache;
} {
  const cache = new FakeCache();
  const database = new FakeManager();
  return {
    resolver: new ResolverService(cache as unknown as GrantsCacheService),
    database,
    cache,
  };
}

describe('resolve — the query it sends', () => {
  it('reads a user’s bindings out of `user_id`', async () => {
    const { resolver, database } = createResolver();

    await resolver.resolve(database.manager, USER);

    const [{ sql, parameters }] = database.queries;
    expect(sql).toContain('rb.user_id = $2');
    expect(sql).not.toContain('rb.service_account_id');
    expect(parameters).toEqual([USER.clientId, USER.id]);
  });

  it('reads a service account’s out of `service_account_id`', async () => {
    const { resolver, database } = createResolver();

    await resolver.resolve(database.manager, SERVICE);

    expect(database.queries[0].sql).toContain('rb.service_account_id = $2');
  });

  it('excludes expired bindings by the database’s clock', async () => {
    const { resolver, database } = createResolver();

    await resolver.resolve(database.manager, USER);

    // `now()`, not a timestamp this process computed: `bindings.service.ts`
    // flags a row as expired the same way, and the two views of one binding
    // must not disagree because two machines' clocks do (Doc 01 §4.5).
    expect(database.queries[0].sql).toContain(
      'rb.expires_at is null or rb.expires_at > now()',
    );
  });

  it('excludes inert permissions and applications a tenant cannot use', async () => {
    const { resolver, database } = createResolver();

    await resolver.resolve(database.manager, USER);

    const { sql } = database.queries[0];
    // Doc 04 §7's rows read forwards, as conditions: a soft-deactivated
    // permission (Doc 02 §7), a platform-wide deactivated application, and one
    // never enabled — or since disabled — for this client (Doc 02 §6).
    expect(sql).toContain('p.is_active');
    expect(sql).toContain('a.is_active');
    expect(sql).toContain('ca.enabled');
  });

  it('narrows to one application only when asked', async () => {
    const { resolver, database } = createResolver();

    await resolver.resolve(database.manager, USER);
    expect(database.queries[0].sql).not.toContain('p.application_id =');

    await resolver.resolve(database.manager, USER, { applicationId: 'app-1' });
    expect(database.queries[1].sql).toContain('p.application_id = $3');
    expect(database.queries[1].parameters).toEqual([USER.clientId, USER.id, 'app-1']);
  });

  it('assembles minimized grants from the rows it gets back', async () => {
    const { resolver, database } = createResolver();

    database.rows.push([
      { permission_key: APPROVE, scope_path: 'g.pa' },
      { permission_key: APPROVE, scope_path: 'g.pa.gate1' },
    ]);

    await expect(resolver.resolve(database.manager, USER)).resolves.toEqual({
      permissions: [APPROVE],
      scopes: { [APPROVE]: ['g.pa'] },
    });
  });
});

describe('grantsFor — the cached read-through', () => {
  it('answers a cache hit without touching the database', async () => {
    const { resolver, database, cache } = createResolver();
    const grants = { permissions: [APPROVE], scopes: { [APPROVE]: ['g.pa'] } };
    cache.next = { grants, version: 3 };

    await expect(resolver.grantsFor(database.manager, USER)).resolves.toBe(grants);

    // The Definition of Done, stated as an assertion: zero statements.
    expect(database.queries).toEqual([]);
    expect(cache.writes).toEqual([]);
  });

  it('resolves and populates on a miss', async () => {
    const { resolver, database, cache } = createResolver();
    cache.next = { grants: null, version: 5 };
    database.rows.push([{ permission_key: APPROVE, scope_path: 'g.pa' }]);

    const grants = await resolver.grantsFor(database.manager, USER);

    expect(database.queries).toHaveLength(1);
    expect(cache.writes).toEqual([{ grants, version: 5 }]);
  });

  it('writes under the version it read, never one read after the resolve', async () => {
    const { resolver, database, cache } = createResolver();
    cache.next = { grants: null, version: 2 };

    // An invalidation lands while the resolve is in flight. The entry is
    // written stale on purpose: the next read finds `v: 2` behind the counter
    // and misses. Re-reading the counter here would instead stamp pre-change
    // grants as current, which is the failure the scheme exists to prevent.
    cache.onRead = () => {
      cache.next = { grants: null, version: 9 };
    };

    await resolver.grantsFor(database.manager, USER);

    expect(cache.writes).toEqual([{ grants: expect.anything(), version: 2 }]);
  });

  it('does not write an entry it cannot stamp', async () => {
    const { resolver, database, cache } = createResolver();
    cache.next = { grants: null, version: null };

    await resolver.grantsFor(database.manager, USER);

    // Redis was unreachable. The resolve still answers; `write` is given the
    // null version and declines, which is asserted in `grants-cache.service.spec.ts`.
    expect(database.queries).toHaveLength(1);
    expect(cache.writes).toEqual([{ grants: expect.anything(), version: null }]);
  });

  it('keeps the application slice out of the cache in both directions', async () => {
    const { resolver, database, cache } = createResolver();
    cache.next = {
      grants: { permissions: ['other.thing'], scopes: { 'other.thing': ['g'] } },
      version: 1,
    };

    const grants = await resolver.grantsFor(database.manager, USER, {
      applicationId: 'app-1',
    });

    // Doc 04 §6's key has no application component, so a slice has nowhere to
    // live that would not collide with the full set — it is neither served from
    // the cache nor written to it.
    expect(grants).toEqual({ permissions: [], scopes: {} });
    expect(database.queries).toHaveLength(1);
    expect(cache.reads).toEqual([]);
    expect(cache.writes).toEqual([]);
  });
});

describe('check — the point check', () => {
  it('is false for a node that is not this tenant’s, without resolving', async () => {
    const { resolver, database, cache } = createResolver();
    cache.next = {
      grants: { permissions: [APPROVE], scopes: { [APPROVE]: ['g'] } },
      version: 0,
    };
    database.rows.push([]); // the node lookup finds nothing

    await expect(
      resolver.check(database.manager, USER, APPROVE, 'e7a1b2c3-0000-4000-8000-000000000000'),
    ).resolves.toBe(false);

    // One statement — the node lookup. There is nothing to check coverage
    // against, and a 404 here would confirm the node exists somewhere else
    // (Doc 06 §2).
    expect(database.queries).toHaveLength(1);
  });

  it('answers from the cached grants once the node resolves', async () => {
    const { resolver, database, cache } = createResolver();
    cache.next = {
      grants: { permissions: [APPROVE], scopes: { [APPROVE]: ['g.pa'] } },
      version: 0,
    };
    database.rows.push([{ path: 'g.pa.gate1' }]);

    await expect(
      resolver.check(database.manager, USER, APPROVE, '9f2c4a1b-0000-4000-8000-000000000000'),
    ).resolves.toBe(true);

    expect(database.queries).toHaveLength(1);
  });
});
