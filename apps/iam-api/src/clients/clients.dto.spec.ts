/**
 * The client-provisioning request schemas (Doc 06 §5).
 *
 * These run without a database, and they are where the *shape* rules of a tenant
 * are pinned: what a slug may look like, which fields a caller may not set, and
 * which malformed bodies must be a 400 rather than reaching an insert on a
 * tenant table. The behaviour that needs Postgres — uniqueness, RLS, the
 * atomicity of the admin bootstrap, suspension blocking login — is
 * `clients.integration.spec.ts`.
 */

import { PASSWORD_MIN_LENGTH } from '../auth/password.util';
import {
  createClientAdminSchema,
  createClientSchema,
  enableApplicationsSchema,
  updateClientApplicationSchema,
  updateClientSchema,
} from './dto/clients.dto';

const PASSWORD = 'x'.repeat(PASSWORD_MIN_LENGTH);

describe('client provisioning request schemas', () => {
  describe('POST /iam/clients', () => {
    it('accepts a minimal body and defaults nothing it should not', () => {
      const parsed = createClientSchema.parse({ name: 'Acme Steel', slug: 'acme-steel' });

      expect(parsed).toEqual({ name: 'Acme Steel', slug: 'acme-steel' });
      expect('config' in parsed).toBe(false);
    });

    it('strips keys the caller may not set', () => {
      const parsed = createClientSchema.parse({
        name: 'Acme Steel',
        slug: 'acme-steel',
        id: '00000000-0000-4000-8000-000000000000',
        status: 'suspended',
        created_at: '2020-01-01T00:00:00.000Z',
      });

      // `z.object` strips rather than tolerates. A tolerated `id` here would let
      // a caller choose which row the provisioning context points at.
      expect(parsed).toEqual({ name: 'Acme Steel', slug: 'acme-steel' });
    });

    it.each([
      ['a leading hyphen', '-acme'],
      ['a trailing hyphen', 'acme-'],
      ['doubled hyphens', 'acme--steel'],
      ['a space', 'acme steel'],
      ['an underscore', 'acme_steel'],
      ['a dot', 'acme.steel'],
      ['empty', ''],
    ])('refuses a slug with %s', (_case, slug) => {
      expect(createClientSchema.safeParse({ name: 'Acme', slug }).success).toBe(false);
    });

    it('lowercases and trims the slug, so one tenant cannot become two', () => {
      // The database's `client_slug_format` check would refuse `ACME-STEEL`
      // outright; normalising here means a pasted value is accepted as what the
      // operator obviously meant, and means the unique index sees one spelling.
      expect(createClientSchema.parse({ name: ' Acme ', slug: '  ACME-Steel ' })).toEqual({
        name: 'Acme',
        slug: 'acme-steel',
      });
    });
  });

  describe('PATCH /iam/clients/:id', () => {
    it('refuses an empty body rather than auditing a change nobody made', () => {
      expect(updateClientSchema.safeParse({}).success).toBe(false);
    });

    it('accepts the two statuses and nothing else', () => {
      expect(updateClientSchema.parse({ status: 'suspended' })).toEqual({
        status: 'suspended',
      });
      expect(updateClientSchema.parse({ status: 'active' })).toEqual({ status: 'active' });
      expect(updateClientSchema.safeParse({ status: 'deleted' }).success).toBe(false);
    });

    it('will not patch the slug, because every user types it to log in', () => {
      const parsed = updateClientSchema.parse({ name: 'Acme', slug: 'something-else' });
      expect(parsed).toEqual({ name: 'Acme' });
    });
  });

  describe('POST /iam/clients/:id/applications', () => {
    it('takes an application by id or by key', () => {
      expect(
        enableApplicationsSchema.parse({
          applications: [
            { application_id: '11111111-1111-4111-8111-111111111111' },
            { application_key: 'gatepass' },
          ],
        }).applications,
      ).toHaveLength(2);
    });

    it.each([
      ['neither', {}],
      [
        'both',
        {
          application_id: '11111111-1111-4111-8111-111111111111',
          application_key: 'gatepass',
        },
      ],
    ])('refuses an entry naming %s', (_case, entry) => {
      expect(
        enableApplicationsSchema.safeParse({ applications: [entry] }).success,
      ).toBe(false);
    });

    it('refuses a duplicate within one request', () => {
      // The conflict would otherwise be reported against the primary key and
      // blamed on existing data, when this request is what created it.
      expect(
        enableApplicationsSchema.safeParse({
          applications: [{ application_key: 'gatepass' }, { application_key: 'gatepass' }],
        }).success,
      ).toBe(false);
    });

    it('refuses an empty list', () => {
      expect(enableApplicationsSchema.safeParse({ applications: [] }).success).toBe(false);
    });
  });

  describe('PATCH /iam/clients/:id/applications/:appId', () => {
    it('refuses an empty body', () => {
      expect(updateClientApplicationSchema.safeParse({}).success).toBe(false);
    });

    it('accepts an explicit empty config, which is how one is cleared', () => {
      expect(updateClientApplicationSchema.parse({ config: {} })).toEqual({ config: {} });
    });
  });

  describe('POST /iam/clients/:id/admins', () => {
    const body = {
      email: 'Admin@Acme.test',
      full_name: 'Acme Admin',
      password: PASSWORD,
    };

    it('lowercases the email, because the column and the index both require it', () => {
      // `user_email_is_lowercase` (migration 0003) rejects anything else, and
      // `unique (client_id, email)` is only case-insensitive because the stored
      // form is normalised.
      expect(createClientAdminSchema.parse(body).email).toBe('admin@acme.test');
    });

    it('applies the same password policy the reset endpoint does', () => {
      expect(
        createClientAdminSchema.safeParse({ ...body, password: 'short' }).success,
      ).toBe(false);
    });

    it('strips fields that would let the caller choose the user row', () => {
      const parsed = createClientAdminSchema.parse({
        ...body,
        id: '00000000-0000-4000-8000-000000000000',
        client_id: '00000000-0000-4000-8000-000000000001',
        status: 'disabled',
        is_client_admin: false,
      });

      expect(parsed).toEqual({
        email: 'admin@acme.test',
        full_name: 'Acme Admin',
        password: PASSWORD,
      });
    });

    it.each([['no at sign', 'admin'], ['no domain dot', 'admin@acme'], ['a space', 'a b@x.test']])(
      'refuses an email with %s',
      (_case, email) => {
        expect(createClientAdminSchema.safeParse({ ...body, email }).success).toBe(false);
      },
    );
  });
});
