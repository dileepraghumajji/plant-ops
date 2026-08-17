/**
 * The Session 19 Definition of Done: **three fixture files produce exactly the
 * reports they should, and "Users by Role" answers over real bindings**
 * (Doc 06 §8, Doc 09 §3.3).
 *
 * Every claim here is a claim about Postgres or about a running request. That a
 * duplicate address already in the tenant comes back as a `skipped` row rather
 * than as a failed request — which is a claim about `on conflict do nothing`
 * under RLS, not about TypeScript. That the valid rows of a mixed file are
 * committed while the invalid ones are not. That a document-level refusal writes
 * nothing at all. That a holder of one role at four scopes is one row of
 * "Users by Role" and not four. A fake database can express none of them, so
 * this suite runs against a real one:
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * **Destructive within its own fixtures only.** Every client it creates is
 * slugged `s19-…`, and it is removed afterwards with the rows that hang off it.
 *
 * ## The fixtures are files, on purpose
 *
 * `testing/fixtures/users/*.csv` are read off disk rather than built as string
 * literals here. A CSV assembled in the same file that asserts about it can only
 * be as right as the assertion's own idea of the format; a file that a person
 * could open in a spreadsheet is the artefact the endpoint actually receives,
 * with the blank line, the quoted comma and the trailing-newline question all
 * present rather than assumed away.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls against a surface
 *   bounded at sixty a minute, and the bulk route at ten.
 * - **Nothing else.** The interim permission rule, the body ceiling, the
 *   validation pipe, the RLS context and the audit path are the shipped ones.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  IamErrorCode,
  type BulkUserUploadResponse,
  type IamErrorResponse,
  type Paginated,
  type TokenPairResponse,
  type UserByRoleDTO,
  type UserDTO,
} from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  createMigrationDataSource,
  hashSecret,
  scopePathLabel,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { ENV } from '../config/config.module';
import { createTestApplication } from '../testing/app-harness';
import { grantIamClientAdmin } from '../testing/authorization.fixture';

const S = `"${IAM_SCHEMA}"`;

const PLACEHOLDER = /REPLACE_ME|[[\]<>]/;
const usable = (url: string | undefined) =>
  url !== undefined &&
  /^postgres(ql)?:\/\/\S+@\S+/.test(url.trim()) &&
  !PLACEHOLDER.test(url);

const configured =
  usable(process.env['DATABASE_URL']) && usable(process.env['DATABASE_DIRECT_URL']);

const describeWithDb = configured ? describe : describe.skip;

const PASSWORD = 'correct-horse-battery-staple';

/** Everything this suite creates carries this prefix. */
const PREFIX = 's19-';

const FIXTURES = join(__dirname, '..', 'testing', 'fixtures', 'users');
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.csv`), 'utf-8');

/** One tenant, with the identities, org nodes and roles the cases need. */
interface Tenant {
  clientId: string;
  slug: string;
  adminEmail: string;
  adminUserId: string;
  /** An ordinary user — the interim authorization must refuse one. */
  memberEmail: string;
  memberUserId: string;
  /** The org root, and a child, so a holder can hold one role in two places. */
  rootId: string;
  rootPath: string;
  plantId: string;
  /** The role "Users by Role" is asked about, and one it must not confuse it with. */
  roleId: string;
  otherRoleId: string;
}

interface Fixture {
  acme: Tenant;
  other: Tenant;
}

describeWithDb(
  `bulk user upload & users-by-role (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let tenants: Fixture;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
      await purge(admin);

      const secretHash = await hashSecret(PASSWORD);
      tenants = {
        acme: await seedTenant(admin, 'acme', secretHash),
        other: await seedTenant(admin, 'other', secretHash),
      };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ENV)
        .useValue({ ...env, RATE_LIMIT_ENABLED: false })
        .compile();

      app = createTestApplication(moduleRef);
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await app?.close();
      if (admin?.isInitialized) {
        await purge(admin);
        await admin.query('select pg_advisory_unlock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
        await admin.destroy();
      }
    });

    beforeEach(async () => {
      for (const tenant of [tenants.acme, tenants.other]) {
        await resetTenant(admin, tenant);
      }
    });

    // ── the wire ──────────────────────────────────────────────────────────

    const loginOk = async (email: string, slug: string): Promise<TokenPairResponse> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, client_slug: slug }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as TokenPairResponse;
    };

    const asAdmin = async (tenant: Tenant = tenants.acme): Promise<string> =>
      (await loginOk(tenant.adminEmail, tenant.slug)).access_token;

    const call = (
      token: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const errorOf = async (response: Response) =>
      ((await response.json()) as IamErrorResponse).error;

    /** Uploads and asserts the 200, returning the report. */
    const upload = async (
      token: string,
      body: Record<string, unknown>,
    ): Promise<BulkUserUploadResponse> => {
      const response = await call(token, 'POST', '/iam/users/bulk', body);
      expect(response.status).toBe(200);
      return (await response.json()) as BulkUserUploadResponse;
    };

    const uploadCsv = (token: string, name: string): Promise<BulkUserUploadResponse> =>
      upload(token, { format: 'csv', content: fixture(name) });

    const listUsers = async (token: string): Promise<UserDTO[]> => {
      const response = await call(token, 'GET', '/iam/users?limit=100');
      expect(response.status).toBe(200);
      return ((await response.json()) as Paginated<UserDTO>).data;
    };

    const byRole = async (
      token: string,
      roleId: string,
      query = '',
    ): Promise<Paginated<UserByRoleDTO>> => {
      const response = await call(token, 'GET', `/iam/users/by-role/${roleId}${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as Paginated<UserByRoleDTO>;
    };

    // ── inspection, through the owner connection ──────────────────────────

    const auditFor = async (
      tenant: Tenant,
      action: string,
    ): Promise<Record<string, unknown>[]> => {
      await elevate(admin, tenant.clientId);
      const rows = (await admin.query(
        `select payload from ${S}."audit_trail"
          where client_id = $1 and action = $2
          order by created_at asc, id asc`,
        [tenant.clientId, action],
      )) as { payload: Record<string, unknown> }[];
      return rows.map((row) => row.payload);
    };

    // ── the three fixture files (the Definition of Done) ──────────────────

    describe('a clean file', () => {
      it('creates every row and reports each one', async () => {
        const token = await asAdmin();

        const report = await uploadCsv(token, 'clean');

        expect(report).toMatchObject({ total: 3, created: 3, skipped: 0, errored: 0 });
        expect(
          report.results.map(({ row, email, status }) => ({ row, email, status })),
        ).toEqual([
          { row: 1, email: 'gita.rao@acme.test', status: 'created' },
          // Quoted, mixed-case and padded in the file — normalized by the same
          // schema the single-user create uses, which is the whole point of
          // both formats reaching one validator.
          { row: 2, email: 'nikhil.joshi@acme.test', status: 'created' },
          { row: 3, email: 'zara.ali@acme.test', status: 'created' },
        ]);
        // A created row carries the handle the UI links to, and no reason.
        for (const result of report.results) {
          expect(result.user_id).toEqual(expect.any(String));
          expect(result.reason).toBeUndefined();
        }
      });

      it('commits the rows it reports as created', async () => {
        const token = await asAdmin();
        await uploadCsv(token, 'clean');

        const users = await listUsers(token);
        const zara = users.find((user) => user.email === 'zara.ali@acme.test');

        // The quoted comma survived the parser, and the per-row `status` column
        // is honoured the way Doc 09 §3.3's "initial status" is on the form.
        expect(zara).toMatchObject({ full_name: 'Ali, Zara', status: 'disabled' });
        expect(users.map((user) => user.email)).toEqual(
          expect.arrayContaining([
            'gita.rao@acme.test',
            'nikhil.joshi@acme.test',
            'zara.ali@acme.test',
          ]),
        );
      });
    });

    describe('a mixed file', () => {
      /** The address `mixed.csv` expects to find already taken. */
      const seedExisting = async (token: string): Promise<void> => {
        const response = await call(token, 'POST', '/iam/users', {
          email: 'existing@acme.test',
          full_name: 'Already Here',
        });
        expect(response.status).toBe(201);
      };

      it('produces exactly the expected per-row report', async () => {
        const token = await asAdmin();
        await seedExisting(token);

        const report = await uploadCsv(token, 'mixed');

        expect(report).toMatchObject({ total: 7, created: 2, skipped: 2, errored: 3 });
        expect(report.results.map(({ row, status }) => ({ row, status }))).toEqual([
          { row: 1, status: 'created' },
          { row: 2, status: 'errored' },
          { row: 3, status: 'skipped' },
          { row: 4, status: 'skipped' },
          // The blank line in the file is not a row, so row 5 is the fifth
          // *person* — which is what an operator reading this beside their
          // spreadsheet needs it to be.
          { row: 5, status: 'errored' },
          { row: 6, status: 'errored' },
          { row: 7, status: 'created' },
        ]);
      });

      it('distinguishes a duplicate in the file from a duplicate in the tenant', async () => {
        const token = await asAdmin();
        await seedExisting(token);

        const report = await uploadCsv(token, 'mixed');

        // Row 3 repeats row 1 in a different case — the addresses are compared
        // after normalization, because that is how the unique index compares
        // them.
        expect(report.results[2]).toEqual({
          row: 3,
          email: 'gita.rao@acme.test',
          status: 'skipped',
          reason: 'Row 1 of this upload already uses this email',
          user_id: null,
        });
        expect(report.results[3]).toEqual({
          row: 4,
          email: 'existing@acme.test',
          status: 'skipped',
          reason: 'A user with this email already exists in this client',
          user_id: null,
        });
      });

      it('names the field that made each bad row bad', async () => {
        const token = await asAdmin();
        await seedExisting(token);

        const report = await uploadCsv(token, 'mixed');
        const reasons = report.results
          .filter((result) => result.status === 'errored')
          .map((result) => result.reason ?? '');

        expect(reasons[0]).toContain('email');
        expect(reasons[1]).toContain('full_name');
        expect(reasons[2]).toContain('status');
        // The address is echoed as the file spelled it, so the row can be found
        // by something other than its number.
        expect(report.results[1].email).toBe('not-an-email');
      });

      it('commits the valid rows and writes nothing for the rest', async () => {
        const token = await asAdmin();
        await seedExisting(token);

        await uploadCsv(token, 'mixed');
        const emails = (await listUsers(token)).map((user) => user.email);

        expect(emails).toEqual(
          expect.arrayContaining([
            'gita.rao@acme.test',
            'sunil.mehta@acme.test',
            'existing@acme.test',
          ]),
        );
        // Every address that was reported as errored is absent, which is what
        // "valid rows commit even when others fail" has to mean.
        expect(emails).not.toContain('zara.ali@acme.test');
        expect(emails).not.toContain('nikhil.joshi@acme.test');
        expect(emails).not.toContain('not-an-email');
      });
    });

    describe('an all-bad file', () => {
      it('creates nothing and explains every row', async () => {
        const token = await asAdmin();

        const report = await uploadCsv(token, 'all-bad');

        expect(report).toMatchObject({ total: 4, created: 0, skipped: 0, errored: 4 });
        expect(report.results.every((result) => result.status === 'errored')).toBe(true);
        // A row whose address is the thing that is wrong reports `null` rather
        // than echoing something that is not an address.
        expect(report.results[0].email).toBeNull();
        expect(report.results[1].email).toBe('not-an-email');
        // Row 4 has one value more than the header has columns, so its fields
        // cannot be matched to them at all — a defect the row schema could
        // never have expressed.
        expect(report.results[3].reason).toContain('4 columns');
      });

      it('leaves the tenant exactly as it found it', async () => {
        const token = await asAdmin();
        const before = (await listUsers(token)).length;

        await uploadCsv(token, 'all-bad');

        expect((await listUsers(token)).length).toBe(before);
        expect(await auditFor(tenants.acme, AUDIT_ACTIONS.USER_CREATED)).toEqual([]);
      });
    });

    // ── the JSON arm ─────────────────────────────────────────────────────

    describe('the JSON format', () => {
      it('adjudicates row by row exactly as the CSV arm does', async () => {
        const token = await asAdmin();

        const report = await upload(token, {
          format: 'json',
          users: [
            { email: 'Gita.Rao@ACME.test', full_name: 'Gita Rao', status: 'disabled' },
            { email: 'gita.rao@acme.test', full_name: 'Gita Again' },
            { full_name: 'No Address' },
            42,
            { email: 'sunil.mehta@acme.test', full_name: 'Sunil Mehta' },
          ],
        });

        expect(report).toMatchObject({ total: 5, created: 2, skipped: 1, errored: 2 });
        expect(report.results.map(({ row, status }) => ({ row, status }))).toEqual([
          { row: 1, status: 'created' },
          { row: 2, status: 'skipped' },
          { row: 3, status: 'errored' },
          // A row that is not an object at all is still a row of the report,
          // which is why the DTO carries the array through unvalidated.
          { row: 4, status: 'errored' },
          { row: 5, status: 'created' },
        ]);
      });
    });

    // ── documents that cannot be read at all ─────────────────────────────

    describe('document-level refusals', () => {
      it.each([
        [
          'a header missing the required columns',
          'name,phone\nGita Rao,1',
          'email',
        ],
        [
          'an unterminated quoted field',
          'email,full_name\na@b.test,"never closed',
          'never closed',
        ],
        ['a header with no rows', 'email,full_name\n', 'no rows'],
        [
          'a duplicated column',
          'email,email,full_name\na@b.test,c@d.test,A',
          'more than once',
        ],
      ])('refuses %s as a 400', async (_case, content, expected) => {
        const token = await asAdmin();

        const response = await call(token, 'POST', '/iam/users/bulk', {
          format: 'csv',
          content,
        });

        // A `400`, not a report: there is no honest per-row verdict to give for
        // a document nobody can read row by row.
        expect(response.status).toBe(400);
        const error = await errorOf(response);
        expect(error.code).toBe(IamErrorCode.VALIDATION_FAILED);
        expect(error.message).toContain(expected);
      });

      it('writes nothing when the document is refused', async () => {
        const token = await asAdmin();
        const before = (await listUsers(token)).length;

        await call(token, 'POST', '/iam/users/bulk', {
          format: 'csv',
          content: 'email,full_name\ngood@acme.test,Good\nbad,"unterminated',
        });

        expect((await listUsers(token)).length).toBe(before);
        expect(await auditFor(tenants.acme, AUDIT_ACTIONS.USER_BULK_UPLOADED)).toEqual(
          [],
        );
      });
    });

    // ── the trail (Doc 10 §4) ────────────────────────────────────────────

    describe('auditing', () => {
      it('records the upload once, with its counts and the rows that did not land', async () => {
        const token = await asAdmin();
        await call(token, 'POST', '/iam/users', {
          email: 'existing@acme.test',
          full_name: 'Already Here',
        });

        await uploadCsv(token, 'mixed');

        const records = await auditFor(tenants.acme, AUDIT_ACTIONS.USER_BULK_UPLOADED);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          format: 'csv',
          total: 7,
          created: 2,
          skipped: 2,
          errored: 3,
          skipped_rows: [3, 4],
          errored_rows: [2, 5, 6],
        });
      });

      it('still records each created user on its own, so rows stay attributable', async () => {
        const token = await asAdmin();

        await uploadCsv(token, 'clean');

        const records = await auditFor(tenants.acme, AUDIT_ACTIONS.USER_CREATED);
        // An account whose only trace is "3 users were created" is one nobody
        // can account for later (Doc 10 §4).
        expect(records).toHaveLength(3);
        // Unordered, and that is a property of the trail rather than a weakness
        // of the assertion: `write_audit` stamps transaction time and a random
        // uuid, so the rows of one transaction tie on both whether they were
        // written one at a time or in a batch (`AuditService.recordMany`). Each
        // record carries its own row number, which is what makes it attributable.
        expect(records.map((record) => record['email']).sort()).toEqual([
          'gita.rao@acme.test',
          'nikhil.joshi@acme.test',
          'zara.ali@acme.test',
        ]);
        expect(records).toContainEqual(
          expect.objectContaining({
            email: 'gita.rao@acme.test',
            source: 'bulk',
            row: 1,
          }),
        );
      });
    });

    // ── users by role (Doc 06 §8, Doc 09 §3.3) ───────────────────────────

    describe('users by role', () => {
      it('lists a holder once, with every scope they hold the role at', async () => {
        const token = await asAdmin();
        const acme = tenants.acme;
        await insertBinding(admin, acme, acme.memberUserId, acme.roleId, acme.rootId);
        await insertBinding(admin, acme, acme.memberUserId, acme.roleId, acme.plantId);

        const holders = await byRole(token, acme.roleId);

        // One person, two places — `total` counts people, because "who has this
        // role" is a question about people.
        expect(holders).toMatchObject({ total: 1, page: 1, limit: 25 });
        expect(holders.data[0].email).toBe(acme.memberEmail);
        expect(holders.data[0].scopes.map((scope) => scope.scope_node_id).sort()).toEqual(
          [acme.rootId, acme.plantId].sort(),
        );
        expect(holders.data[0].scopes.every((scope) => !scope.expired)).toBe(true);
      });

      it('lists a holder whose only grant has lapsed, and flags it', async () => {
        const token = await asAdmin();
        const acme = tenants.acme;
        await insertBinding(admin, acme, acme.memberUserId, acme.roleId, acme.rootId, {
          expiresAt: new Date(Date.now() - 60_000),
        });

        const holders = await byRole(token, acme.roleId);

        // Hiding them is how an offboarding gets missed: a lapsed grant is the
        // answer to "why did this stop working" (Doc 01 §4.5).
        expect(holders.total).toBe(1);
        expect(holders.data[0].scopes[0]).toMatchObject({
          expired: true,
          expires_at: expect.any(String),
        });
      });

      it('does not confuse one role with another', async () => {
        const token = await asAdmin();
        const acme = tenants.acme;
        await insertBinding(admin, acme, acme.memberUserId, acme.otherRoleId, acme.rootId);

        expect((await byRole(token, acme.roleId)).total).toBe(0);
        expect((await byRole(token, acme.otherRoleId)).total).toBe(1);
      });

      it('pages over people rather than bindings', async () => {
        const token = await asAdmin();
        const acme = tenants.acme;
        // The admin holds the role at two scopes; the member at one. A join
        // would make `limit=1` return one *binding*, and `total` three.
        await insertBinding(admin, acme, acme.adminUserId, acme.roleId, acme.rootId);
        await insertBinding(admin, acme, acme.adminUserId, acme.roleId, acme.plantId);
        await insertBinding(admin, acme, acme.memberUserId, acme.roleId, acme.rootId);

        const first = await byRole(token, acme.roleId, '?page=1&limit=1');

        expect(first).toMatchObject({ total: 2, page: 1, limit: 1 });
        expect(first.data).toHaveLength(1);
        expect(first.data[0].scopes).toHaveLength(2);
        expect((await byRole(token, acme.roleId, '?page=2&limit=1')).data[0].email).toBe(
          tenants.acme.memberEmail,
        );
      });

      it('answers an empty page for a role nobody holds', async () => {
        const token = await asAdmin();

        expect(await byRole(token, tenants.acme.roleId)).toMatchObject({
          total: 0,
          data: [],
        });
      });

      it('404s an unknown role and another tenant`s role alike', async () => {
        const token = await asAdmin();

        for (const roleId of [randomUUID(), tenants.other.roleId]) {
          const response = await call(token, 'GET', `/iam/users/by-role/${roleId}`);
          // The same answer for both, so the response cannot be used to discover
          // that a role exists in another tenant (Doc 06 §2).
          expect(response.status).toBe(404);
          expect((await errorOf(response)).code).toBe(IamErrorCode.NOT_FOUND);
        }
      });

      it('is not shadowed by the :id route', async () => {
        const token = await asAdmin();

        // `by-role` is declared above `:id`, which carries a ParseUUIDPipe —
        // declared the other way round this would be a 400 about "by-role" not
        // being a uuid.
        const response = await call(
          token,
          'GET',
          `/iam/users/by-role/${tenants.acme.roleId}`,
        );

        expect(response.status).toBe(200);
      });
    });

    // ── authorization ────────────────────────────────────────────────────

    describe('authorization', () => {
      it('refuses an ordinary user of the tenant', async () => {
        const member = await loginOk(tenants.acme.memberEmail, tenants.acme.slug);

        for (const [method, path, body] of [
          [
            'POST',
            '/iam/users/bulk',
            { format: 'json', users: [{ email: 'x@acme.test', full_name: 'X' }] },
          ],
          ['GET', `/iam/users/by-role/${tenants.acme.roleId}`, undefined],
        ] as const) {
          const response = await call(member.access_token, method, path, body);
          // A 403 rather than a 404: no target has been named at the point the
          // check runs, so there is nothing whose existence it could reveal.
          expect(response.status).toBe(403);
          expect((await errorOf(response)).code).toBe(IamErrorCode.PERMISSION_DENIED);
        }
      });

      it('refuses an unauthenticated upload', async () => {
        const response = await fetch(`${baseUrl}/iam/users/bulk`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ format: 'csv', content: 'email\na@b.test' }),
        });

        expect(response.status).toBe(401);
      });

      it('writes into the caller`s own tenant and no other', async () => {
        await uploadCsv(await asAdmin(tenants.other), 'clean');

        // The same three addresses are free in acme, because `unique
        // (client_id, email)` is per tenant and `client_id` came from the
        // token's `cid` (Doc 06 §1).
        const report = await uploadCsv(await asAdmin(tenants.acme), 'clean');
        expect(report.created).toBe(3);
      });
    });
  },
);

/**
 * Platform context on the owner connection.
 *
 * Session-scoped (`false`) rather than transaction-local, because these queries
 * run outside a transaction and the connection is this suite's alone.
 */
async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

/**
 * One tenant with an admin, an ordinary member, a two-node org tree and two
 * roles.
 *
 * Seeded directly rather than through `POST /iam/clients/:id/admins`, so this
 * suite's subject does not depend on Session 15's endpoint — the same choice
 * `users.integration.spec.ts` makes, for the same reason.
 */
async function seedTenant(
  admin: DataSource,
  label: string,
  secretHash: string,
): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const rootId = randomUUID();
  const tenant: Tenant = {
    clientId: randomUUID(),
    slug: `${PREFIX}${label}-${suffix}`,
    adminEmail: `admin-${label}-${suffix}@example.test`,
    adminUserId: randomUUID(),
    memberEmail: `member-${label}-${suffix}@example.test`,
    memberUserId: randomUUID(),
    rootId,
    rootPath: scopePathLabel(rootId),
    plantId: randomUUID(),
    roleId: randomUUID(),
    otherRoleId: randomUUID(),
  };

  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 19 ${label} ${suffix}`, tenant.slug],
  );

  for (const [id, email, name, isAdmin] of [
    [tenant.adminUserId, tenant.adminEmail, 'Session 19 Admin', true],
    [tenant.memberUserId, tenant.memberEmail, 'Session 19 Member', false],
  ] as const) {
    await admin.query(
      `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
       values ($1, $2, $3, $4, 'active', $5)`,
      [id, tenant.clientId, email, name, isAdmin],
    );
    await admin.query(
      `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
       values ($1, $2, 'password', $3)`,
      [tenant.clientId, id, secretHash],
    );
  }

  // The org root and one plant under it, with the id-derived ltree labels of
  // Doc 01 §3.5 — so one person can hold one role in two places.
  await admin.query(
    `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
     values ($1, $2, null, 'group', $3, $4::ltree)`,
    [rootId, tenant.clientId, `Session 19 ${label}`, tenant.rootPath],
  );
  await admin.query(
    `insert into ${S}."scope_node" (id, client_id, parent_id, kind, name, path)
     values ($1, $2, $3, 'plant', 'Plant B', $4::ltree)`,
    [
      tenant.plantId,
      tenant.clientId,
      rootId,
      `${tenant.rootPath}.${scopePathLabel(tenant.plantId)}`,
    ],
  );

  for (const [id, name] of [
    [tenant.roleId, 'Session 19 Role'],
    [tenant.otherRoleId, 'Session 19 Other Role'],
  ] as const) {
    await admin.query(
      `insert into ${S}."role" (id, client_id, name, description)
       values ($1, $2, $3, 'Session 19 fixture')`,
      [id, tenant.clientId, name],
    );
  }

  return tenant;
}

/** Binds a user to one of the tenant's fixture roles, optionally with an expiry. */
async function insertBinding(
  admin: DataSource,
  tenant: Tenant,
  userId: string,
  roleId: string,
  scopeNodeId: string,
  options: { expiresAt?: Date } = {},
): Promise<void> {
  await elevate(admin, tenant.clientId);
  await admin.query(
    `insert into ${S}."role_binding" (client_id, user_id, role_id, scope_node_id, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [tenant.clientId, userId, roleId, scopeNodeId, options.expiresAt ?? null],
  );
}

/**
 * Back to the two seeded users, with nothing hanging off them.
 *
 * The tenants, their org tree and their roles are seeded once: logging in is the
 * slowest thing here (argon2id, by design), so the accounts that log in are not
 * rebuilt per case.
 */
async function resetTenant(admin: DataSource, tenant: Tenant): Promise<void> {
  await elevate(admin, tenant.clientId);

  await admin.query(`delete from ${S}."role_binding" where client_id = $1`, [
    tenant.clientId,
  ]);
  await admin.query(`delete from ${S}."session" where client_id = $1`, [tenant.clientId]);
  await admin.query(
    `delete from ${S}."user_identity"
      where client_id = $1 and user_id <> all($2::uuid[])`,
    [tenant.clientId, [tenant.adminUserId, tenant.memberUserId]],
  );
  await admin.query(
    `delete from ${S}."user" where client_id = $1 and id <> all($2::uuid[])`,
    [tenant.clientId, [tenant.adminUserId, tenant.memberUserId]],
  );
  await admin.query(`delete from ${S}."audit_trail" where client_id = $1`, [
    tenant.clientId,
  ]);
  // The administrator's own authorization, last, because the wipes above take
  // it with them: since Session 23 every route on this surface is gated on an
  // `iam.client.*` permission, held through a role bound at the tenant root
  // (`testing/authorization.fixture.ts`).
  await grantIamClientAdmin(admin, tenant.clientId, tenant.rootId, {
    userId: tenant.adminUserId,
  });
}

/** Every `s19-` tenant, and everything hanging off it. */
async function purge(admin: DataSource): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  const clients = (await admin.query(
    `select id from ${S}."client" where slug like $1`,
    [`${PREFIX}%`],
  )) as { id: string }[];

  for (const { id } of clients) {
    await elevate(admin, id);
    for (const statement of [
      `delete from ${S}."role_binding" where client_id = $1`,
      `delete from ${S}."session" where client_id = $1`,
      `delete from ${S}."password_reset_token" where client_id = $1`,
      `delete from ${S}."user_identity" where client_id = $1`,
      `delete from ${S}."user" where client_id = $1`,
      `delete from ${S}."role" where client_id = $1`,
      `delete from ${S}."scope_node" where client_id = $1 and parent_id is not null`,
      `delete from ${S}."scope_node" where client_id = $1`,
      `delete from ${S}."client_application" where client_id = $1`,
      `delete from ${S}."audit_trail" where client_id = $1`,
    ]) {
      await admin.query(statement, [id]);
    }
    await admin.query(`delete from ${S}."client" where id = $1`, [id]);
  }
}
