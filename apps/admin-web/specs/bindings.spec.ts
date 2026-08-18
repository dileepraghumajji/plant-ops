import type { RoleBindingDTO, ServiceAccountDTO, UserDTO } from '@plantops/contracts';
import { SubjectType, UserStatus } from '@plantops/contracts';

import {
  NO_FILTERS,
  hasFilters,
  parseSubjectKey,
  subjectKey,
  subjectOptions,
  toBindingsQuery,
  toCreateRequest,
  unbindConsequences,
  type AssignmentDraft,
} from '../src/lib/bindings';

function user(
  overrides: Partial<UserDTO> & Pick<UserDTO, 'id' | 'full_name'>,
): UserDTO {
  return {
    client_id: 'c1',
    email: `${overrides.id}@acme.test`,
    phone: null,
    status: UserStatus.ACTIVE,
    is_client_admin: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function account(
  overrides: Partial<ServiceAccountDTO> & Pick<ServiceAccountDTO, 'id' | 'name'>,
): ServiceAccountDTO {
  return {
    client_id: 'c1',
    account_key: `${overrides.id}-key`,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const DRAFT: AssignmentDraft = {
  subject: 'user:u1',
  roleId: 'r1',
  scopeNodeId: 'n1',
  expiresAtLocal: '',
};

describe('the subject key', () => {
  it('round-trips both kinds', () => {
    expect(parseSubjectKey(subjectKey(SubjectType.USER, 'u1'))).toEqual({
      type: 'user',
      id: 'u1',
    });
    expect(parseSubjectKey(subjectKey(SubjectType.SERVICE, 's1'))).toEqual({
      type: 'service',
      id: 's1',
    });
  });

  it('refuses anything it did not write', () => {
    expect(parseSubjectKey('u1')).toBeNull();
    expect(parseSubjectKey(':u1')).toBeNull();
    expect(parseSubjectKey('user:')).toBeNull();
    expect(parseSubjectKey('robot:u1')).toBeNull();
  });

  it('keeps an id containing a colon intact', () => {
    // Splits on the first separator, not on every one — the id is opaque.
    expect(parseSubjectKey('user:a:b')).toEqual({ type: 'user', id: 'a:b' });
  });
});

describe('the subject list', () => {
  it('puts people before machines, each group by name', () => {
    const options = subjectOptions(
      [user({ id: 'u2', full_name: 'Zara' }), user({ id: 'u1', full_name: 'Arun' })],
      [account({ id: 's2', name: 'Nightly sync' }), account({ id: 's1', name: 'Gate feed' })],
    );

    expect(options.map((o) => o.label)).toEqual([
      'Arun',
      'Zara',
      'Gate feed',
      'Nightly sync',
    ]);
  });

  it('offers an inactive subject, marked rather than withheld', () => {
    // The grant is legal and takes effect if they are reactivated; hiding the
    // option would make a legitimate pre-provisioning grant impossible.
    const options = subjectOptions(
      [user({ id: 'u1', full_name: 'Arun', status: UserStatus.DISABLED })],
      [account({ id: 's1', name: 'Old feed', status: 'revoked' })],
    );

    expect(options.map((o) => o.inert)).toEqual([true, true]);
  });

  it('carries the searchable second line', () => {
    const [person, machine] = subjectOptions(
      [user({ id: 'u1', full_name: 'Arun' })],
      [account({ id: 's1', name: 'Gate feed' })],
    );

    expect(person.detail).toBe('u1@acme.test');
    expect(machine.detail).toBe('s1-key');
  });
});

describe('turning a draft into a grant', () => {
  it('splits the subject into the XOR the body takes', () => {
    expect(toCreateRequest(DRAFT)).toEqual({
      ok: true,
      request: { user_id: 'u1', role_id: 'r1', scope_node_id: 'n1' },
    });

    expect(toCreateRequest({ ...DRAFT, subject: 'service:s1' })).toEqual({
      ok: true,
      request: { service_account_id: 's1', role_id: 'r1', scope_node_id: 'n1' },
    });
  });

  it('never sends both subject columns', () => {
    const built = toCreateRequest(DRAFT);
    if (!built.ok) throw new Error('expected a request');

    expect('service_account_id' in built.request).toBe(false);
  });

  it('refuses a grant with no scope, like one with no subject', () => {
    // Doc 09 §3.4: no grant without choosing where. Scope is half of what the
    // grant means, not a qualifier on it.
    const built = toCreateRequest({ ...DRAFT, scopeNodeId: null });

    expect(built).toMatchObject({ ok: false, field: 'scopeNodeId' });
    if (!built.ok) expect(built.problem).toMatch(/where/i);
  });

  it('asks for each missing piece in turn', () => {
    expect(toCreateRequest({ ...DRAFT, subject: null })).toMatchObject({
      field: 'subject',
    });
    expect(toCreateRequest({ ...DRAFT, roleId: null })).toMatchObject({
      field: 'roleId',
    });
  });

  it('omits expires_at entirely for a grant that does not expire', () => {
    const built = toCreateRequest(DRAFT);
    if (!built.ok) throw new Error('expected a request');

    expect('expires_at' in built.request).toBe(false);
  });

  it('converts a local wall-clock expiry to an instant', () => {
    // A `datetime-local` value has no zone. Sending it raw would land "5 pm" at
    // 5 pm UTC, which for an operator in Chennai ends someone's access five and
    // a half hours early.
    const local = '2030-06-01T17:00';
    const built = toCreateRequest({ ...DRAFT, expiresAtLocal: local });

    if (!built.ok) throw new Error('expected a request');
    expect(built.request.expires_at).toBe(new Date(local).toISOString());
  });

  it('refuses an expiry that has already passed', () => {
    const built = toCreateRequest({ ...DRAFT, expiresAtLocal: '2020-01-01T00:00' });

    expect(built).toMatchObject({ ok: false, field: 'expiresAtLocal' });
  });

  it('refuses a date it cannot read', () => {
    expect(toCreateRequest({ ...DRAFT, expiresAtLocal: 'soon' })).toMatchObject({
      ok: false,
      field: 'expiresAtLocal',
    });
  });
});

describe('the list filters', () => {
  it('sends nothing when nothing is chosen', () => {
    expect(toBindingsQuery(NO_FILTERS)).toEqual({});
    expect(hasFilters(NO_FILTERS)).toBe(false);
  });

  it('splits the subject the same way the create body does', () => {
    expect(toBindingsQuery({ ...NO_FILTERS, subject: 'user:u1' })).toEqual({
      user_id: 'u1',
    });
    expect(toBindingsQuery({ ...NO_FILTERS, subject: 'service:s1' })).toEqual({
      service_account_id: 's1',
    });
  });

  it('combines every filter', () => {
    expect(
      toBindingsQuery({ subject: 'user:u1', roleId: 'r1', scopeNodeId: 'n1' }),
    ).toEqual({ user_id: 'u1', role_id: 'r1', scope_node_id: 'n1' });
  });

  it('notices that something is filtered', () => {
    expect(hasFilters({ ...NO_FILTERS, roleId: 'r1' })).toBe(true);
  });
});

describe('what an unbind takes away', () => {
  const grant: RoleBindingDTO = {
    id: 'b1',
    client_id: 'c1',
    subject_type: SubjectType.USER,
    subject_id: 'u1',
    subject_name: 'Arun Patel',
    subject_email: 'arun@acme.test',
    role_id: 'r1',
    role_name: 'Gate Supervisor',
    scope_node_id: 'n1',
    scope_node_name: 'Plant B',
    scope_node_path: 'n_acme.n_pb',
    expires_at: null,
    expired: false,
    created_at: '2026-01-01T00:00:00.000Z',
  };

  it('names all three parts of the grant', () => {
    // Confirming "remove access" without being told which access, for whom and
    // where is confirming a row number.
    const sentence = unbindConsequences(grant);

    expect(sentence).toContain('Arun Patel');
    expect(sentence).toContain('Gate Supervisor');
    expect(sentence).toContain('Plant B');
    expect(sentence).toContain('everything beneath it');
  });

  it('says a lapsed grant changes nothing today', () => {
    const sentence = unbindConsequences({ ...grant, expired: true });

    expect(sentence).toMatch(/already lapsed/i);
    expect(sentence).not.toMatch(/lose it within/i);
  });
});
