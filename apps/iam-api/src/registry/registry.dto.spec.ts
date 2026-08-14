/**
 * The registry request schemas (Doc 06 §4).
 *
 * These run without a database, and they are where the *shape* rules of the
 * catalog are pinned: what a key may look like, what a bulk body may carry, and
 * which malformed bodies must be a 400 rather than reaching an insert. The
 * behaviour that needs Postgres — uniqueness, the parent constraint, RLS, audit
 * — is `registry.integration.spec.ts`.
 */

import {
  createApplicationSchema,
  updateApplicationSchema,
} from './dto/applications.dto';
import { createNavNodesSchema, navPermissionsSchema } from './dto/nav.dto';
import { createPermissionsSchema } from './dto/permissions.dto';

describe('registry request schemas', () => {
  describe('POST /iam/applications', () => {
    it('accepts a minimal body and defaults nothing it should not', () => {
      const parsed = createApplicationSchema.parse({ key: 'gatepass', name: 'Gate Pass' });

      expect(parsed).toEqual({ key: 'gatepass', name: 'Gate Pass' });
      // No `is_active`, no `config`: absent means "let the column decide", and a
      // DTO that invented defaults would put them in the audit payload too.
      expect('config' in parsed).toBe(false);
    });

    it('strips keys the caller may not set', () => {
      const parsed = createApplicationSchema.parse({
        key: 'gatepass',
        name: 'Gate Pass',
        id: '00000000-0000-4000-8000-000000000000',
        is_active: false,
        created_at: '2020-01-01T00:00:00.000Z',
      });

      // `z.object` strips rather than tolerates — the mass-assignment hole a
      // validator that only *checks* would leave open (see `validation.pipe.ts`).
      expect(parsed).toEqual({ key: 'gatepass', name: 'Gate Pass' });
    });

    it.each([
      ['upper case', 'Gatepass'],
      ['a leading digit', '1gatepass'],
      ['a space', 'gate pass'],
      ['a dot', 'gate.pass'],
      ['empty', ''],
    ])('refuses an application key with %s', (_case, key) => {
      expect(createApplicationSchema.safeParse({ key, name: 'x' }).success).toBe(false);
    });

    it('trims, so a pasted key does not become a second application', () => {
      expect(createApplicationSchema.parse({ key: '  gatepass  ', name: ' Gate Pass ' })).toEqual(
        { key: 'gatepass', name: 'Gate Pass' },
      );
    });
  });

  describe('PATCH /iam/applications/:id', () => {
    it('refuses an empty body', () => {
      // A `{}` PATCH would otherwise answer 200 having changed nothing, which
      // reads as success to a caller whose field name was wrong.
      expect(updateApplicationSchema.safeParse({}).success).toBe(false);
    });

    it('accepts a lone is_active, which is how deactivation is spelled', () => {
      expect(updateApplicationSchema.parse({ is_active: false })).toEqual({
        is_active: false,
      });
    });

    it('accepts a null description, which is how one is cleared', () => {
      expect(updateApplicationSchema.parse({ description: null })).toEqual({
        description: null,
      });
    });

    it('ignores an attempt to rename the key', () => {
      // Stripped, not rejected: `key` is simply not part of this body, and the
      // 400 the caller would otherwise get says nothing more useful than the
      // unchanged key they read back.
      const parsed = updateApplicationSchema.parse({ name: 'Renamed', key: 'other' });
      expect(parsed).toEqual({ name: 'Renamed' });
    });
  });

  describe('POST /iam/applications/:id/permissions', () => {
    it('requires dotted keys', () => {
      expect(
        createPermissionsSchema.safeParse({ permissions: [{ key: 'approve', name: 'A' }] })
          .success,
      ).toBe(false);
      expect(
        createPermissionsSchema.safeParse({
          permissions: [{ key: 'gatepass.dc.approve', name: 'Approve DC' }],
        }).success,
      ).toBe(true);
    });

    it('refuses an empty array', () => {
      expect(createPermissionsSchema.safeParse({ permissions: [] }).success).toBe(false);
    });

    it('refuses duplicate keys within one request', () => {
      const result = createPermissionsSchema.safeParse({
        permissions: [
          { key: 'gatepass.dc.create', name: 'Create' },
          { key: 'gatepass.dc.create', name: 'Create again' },
        ],
      });

      // A 400 naming the body, rather than a 409 blaming a row this same
      // request created a moment earlier.
      expect(result.success).toBe(false);
    });
  });

  describe('POST /iam/applications/:id/nav', () => {
    const node = { kind: 'menu', key: 'dc.create', label: 'New DC' };

    it('accepts a container with no route', () => {
      expect(
        createNavNodesSchema.safeParse({
          nodes: [{ kind: 'module', key: 'gatepass', label: 'Gate Pass' }],
        }).success,
      ).toBe(true);
    });

    it('refuses an off-site route', () => {
      // `route` is rendered into the admin shell's router; an absolute URL would
      // turn a menu entry into a redirect chosen by whoever added the node.
      expect(
        createNavNodesSchema.safeParse({
          nodes: [{ ...node, route: 'https://example.test/steal' }],
        }).success,
      ).toBe(false);
      expect(
        createNavNodesSchema.safeParse({ nodes: [{ ...node, route: '/gatepass/new' }] })
          .success,
      ).toBe(true);
    });

    it('refuses an unknown kind', () => {
      expect(
        createNavNodesSchema.safeParse({ nodes: [{ ...node, kind: 'page' }] }).success,
      ).toBe(false);
    });

    it('refuses naming the parent twice', () => {
      const result = createNavNodesSchema.safeParse({
        nodes: [
          {
            ...node,
            parent_id: '00000000-0000-4000-8000-000000000000',
            parent_key: 'gatepass',
          },
        ],
      });

      // The two could disagree, and silently preferring one is how a node ends
      // up under a parent nobody asked for.
      expect(result.success).toBe(false);
    });

    it('accepts either parent spelling on its own', () => {
      expect(
        createNavNodesSchema.safeParse({ nodes: [{ ...node, parent_key: 'gatepass' }] })
          .success,
      ).toBe(true);
      expect(
        createNavNodesSchema.safeParse({
          nodes: [{ ...node, parent_id: '00000000-0000-4000-8000-000000000000' }],
        }).success,
      ).toBe(true);
    });

    it('refuses duplicate node keys within one request', () => {
      expect(
        createNavNodesSchema.safeParse({ nodes: [node, { ...node, label: 'Again' }] })
          .success,
      ).toBe(false);
    });
  });

  describe('nav-permissions body', () => {
    it('requires at least one permission key per mapping', () => {
      expect(
        navPermissionsSchema.safeParse({
          mappings: [{ nav_key: 'dc.create', permission_keys: [] }],
        }).success,
      ).toBe(false);
    });

    it('accepts a mapping of one node to several permissions', () => {
      expect(
        navPermissionsSchema.parse({
          mappings: [
            {
              nav_key: 'dc.create',
              permission_keys: ['gatepass.dc.create', 'gatepass.dc.approve'],
            },
          ],
        }).mappings[0].permission_keys,
      ).toHaveLength(2);
    });
  });
});
