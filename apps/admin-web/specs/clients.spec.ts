import type { ApplicationDTO, ClientApplicationDTO } from '@plantops/contracts';

import { enabledCount, mergeEnablements, suggestSlug } from '../src/lib/clients';

function application(
  overrides: Partial<ApplicationDTO> & Pick<ApplicationDTO, 'id' | 'key'>,
): ApplicationDTO {
  return {
    name: overrides.key,
    description: null,
    is_active: true,
    config: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function row(
  applicationId: string,
  enabled: boolean,
): ClientApplicationDTO {
  return {
    client_id: 'c1',
    application_id: applicationId,
    application_key: applicationId,
    application_name: applicationId,
    enabled,
    config: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('joining the catalog with a tenant’s enablements', () => {
  const gatepass = application({ id: 'a1', key: 'gatepass', name: 'Gate Pass' });
  const visitor = application({ id: 'a2', key: 'visitor', name: 'Visitor' });
  const retired = application({
    id: 'a3',
    key: 'legacy',
    name: 'Legacy',
    is_active: false,
  });

  it('offers every registered application, not only the ones with a row', () => {
    // The point of the join: `GET /iam/clients/:id/applications` returns rows,
    // and a toggle list has to offer applications the tenant has never had.
    const merged = mergeEnablements([gatepass, visitor], [row('a1', true)]);

    expect(merged.map((entry) => entry.application.id)).toEqual(['a1', 'a2']);
    expect(merged[1].row).toBeNull();
  });

  it('distinguishes “never had it” from “had it, switched off”', () => {
    // The distinction that decides POST vs PATCH: a null row has nothing to
    // patch, and a disabled row must not be inserted again.
    const merged = mergeEnablements([gatepass, visitor], [row('a1', false)]);

    expect(merged.find((e) => e.application.id === 'a1')).toMatchObject({
      enabled: false,
      row: expect.objectContaining({ enabled: false }),
    });
    expect(merged.find((e) => e.application.id === 'a2')?.row).toBeNull();
  });

  it('flags an enabled application that is retired in the registry', () => {
    // Legal, inert, and worth saying: the tenant's switch is on but Doc 02 §7
    // turned the application off for everyone, so the menus will not appear and
    // the reason is not this toggle.
    const merged = mergeEnablements([retired], [row('a3', true)]);

    expect(merged[0].inertBecauseRetired).toBe(true);
  });

  it('does not flag a retired application the tenant never had', () => {
    const merged = mergeEnablements([retired], []);

    expect(merged[0].inertBecauseRetired).toBe(false);
  });

  it('reads as what the tenant runs, then what it could, then what is retired', () => {
    const merged = mergeEnablements(
      [retired, visitor, gatepass],
      [row('a1', true)],
    );

    expect(merged.map((entry) => entry.application.key)).toEqual([
      'gatepass', // enabled
      'visitor', // available
      'legacy', // retired in the registry
    ]);
  });

  it('sorts by name within a group', () => {
    const zeta = application({ id: 'a4', key: 'zeta', name: 'Zeta' });
    const alpha = application({ id: 'a5', key: 'alpha', name: 'Alpha' });

    expect(
      mergeEnablements([zeta, alpha], []).map((entry) => entry.application.name),
    ).toEqual(['Alpha', 'Zeta']);
  });

  it('counts only what is switched on', () => {
    // Matching `ClientDTO.enabled_application_count`, which the list column
    // shows: a disabled row is preserved, not active (Doc 02 §7).
    const merged = mergeEnablements(
      [gatepass, visitor, retired],
      [row('a1', true), row('a2', false)],
    );

    expect(enabledCount(merged)).toBe(1);
  });
});

describe('suggesting a tenant slug', () => {
  it.each([
    ['Acme Steel', 'acme-steel'],
    ['  Acme   Steel  ', 'acme-steel'],
    ['ACME', 'acme'],
    ['Acme & Co.', 'acme-co'],
    ['acme-steel', 'acme-steel'],
    ['Acme---Steel', 'acme-steel'],
  ])('turns %j into %j', (name, expected) => {
    expect(suggestSlug(name)).toBe(expected);
  });

  it('drops what a login keyboard may not have rather than transliterating it', () => {
    // The slug is typed into a sign-in form on whatever keyboard the tenant's
    // users own, so "acme-stål" would be a credential half of them could not
    // enter.
    expect(suggestSlug('Acme Stål')).toBe('acme-st-l');
  });

  it('returns nothing when nothing survives, rather than inventing a slug', () => {
    // Permanent value: better an empty field the operator must fill than a
    // guess they accept without reading.
    expect(suggestSlug('  ')).toBe('');
    expect(suggestSlug('株式会社')).toBe('');
  });

  it('never suggests something the server would refuse', () => {
    const pattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const name of ['Acme Steel', 'A'.repeat(200), 'Acme & Co.', '9 Lives']) {
      const slug = suggestSlug(name);
      expect(slug.length).toBeLessThanOrEqual(64);
      expect(pattern.test(slug)).toBe(true);
    }
  });
});
