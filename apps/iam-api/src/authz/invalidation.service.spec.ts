/**
 * The invalidation mechanism, without a database (Doc 04 §7).
 *
 * Two properties live here and nowhere else, because both are about *this*
 * service rather than about any caller:
 *
 * 1. **The event granularity.** {@link eventsFor} is a pure function of the
 *    cause, and the rule it encodes — role-level causes publish a `roleId`,
 *    tenant-level causes publish a bare `clientId`, everything else publishes
 *    per subject — is the contract other processes' cache holders read. Testing
 *    it through Redis would prove a mock was called; testing it directly proves
 *    the mapping.
 *
 * 2. **The failure behaviour.** Every caller is a post-commit callback, so this
 *    must never throw, and the local bump must happen even when the publish
 *    cannot. That ordering is what makes the administrator who just made a
 *    change see it on their next request (Doc 04 §7.1 rule 4) regardless of
 *    whether the fan-out to other replicas got out.
 *
 * The *matrix* — that each row of §7's table actually reaches this service, with
 * the right subjects, after commit — is `invalidation.integration.spec.ts`'s.
 * It needs real rows and a real transaction, and no fake can stand in for
 * "captured before the cascade deleted them".
 */

import { PERMS_INVALIDATED_CHANNEL, SubjectType } from '@plantops/contracts';
import type { GrantsCacheService } from './grants-cache.service';
import {
  GrantInvalidationService,
  eventsFor,
  type AffectedSubject,
  type InvalidationReason,
  type TenantSubject,
} from './invalidation.service';

const CLIENT = '00000000-0000-4000-8000-0000000000c1';
const ALICE: AffectedSubject = {
  type: SubjectType.USER,
  id: '00000000-0000-4000-8000-0000000000a1',
};
const BOT: AffectedSubject = {
  type: SubjectType.SERVICE,
  id: '00000000-0000-4000-8000-0000000000b1',
};

/** Records what was published, and can be made to fail. */
class FakeRedis {
  failing = false;
  readonly published: { channel: string; message: string }[] = [];

  readonly client = {
    pipeline: () => {
      const queued: { channel: string; message: string }[] = [];
      const chain = {
        publish: (channel: string, message: string) => {
          queued.push({ channel, message });
          return chain;
        },
        exec: async (): Promise<unknown[]> => {
          if (this.failing) throw new Error('redis unavailable');
          this.published.push(...queued);
          return queued.map(() => [null, 1]);
        },
      };
      return chain;
    },
  };

  channel(name: string): string {
    return `test:${name}`;
  }
}

function createService(): {
  service: GrantInvalidationService;
  redis: FakeRedis;
  bumped: TenantSubject[][];
} {
  const redis = new FakeRedis();
  const bumped: TenantSubject[][] = [];
  const cache = {
    bumpMany: async (subjects: TenantSubject[]) => {
      bumped.push(subjects);
    },
  } as unknown as GrantsCacheService;

  return {
    service: new GrantInvalidationService(cache, redis as unknown as never),
    redis,
    bumped,
  };
}

const messages = (redis: FakeRedis) =>
  redis.published.map((entry) => JSON.parse(entry.message) as Record<string, unknown>);

describe('perms.invalidated event granularity', () => {
  const subjects = [ALICE, BOT];

  it.each([
    ['role_permission.changed', { cause: 'role_permission.changed', roleId: 'r1' }],
    ['role.deleted', { cause: 'role.deleted', roleId: 'r1' }],
  ])('publishes one role-level event for %s', (_name, reason) => {
    // The contract's `roleId` form (Doc 04 §7): a subscriber drops the role's
    // subjects without being told who they are, which is the whole reason §7
    // offers a role-level shape at all.
    expect(eventsFor(CLIENT, subjects, reason as InvalidationReason)).toEqual([
      { clientId: CLIENT, roleId: 'r1' },
    ]);
  });

  it('publishes one tenant-level event for an application toggle', () => {
    // Enabling or disabling an application moves every permission it owns for
    // everyone. A per-subject list here would be a long message saying what one
    // message says.
    expect(
      eventsFor(CLIENT, subjects, {
        cause: 'client_application.toggled',
        applicationId: 'app-1',
      }),
    ).toEqual([{ clientId: CLIENT }]);
  });

  it.each([
    ['scope_node.moved', { cause: 'scope_node.moved', scopeNodeId: 'n1' }],
    ['user.locked', { cause: 'user.locked', userId: ALICE.id }],
    ['user.disabled', { cause: 'user.disabled', userId: ALICE.id }],
    [
      'service_account.revoked',
      { cause: 'service_account.revoked', serviceAccountId: BOT.id },
    ],
    ['role_binding.created', { cause: 'role_binding.created', bindingId: 'b1' }],
    ['role_binding.deleted', { cause: 'role_binding.deleted', bindingId: 'b1' }],
    ['role_binding.expired', { cause: 'role_binding.expired', bindingId: 'b1' }],
    [
      'permission.deactivated',
      { cause: 'permission.deactivated', applicationId: 'app-1', permissionKeys: ['k'] },
    ],
  ])('publishes one event per subject for %s', (_name, reason) => {
    // These causes name either one subject or a set with no coarser description
    // than its members — a moved subtree's bindings, a deactivated permission's
    // holders.
    expect(eventsFor(CLIENT, subjects, reason as InvalidationReason)).toEqual([
      { clientId: CLIENT, subjectId: ALICE.id, subjectType: SubjectType.USER },
      { clientId: CLIENT, subjectId: BOT.id, subjectType: SubjectType.SERVICE },
    ]);
  });
});

describe('GrantInvalidationService.publish', () => {
  it('bumps the local cache and publishes to the shared channel', async () => {
    const { service, redis, bumped } = createService();

    await service.publish(CLIENT, [ALICE], {
      cause: 'role_binding.created',
      bindingId: 'b1',
    });

    expect(bumped).toEqual([[{ clientId: CLIENT, type: SubjectType.USER, id: ALICE.id }]]);
    // Prefixed, because ioredis's `keyPrefix` does not rewrite channel names —
    // two deployments on one managed Redis would otherwise cross-invalidate.
    expect(redis.published[0]?.channel).toBe(`test:${PERMS_INVALIDATED_CHANNEL}`);
  });

  it('does nothing at all when no subject is affected', async () => {
    const { service, redis, bumped } = createService();

    // A role nobody holds, a subtree with no bindings in it. The short-circuit
    // is what keeps the common "administrator tidies up an unused role" case
    // from costing a round-trip.
    await service.publish(CLIENT, [], { cause: 'role.deleted', roleId: 'r1' });

    expect(bumped).toEqual([]);
    expect(redis.published).toEqual([]);
  });

  it('bumps before it publishes, and still bumps when the publish fails', async () => {
    const { service, redis, bumped } = createService();
    redis.failing = true;

    await expect(
      service.publish(CLIENT, [ALICE], { cause: 'user.locked', userId: ALICE.id }),
    ).resolves.toBeUndefined();

    // The half that fixes *this* deployment ran. Doc 04 §7.1 rule 4 requires the
    // administrator who made the change to miss their own cache; that is the
    // bump, not the publish, and it must not be hostage to the fan-out.
    expect(bumped).toHaveLength(1);
    expect(redis.published).toEqual([]);
  });

  it('never throws, because every caller is a post-commit callback', async () => {
    const { service, redis } = createService();
    redis.failing = true;

    // The write has already committed by the time this runs. A throw here would
    // turn a successful unbind into a 500 on a request whose database work
    // succeeded — and `TenantContextInterceptor` would log it with no way to
    // undo the commit.
    await expect(
      service.publish(CLIENT, [ALICE, BOT], {
        cause: 'scope_node.moved',
        scopeNodeId: 'n1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('GrantInvalidationService.publishAcrossTenants', () => {
  const OTHER_CLIENT = '00000000-0000-4000-8000-0000000000c2';

  it('groups subjects by tenant and publishes once per client', async () => {
    const { service, redis, bumped } = createService();

    // Only `permission.deactivated` reaches this: a manifest re-upload is a
    // platform action against an application many tenants may have enabled, so
    // the roles mapping the retired key belong to several clients at once.
    await service.publishAcrossTenants(
      [
        { ...ALICE, clientId: CLIENT },
        { ...BOT, clientId: OTHER_CLIENT },
        { ...BOT, clientId: CLIENT },
      ],
      { cause: 'permission.deactivated', applicationId: 'app-1', permissionKeys: ['k'] },
    );

    // Two publishes, not three: the two subjects in `CLIENT` travel together,
    // because a cache key is `perms:{clientId}:…` and an event carries one
    // `clientId` — neither has a cross-tenant form.
    expect(bumped).toHaveLength(2);
    expect(bumped[0]).toHaveLength(2);
    expect(bumped[1]).toHaveLength(1);

    expect(messages(redis)).toEqual([
      { clientId: CLIENT, subjectId: ALICE.id, subjectType: SubjectType.USER },
      { clientId: CLIENT, subjectId: BOT.id, subjectType: SubjectType.SERVICE },
      { clientId: OTHER_CLIENT, subjectId: BOT.id, subjectType: SubjectType.SERVICE },
    ]);
  });

  it('is a no-op for an empty set', async () => {
    const { service, redis, bumped } = createService();

    // A permission that no role anywhere maps — the common case for a manifest
    // that retires a key nobody adopted.
    await service.publishAcrossTenants([], {
      cause: 'permission.deactivated',
      applicationId: 'app-1',
      permissionKeys: ['k'],
    });

    expect(bumped).toEqual([]);
    expect(redis.published).toEqual([]);
  });
});
