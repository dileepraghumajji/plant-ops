import type { UserBindingDTO } from '@plantops/contracts';
import { UserStatus } from '@plantops/contracts';

import {
  STATUS_TABS,
  canSignIn,
  sortBindings,
  statusActions,
  summarizeBindings,
  tabFor,
} from '../src/lib/users';

function binding(
  overrides: Partial<UserBindingDTO> & Pick<UserBindingDTO, 'id' | 'role_name'>,
): UserBindingDTO {
  return {
    role_id: `role-${overrides.id}`,
    scope_node_id: `node-${overrides.id}`,
    scope_node_name: 'Plant A',
    scope_node_path: 'n_acme.n_pa',
    expires_at: null,
    expired: false,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('the account state machine', () => {
  it('offers lock and disable on an active account', () => {
    expect(statusActions(UserStatus.ACTIVE).map((a) => a.label)).toEqual([
      'Lock',
      'Disable',
    ]);
  });

  it('offers only unlock on a locked account', () => {
    // Not "disable" as well: a second stop on an account that is already
    // stopped is not a thing an administrator means, and going from locked to
    // disabled is two decisions that should read as two.
    expect(statusActions(UserStatus.LOCKED).map((a) => a.label)).toEqual(['Unlock']);
  });

  it('offers only reactivate on a disabled account', () => {
    expect(statusActions(UserStatus.DISABLED).map((a) => a.label)).toEqual([
      'Reactivate',
    ]);
  });

  it('marks only disable as dangerous', () => {
    // Locking is reversible and takes nothing away; disabling revokes every
    // session and empties the grants. Rendering both in the danger tone would
    // make the difference invisible.
    const active = statusActions(UserStatus.ACTIVE);
    expect(active.find((a) => a.label === 'Lock')?.danger).toBe(false);
    expect(active.find((a) => a.label === 'Disable')?.danger).toBe(true);
    expect(statusActions(UserStatus.DISABLED)[0].danger).toBe(false);
  });

  it('says what each transition does, and never leaves it blank', () => {
    for (const status of [UserStatus.ACTIVE, UserStatus.LOCKED, UserStatus.DISABLED]) {
      for (const action of statusActions(status)) {
        expect(action.title.length).toBeGreaterThan(0);
        expect(action.consequences.length).toBeGreaterThan(40);
      }
    }
  });

  it('only an active account can sign in', () => {
    expect(canSignIn({ status: UserStatus.ACTIVE })).toBe(true);
    expect(canSignIn({ status: UserStatus.LOCKED })).toBe(false);
    expect(canSignIn({ status: UserStatus.DISABLED })).toBe(false);
  });
});

describe('the status filter', () => {
  it('opens on everyone', () => {
    expect(STATUS_TABS[0].status).toBeUndefined();
    expect(tabFor('nonsense').key).toBe('all');
  });

  it('has a tab per status, and the locked one is the named screen', () => {
    expect(STATUS_TABS.map((tab) => tab.key)).toEqual([
      'all',
      'active',
      'locked',
      'disabled',
    ]);
    // Doc 09 §3.3's "Account Locked Users" view — and the description is where
    // the screen says that unlocking takes nothing away, which is the
    // misreading it exists to prevent.
    expect(tabFor('locked').description).toMatch(/unlock/i);
  });

  it('describes every tab', () => {
    for (const tab of STATUS_TABS) {
      expect(tab.description.length).toBeGreaterThan(20);
    }
  });
});

describe('the bindings panel', () => {
  const live = binding({ id: '1', role_name: 'Gate Supervisor' });
  const alsoLive = binding({
    id: '2',
    role_name: 'Gate Supervisor',
    scope_node_name: 'Plant A - Gate 3',
  });
  const lapsed = binding({
    id: '3',
    role_name: 'Auditor',
    expires_at: '2026-01-01T00:00:00.000Z',
    expired: true,
  });
  const expiring = binding({
    id: '4',
    role_name: 'Contractor',
    expires_at: '2027-01-01T00:00:00.000Z',
  });

  it('lists live grants before lapsed ones', () => {
    expect(sortBindings([lapsed, live]).map((b) => b.id)).toEqual(['1', '3']);
  });

  it('keeps lapsed grants rather than dropping them', () => {
    // Resolution ignores them, and that is exactly why the row has to stay: an
    // expired grant is the answer to "why did this stop working on Friday".
    expect(sortBindings([lapsed])).toHaveLength(1);
  });

  it('breaks ties by role, then by where it applies', () => {
    expect(sortBindings([alsoLive, live]).map((b) => b.id)).toEqual(['1', '2']);
  });

  it('counts what is in effect apart from what is merely held', () => {
    expect(summarizeBindings([live, alsoLive, lapsed, expiring])).toEqual({
      live: 3,
      expired: 1,
      expiring: 1,
    });
  });

  it('counts a never-expiring grant as live but not expiring', () => {
    expect(summarizeBindings([live])).toEqual({ live: 1, expired: 0, expiring: 0 });
  });

  it('reports nothing for someone with no access', () => {
    expect(summarizeBindings([])).toEqual({ live: 0, expired: 0, expiring: 0 });
  });
});
