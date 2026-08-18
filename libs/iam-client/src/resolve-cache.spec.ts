import type { ResolvedGrants } from '@plantops/contracts';

import { ResolveCache } from './resolve-cache.js';

const grants = (...permissions: string[]): ResolvedGrants => ({
  permissions,
  scopes: Object.fromEntries(permissions.map((key) => [key, ['n_root']])),
});

const clock = (start = 1_700_000_000_000) => {
  let value = start;
  return {
    now: () => value,
    advanceSeconds: (seconds: number) => {
      value += seconds * 1000;
    },
  };
};

describe('ResolveCache', () => {
  it('resolves once and serves the answer while it is fresh', async () => {
    const load = jest.fn(async () => grants('iam.client.user.read'));
    const cache = new ResolveCache(load, { ttlSeconds: 60 });

    expect(await cache.get()).toEqual(grants('iam.client.user.read'));
    expect(await cache.get()).toEqual(grants('iam.client.user.read'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('re-resolves once the TTL has passed', async () => {
    const time = clock();
    const load = jest.fn(async () => grants('a'));
    const cache = new ResolveCache(load, { ttlSeconds: 60, now: time.now });

    await cache.get();
    time.advanceSeconds(59);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);

    time.advanceSeconds(2);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keys on applicationId, so one slice is never served for another', async () => {
    const load = jest.fn(async (query: { applicationId?: string }) =>
      grants(query.applicationId ?? 'all'),
    );
    const cache = new ResolveCache(load);

    expect((await cache.get({ applicationId: 'app-1' })).permissions).toEqual(['app-1']);
    expect((await cache.get({ applicationId: 'app-2' })).permissions).toEqual(['app-2']);
    expect((await cache.get()).permissions).toEqual(['all']);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('collapses a burst into a single resolve', async () => {
    let resolveLoad!: (grants: ResolvedGrants) => void;
    const load = jest.fn(
      () =>
        new Promise<ResolvedGrants>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const cache = new ResolveCache(load);

    const flights = [cache.get(), cache.get(), cache.get()];
    resolveLoad(grants('a'));

    for (const result of await Promise.all(flights)) {
      expect(result.permissions).toEqual(['a']);
    }
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('caches nothing when the resolve failed', async () => {
    const load = jest.fn(async () => grants('a'));
    load.mockRejectedValueOnce(new Error('down'));
    const cache = new ResolveCache(load);

    await expect(cache.get()).rejects.toThrow('down');
    expect((await cache.get()).permissions).toEqual(['a']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reload() ignores a fresh entry and replaces it', async () => {
    const load = jest.fn(async () => grants('after'));
    load.mockResolvedValueOnce(grants('before'));
    const cache = new ResolveCache(load);

    await cache.get();
    expect((await cache.reload()).permissions).toEqual(['after']);
    expect((await cache.get()).permissions).toEqual(['after']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidate(appId) drops that slice and nothing else', async () => {
    const load = jest.fn(async (query: { applicationId?: string }) =>
      grants(query.applicationId ?? 'all'),
    );
    const cache = new ResolveCache(load);
    await cache.get({ applicationId: 'app-1' });
    await cache.get();

    cache.invalidate('app-1');
    await cache.get({ applicationId: 'app-1' });
    await cache.get();

    expect(load).toHaveBeenCalledTimes(3);
  });

  it('invalidate() with no argument drops everything', async () => {
    const load = jest.fn(async () => grants('a'));
    const cache = new ResolveCache(load);
    await cache.get();
    await cache.get({ applicationId: 'app-1' });

    cache.invalidate();
    await cache.get();
    await cache.get({ applicationId: 'app-1' });

    expect(load).toHaveBeenCalledTimes(4);
  });

  it('a zero TTL turns caching off without changing any call site', async () => {
    const load = jest.fn(async () => grants('a'));
    const cache = new ResolveCache(load, { ttlSeconds: 0 });

    await cache.get();
    await cache.get();

    expect(load).toHaveBeenCalledTimes(2);
  });
});
