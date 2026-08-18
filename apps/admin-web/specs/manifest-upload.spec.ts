import type { ApplicationManifest, ManifestDiff } from '@plantops/contracts';

import {
  diffTotals,
  diffsMatch,
  flattenManifestNav,
  hasDeactivations,
  indexManifest,
  parseManifestDocument,
} from '../src/lib/manifest-upload';

/** Doc 02 §2's example manifest, as a document rather than as an object graph. */
const MANIFEST: ApplicationManifest = {
  key: 'gatepass',
  name: 'Gate Pass',
  permissions: [
    { key: 'gatepass.dc.create', name: 'Create DC' },
    { key: 'gatepass.dc.approve', name: 'Approve DC' },
  ],
  nav: [
    {
      kind: 'module',
      key: 'gatepass',
      label: 'Gate Pass',
      icon: 'truck',
      children: [
        {
          kind: 'menu',
          key: 'dc.create',
          label: 'New DC',
          route: '/gatepass/new',
          requires: ['gatepass.dc.create'],
        },
        {
          kind: 'menu',
          key: 'dc.approvals',
          label: 'Approvals',
          route: '/gatepass/approvals',
          requires: ['gatepass.dc.approve'],
        },
      ],
    },
  ],
};

const emptyDiff = (): ManifestDiff => ({
  application: { key: 'gatepass', changed: [] },
  permissions: { created: [], updated: [], deactivated: [] },
  nav: { created: [], updated: [], deactivated: [] },
  menu_permissions: { mapped: [], unmapped: [] },
});

describe('reading a pasted manifest', () => {
  it('accepts a document and hands back the parsed manifest', () => {
    const result = parseManifestDocument(JSON.stringify(MANIFEST));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.key).toBe('gatepass');
  });

  it('says so when the text is not JSON at all', () => {
    // The one failure the server cannot describe usefully: it never received a
    // document to complain about.
    const result = parseManifestDocument('{ "key": "gatepass",, }');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/not valid JSON/i);
  });

  it('refuses an empty box rather than posting one', () => {
    expect(parseManifestDocument('   ').ok).toBe(false);
  });

  it('refuses a JSON array — a manifest is an object', () => {
    expect(parseManifestDocument('[]').ok).toBe(false);
  });

  it('refuses a document with no key, because there is nothing to address', () => {
    const result = parseManifestDocument(
      JSON.stringify({ name: 'Gate Pass', permissions: [], nav: [] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/key/);
  });

  it('leaves everything else to the server', () => {
    // A manifest whose `requires` names an undeclared permission is invalid, and
    // `manifest.dto.ts` is the only place that says so. If this ever starts
    // failing here, the console has grown a second opinion about what a valid
    // manifest is.
    const result = parseManifestDocument(
      JSON.stringify({
        key: 'gatepass',
        name: 'Gate Pass',
        permissions: [],
        nav: [{ kind: 'menu', key: 'x', label: 'X', requires: ['nope'] }],
      }),
    );

    expect(result.ok).toBe(true);
  });
});

describe('indexing a manifest for its diff', () => {
  it('flattens the nav tree parents-first', () => {
    expect(flattenManifestNav(MANIFEST.nav).map((node) => node.key)).toEqual([
      'gatepass',
      'dc.create',
      'dc.approvals',
    ]);
  });

  it('finds a permission and a nested nav node by key', () => {
    const index = indexManifest(MANIFEST);

    expect(index.permissions.get('gatepass.dc.approve')?.name).toBe('Approve DC');
    expect(index.nav.get('dc.approvals')?.route).toBe('/gatepass/approvals');
  });

  it('has nothing to say about a deactivated key, by definition', () => {
    // A key is deactivated *because* the manifest stopped declaring it, so the
    // screen shows the bare key for those rows.
    expect(indexManifest(MANIFEST).permissions.get('gatepass.gate.verify')).toBeUndefined();
  });
});

describe('measuring a diff', () => {
  it('counts nothing for a no-op', () => {
    expect(diffTotals(emptyDiff()).total).toBe(0);
    expect(hasDeactivations(emptyDiff())).toBe(false);
  });

  it('counts mapping changes per permission key, not per node', () => {
    const diff = emptyDiff();
    diff.menu_permissions.mapped = [
      { nav_key: 'dc.create', permission_keys: ['a', 'b', 'c'] },
    ];

    // Three `menu_permission` rows would be written, however they are grouped
    // in the response.
    expect(diffTotals(diff).mapped).toBe(3);
  });

  it('counts a changed application row once, however many fields moved', () => {
    const diff = emptyDiff();
    diff.application.changed = ['name', 'description'];

    expect(diffTotals(diff).updated).toBe(1);
  });

  it('treats an unmapping as a deactivation for the confirmation prompt', () => {
    const diff = emptyDiff();
    diff.menu_permissions.unmapped = [
      { nav_key: 'dc.create', permission_keys: ['gatepass.dc.create'] },
    ];

    // Removing a node's last gate hides it from everyone, which is the same
    // class of surprise as retiring the node outright (Doc 05 §3).
    expect(hasDeactivations(diff)).toBe(true);
  });
});

describe('comparing the previewed diff with the applied one', () => {
  it('matches a diff against itself', () => {
    const diff = emptyDiff();
    diff.permissions.created = ['gatepass.dc.create'];

    expect(diffsMatch(diff, JSON.parse(JSON.stringify(diff)) as ManifestDiff)).toBe(
      true,
    );
  });

  it('spots a key that appeared between the preview and the confirm', () => {
    const previewed = emptyDiff();
    previewed.permissions.created = ['gatepass.dc.create'];

    const applied = emptyDiff();
    applied.permissions.created = ['gatepass.dc.create', 'gatepass.dc.approve'];

    expect(diffsMatch(previewed, applied)).toBe(false);
  });

  it('spots a key that moved out of one group and into another', () => {
    // The concurrent case that matters: someone else's upload created the key
    // in between, so what was a creation is now an update.
    const previewed = emptyDiff();
    previewed.permissions.created = ['gatepass.dc.create'];

    const applied = emptyDiff();
    applied.permissions.updated = ['gatepass.dc.create'];

    expect(diffsMatch(previewed, applied)).toBe(false);
  });

  it('spots a changed mapping under an unchanged nav key', () => {
    const previewed = emptyDiff();
    previewed.menu_permissions.mapped = [
      { nav_key: 'dc.create', permission_keys: ['a'] },
    ];

    const applied = emptyDiff();
    applied.menu_permissions.mapped = [
      { nav_key: 'dc.create', permission_keys: ['a', 'b'] },
    ];

    expect(diffsMatch(previewed, applied)).toBe(false);
  });

  it('does not depend on property order', () => {
    // Compared field by field rather than by `JSON.stringify`: the match is the
    // evidence for what the screen promised, and evidence that depends on two
    // objects having been built in the same order is not evidence.
    const previewed = emptyDiff();
    previewed.permissions.created = ['a'];

    const applied: ManifestDiff = {
      menu_permissions: { unmapped: [], mapped: [] },
      nav: { deactivated: [], updated: [], created: [] },
      permissions: { deactivated: [], updated: [], created: ['a'] },
      application: { changed: [], key: 'gatepass' },
    };

    expect(diffsMatch(previewed, applied)).toBe(true);
  });
});
