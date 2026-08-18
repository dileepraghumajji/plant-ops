/**
 * The Session 25 Definition of Done: **the filter and visibility matrix, over
 * HTTP, against a real Postgres** (Doc 06 §12, Doc 10 §7).
 *
 * `audit-read.spec.ts` decides everything that is a function of plain values —
 * that the surface is `GET`-only, that the DTO refuses a mistyped action, that
 * the four filters compose into one `where`. What only a live database can
 * decide is the claim the endpoint exists to make:
 *
 * > Client admins read their own client's audit (`iam.client.audit.read`),
 * > RLS-scoped. Platform admins read all audit (`iam.platform.audit.read`).
 * > — Doc 10 §7
 *
 * No line of TypeScript implements that sentence. It is the `audit_trail_read`
 * policy of migration 0010, evaluated against the context
 * `TenantContextInterceptor` derived from a verified token — so the only way to
 * test it is to log two subjects in, over the wire, through the shipped
 * pipeline, against a database running under the *app* role. A fake would prove
 * that a query was issued and nothing at all about who may see its rows.
 *
 *   pg_ctl start                # a local Postgres 17 (see .env)
 *   npm run migration:run
 *   npx nx test @plantops/iam-api
 *
 * ## What is seeded, and how
 *
 * Audit rows cannot be inserted. `audit_trail` has no INSERT grant for anybody
 * but the owner and no insert policy at all (migration 0010), which is the point
 * of the design — so the fixture writes them the only way anything writes them,
 * by calling `iam.write_audit` with the session context set to whoever is meant
 * to have acted. That makes the fixture rows indistinguishable from production
 * ones, including in the two columns no caller can supply: `client_id` and
 * `actor_id` are derived, never passed.
 *
 * Three groups, and each exists for a case below:
 *
 * - **`acme`** and **`other`** — two tenants, so "sees only their own" has
 *   something to be wrong about;
 * - **a platform-level row** with `client_id is null`, which Doc 10 §7 says only
 *   a platform admin may see and which no tenant filter could otherwise
 *   distinguish from an absent row;
 * - **two batches separated in time**, so the date range is tested against
 *   instants the database stamped rather than against ones a test asserted.
 *
 * **Destructive within its own fixtures only.** Every client is slugged `s25-…`
 * and removed afterwards with everything hanging off it. The audit rows this
 * suite causes the *application* to write — the denial of an ungranted read, the
 * `audit.exported` of each export — are removed by action within the window this
 * run occupies, which is as narrow an identification as an append-only table
 * allows and cannot reach another suite's rows.
 *
 * ## Deliberate deviations from the shipped configuration
 *
 * - **Rate limiting is off.** These cases make dozens of calls, and the export's
 *   own bound is ten a minute.
 * - **Nothing else.** The auth guard, the permission guard, the RLS context, the
 *   validation pipe and the error envelope are the shipped ones — which is what
 *   makes the 403 below a real 403 rather than a thrown exception.
 */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@plantops/config';
import {
  AUDIT_EXPORT_COLUMNS,
  type AccessTokenResponse,
  type AuditRecordDTO,
  type IamErrorResponse,
  type Paginated,
  type TokenPairResponse,
} from '@plantops/contracts';
import {
  IAM_SCHEMA,
  IAM_SCHEMA_TEST_LOCK_ID,
  PLATFORM_SERVICE_ACCOUNT_KEY,
  createMigrationDataSource,
  hashSecret,
} from '@plantops/db';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app/app.module';
import { ENV } from '../config/config.module';
import { createTestApplication } from '../testing/app-harness';
import {
  grantIamClientAdmin,
  seedRootScopeNode,
} from '../testing/authorization.fixture';
import { AUDIT_ACTIONS } from './audit-actions';

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
const PREFIX = 's25-';

/** One tenant: an auditor who may read the trail, and somebody who may not. */
interface Tenant {
  clientId: string;
  slug: string;
  rootId: string;
  auditorEmail: string;
  auditorUserId: string;
  /** No bindings at all — the deny-by-default subject. */
  outsiderEmail: string;
  outsiderUserId: string;
  /** The uuid the seeded rows point at, so a target filter has a target. */
  targetId: string;
}

interface Fixture {
  acme: Tenant;
  other: Tenant;
  /** Between the two seeded batches — the boundary the date filters use. */
  midpoint: string;
  /** The `client_id is null` row only a platform admin may see. */
  platformTargetId: string;
}

describeWithDb(
  `audit read API (${configured ? 'live' : 'skipped: no DATABASE_URL'})`,
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let admin: DataSource;
    let fixture: Fixture;
    let bootstrapSecret: string;
    /** Bounds the cleanup of rows the application itself wrote. */
    let startedAt: string;

    jest.setTimeout(180_000);

    beforeAll(async () => {
      const env = loadEnv();
      bootstrapSecret = env.PLATFORM_BOOTSTRAP_SECRET;

      admin = createMigrationDataSource(env);
      await admin.initialize();
      await admin.query('select pg_advisory_lock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
      await purge(admin);

      startedAt = await now(admin);

      const secretHash = await hashSecret(PASSWORD);
      const acme = await seedTenant(admin, 'acme', secretHash);
      const other = await seedTenant(admin, 'other', secretHash);

      // Batch one, then a boundary, then batch two — so `?from=` is tested
      // against instants Postgres stamped rather than ones this file asserted.
      await seedTrail(admin, acme, 'first');
      await seedTrail(admin, other, 'first');
      const midpoint = await now(admin);
      await seedTrail(admin, acme, 'second');
      const platformTargetId = await seedPlatformRow(admin);

      fixture = { acme, other, midpoint, platformTargetId };

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
        await purge(admin, startedAt);
        await admin.query('select pg_advisory_unlock($1)', [IAM_SCHEMA_TEST_LOCK_ID]);
        await admin.destroy();
      }
    });

    // ── the wire ──────────────────────────────────────────────────────────

    const call = (token: string, path: string): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

    const login = async (email: string, slug: string): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, client_slug: slug }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as TokenPairResponse).access_token;
    };

    const asAuditor = (tenant: Tenant = fixture.acme): Promise<string> =>
      login(tenant.auditorEmail, tenant.slug);

    const asOutsider = (tenant: Tenant = fixture.acme): Promise<string> =>
      login(tenant.outsiderEmail, tenant.slug);

    /** The bootstrap identity — the only platform subject a fresh database has. */
    const asPlatform = async (): Promise<string> => {
      const response = await fetch(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account_key: PLATFORM_SERVICE_ACCOUNT_KEY,
          account_secret: bootstrapSecret,
        }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as AccessTokenResponse).access_token;
    };

    const read = async (
      token: string,
      query = '',
    ): Promise<Paginated<AuditRecordDTO>> => {
      const response = await call(token, `/iam/audit${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as Paginated<AuditRecordDTO>;
    };

    // ── visibility (Doc 10 §7) ────────────────────────────────────────────

    describe('who sees what', () => {
      it('shows a client admin their own tenant’s rows and nothing else', async () => {
        const page = await read(await asAuditor(), '?limit=100');

        expect(page.data.length).toBeGreaterThan(0);
        // The whole claim, as one assertion: every row, without exception.
        expect(page.data.every((row) => row.client_id === fixture.acme.clientId)).toBe(
          true,
        );
      });

      it('hides the platform-level rows from a client admin', async () => {
        // `client_id is null` is Doc 10 §2's "a platform-level action". A tenant
        // predicate alone would not exclude it — `client_id = $1` is unknown for
        // a null, not false — so this is the case a hand-written filter gets
        // wrong and the RLS policy does not.
        const page = await read(await asAuditor(), '?limit=100');

        expect(page.data.some((row) => row.client_id === null)).toBe(false);
      });

      it('shows a platform admin both tenants and the platform rows', async () => {
        const page = await read(
          await asPlatform(),
          `?target_id=${fixture.acme.targetId}&limit=100`,
        );
        const others = await read(
          await asPlatform(),
          `?target_id=${fixture.other.targetId}&limit=100`,
        );
        const platform = await read(
          await asPlatform(),
          `?target_id=${fixture.platformTargetId}&limit=100`,
        );

        expect(page.total).toBeGreaterThan(0);
        expect(others.total).toBeGreaterThan(0);
        expect(platform.data.map((row) => row.client_id)).toEqual([null]);
      });

      it('answers an empty page, not a refusal, for another tenant’s client_id', async () => {
        // Doc 06 §2: a response must not reveal cross-tenant existence. The
        // filter narrows what RLS already allowed, so naming a real client the
        // caller may not see is indistinguishable from naming one that does not
        // exist — and both are a 200 with nothing in it.
        const real = await read(
          await asAuditor(),
          `?client_id=${fixture.other.clientId}`,
        );
        const invented = await read(await asAuditor(), `?client_id=${randomUUID()}`);

        expect(real.data).toEqual([]);
        expect(real.total).toBe(0);
        expect(invented).toEqual(real);
      });

      it('refuses a subject who holds neither audit key, and audits the attempt', async () => {
        const response = await call(await asOutsider(), '/iam/audit');
        expect(response.status).toBe(403);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          'PERMISSION_DENIED',
        );

        // And the refusal is in the trail the refused request was reaching for —
        // written on its own connection, so it survived the rollback its own 403
        // caused (Doc 10 §3).
        const page = await read(
          await asAuditor(),
          `?action=${AUDIT_ACTIONS.PERMISSION_DENIED}&actor_id=${fixture.acme.outsiderUserId}`,
        );

        expect(page.total).toBeGreaterThan(0);
        // Both keys, because the route admits either and the subject held
        // neither (`denial-auditor.ts`).
        expect(page.data[0].payload).toMatchObject({
          permission: 'iam.client.audit.read',
          permissions: ['iam.client.audit.read', 'iam.platform.audit.read'],
        });
      });
    });

    // ── filters (Doc 06 §12) ──────────────────────────────────────────────

    describe('the filters', () => {
      it('filters by actor', async () => {
        const page = await read(
          await asAuditor(),
          `?actor_id=${fixture.acme.auditorUserId}&limit=100`,
        );

        expect(page.total).toBeGreaterThan(0);
        expect(
          page.data.every((row) => row.actor_id === fixture.acme.auditorUserId),
        ).toBe(true);
      });

      it('filters by action', async () => {
        const page = await read(
          await asAuditor(),
          `?action=${AUDIT_ACTIONS.USER_CREATED}&limit=100`,
        );

        expect(page.total).toBeGreaterThan(0);
        expect(page.data.every((row) => row.action === 'user.created')).toBe(true);
      });

      it('filters by target', async () => {
        const page = await read(
          await asAuditor(),
          `?target_type=user&target_id=${fixture.acme.targetId}&limit=100`,
        );

        expect(page.total).toBeGreaterThan(0);
        expect(
          page.data.every(
            (row) =>
              row.target_type === 'user' && row.target_id === fixture.acme.targetId,
          ),
        ).toBe(true);
      });

      it('filters by date range, half-open', async () => {
        const auditor = await asAuditor();
        const everything = await read(auditor, '?limit=100');
        const after = await read(auditor, `?from=${iso(fixture.midpoint)}&limit=100`);
        const before = await read(auditor, `?to=${iso(fixture.midpoint)}&limit=100`);

        expect(after.total).toBeGreaterThan(0);
        expect(before.total).toBeGreaterThan(0);
        // Half-open, so the two halves partition the whole: no row is in both,
        // and none falls between them.
        expect(after.total + before.total).toBe(everything.total);
      });

      it('composes all four, narrowing rather than widening', async () => {
        const auditor = await asAuditor();
        const one = await read(
          auditor,
          `?action=${AUDIT_ACTIONS.USER_CREATED}&limit=100`,
        );
        const both = await read(
          auditor,
          `?action=${AUDIT_ACTIONS.USER_CREATED}` +
            `&actor_id=${fixture.acme.auditorUserId}` +
            `&target_type=user&target_id=${fixture.acme.targetId}` +
            `&from=${iso(fixture.midpoint)}&limit=100`,
        );

        expect(both.total).toBeGreaterThan(0);
        expect(both.total).toBeLessThan(one.total);
        expect(
          both.data.every(
            (row) =>
              row.action === 'user.created' &&
              row.actor_id === fixture.acme.auditorUserId &&
              row.target_id === fixture.acme.targetId,
          ),
        ).toBe(true);
      });

      it('orders newest first', async () => {
        const page = await read(await asAuditor(), '?limit=100');
        const stamps = page.data.map((row) => Date.parse(row.created_at));

        expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
      });

      it('paginates with a total over the filter, not over the page', async () => {
        const auditor = await asAuditor();
        const all = await read(auditor, '?limit=100');
        const first = await read(auditor, '?page=1&limit=2');
        const second = await read(auditor, '?page=2&limit=2');

        expect(first).toMatchObject({ page: 1, limit: 2, total: all.total });
        expect(first.data).toHaveLength(2);
        expect(first.data).toEqual(all.data.slice(0, 2));
        expect(second.data).toEqual(all.data.slice(2, 4));
      });

      it('refuses an action outside the catalog rather than answering nothing', async () => {
        const response = await call(await asAuditor(), '/iam/audit?action=user.diabled');

        expect(response.status).toBe(400);
        expect(((await response.json()) as IamErrorResponse).error.code).toBe(
          'VALIDATION_FAILED',
        );
      });
    });

    // ── export (Doc 10 §7) ────────────────────────────────────────────────

    describe('the CSV export', () => {
      it('answers a CSV attachment carrying the filtered rows', async () => {
        const auditor = await asAuditor();
        const expected = await read(
          auditor,
          `?action=${AUDIT_ACTIONS.USER_CREATED}&limit=100`,
        );

        const response = await call(
          auditor,
          `/iam/audit/export?action=${AUDIT_ACTIONS.USER_CREATED}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/csv');
        expect(response.headers.get('content-disposition')).toContain('attachment');

        const lines = (await response.text()).split('\r\n').filter(Boolean);
        expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.join(','));
        // The whole filter, not a page of it: the export ignores `limit` by
        // taking none (`dto/audit.dto.ts`).
        expect(lines).toHaveLength(expected.total + 1);
        expect(lines[1].split(',')[0]).toBe(expected.data[0].id);
      });

      it('records audit.exported, in the tenant, with the filter and the count', async () => {
        const auditor = await asAuditor();
        const marker = fixture.acme.targetId;

        const before = await read(
          auditor,
          `?action=${AUDIT_ACTIONS.AUDIT_EXPORTED}&limit=100`,
        );
        const response = await call(auditor, `/iam/audit/export?target_id=${marker}`);
        expect(response.status).toBe(200);
        const rows = (await response.text()).split('\r\n').filter(Boolean).length - 1;

        const after = await read(
          auditor,
          `?action=${AUDIT_ACTIONS.AUDIT_EXPORTED}&limit=100`,
        );

        expect(after.total).toBe(before.total + 1);
        // Doc 10 §7's whole point: taking a copy away is itself an event, and it
        // names who, when, what filter and how many rows.
        expect(after.data[0]).toMatchObject({
          client_id: fixture.acme.clientId,
          actor_type: 'user',
          actor_id: fixture.acme.auditorUserId,
          target_type: 'audit',
          target_id: null,
          payload: { rows, filter: { target_id: marker } },
        });
      });

      it('leaves the export out of its own file', async () => {
        // The record is written after the last row is read, so the document a
        // reviewer receives never ends with "somebody exported this document".
        const auditor = await asAuditor();
        const csv = await (
          await call(auditor, `/iam/audit/export?action=${AUDIT_ACTIONS.AUDIT_EXPORTED}`)
        ).text();

        const again = await (
          await call(auditor, `/iam/audit/export?action=${AUDIT_ACTIONS.AUDIT_EXPORTED}`)
        ).text();

        // The second export sees the first one's record, and neither sees its
        // own: exactly one row more.
        expect(again.split('\r\n').filter(Boolean)).toHaveLength(
          csv.split('\r\n').filter(Boolean).length + 1,
        );
      });

      it('is gated exactly as the page is', async () => {
        const response = await call(await asOutsider(), '/iam/audit/export');

        expect(response.status).toBe(403);
      });
    });

    // ── the surface is read-only (Doc 10 §7) ──────────────────────────────

    it('has no route that could change a row', async () => {
      const auditor = await asAuditor();

      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const response = await fetch(`${baseUrl}/iam/audit`, {
          method,
          headers: { authorization: `Bearer ${auditor}` },
        });
        // The router has nothing to match — there is no handler to refuse it.
        expect(response.status).toBe(404);
      }
    });
  },
);

// ── fixtures ────────────────────────────────────────────────────────────────

/** The database's own clock, so the boundaries are the ones it stamped. */
async function now(admin: DataSource): Promise<string> {
  const [row] = (await admin.query('select now() as at')) as { at: Date }[];
  return row.at.toISOString();
}

/** `?from=` / `?to=` want an encoded instant. */
function iso(at: string): string {
  return encodeURIComponent(at);
}

async function elevate(admin: DataSource, clientId: string): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [clientId]);
}

async function asPlatformCatalog(admin: DataSource): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'true', false)`);
  await admin.query(`select set_config('app.current_client_id', '', false)`);
}

/**
 * One tenant, its auditor, and somebody with no grants at all.
 *
 * The auditor's authorization comes from `testing/authorization.fixture.ts` —
 * the same four facts `POST /iam/clients/:id/admins` establishes for a real
 * tenant, one of which is the `iam.client.audit.read` this endpoint is gated on.
 * The outsider gets none of them, which is what makes deny-by-default
 * observable rather than assumed.
 */
async function seedTenant(
  admin: DataSource,
  label: string,
  secretHash: string,
): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const tenant: Tenant = {
    clientId: randomUUID(),
    slug: `${PREFIX}${label}-${suffix}`,
    rootId: '',
    auditorEmail: `auditor-${label}-${suffix}@example.test`,
    auditorUserId: randomUUID(),
    outsiderEmail: `outsider-${label}-${suffix}@example.test`,
    outsiderUserId: randomUUID(),
    targetId: randomUUID(),
  };

  await elevate(admin, tenant.clientId);

  await admin.query(
    `insert into ${S}."client" (id, name, slug, status) values ($1, $2, $3, 'active')`,
    [tenant.clientId, `Session 25 ${label} ${suffix}`, tenant.slug],
  );

  for (const [id, email, name] of [
    [tenant.auditorUserId, tenant.auditorEmail, 'Session 25 Auditor'],
    [tenant.outsiderUserId, tenant.outsiderEmail, 'Session 25 Outsider'],
  ] as const) {
    await admin.query(
      `insert into ${S}."user" (id, client_id, email, full_name, status, is_client_admin)
       values ($1, $2, $3, $4, 'active', false)`,
      [id, tenant.clientId, email, name],
    );
    await admin.query(
      `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
       values ($1, $2, 'password', $3)`,
      [tenant.clientId, id, secretHash],
    );
  }

  const root = await seedRootScopeNode(admin, tenant.clientId, `Session 25 ${label}`);
  tenant.rootId = root.id;

  await grantIamClientAdmin(admin, tenant.clientId, root.id, {
    userId: tenant.auditorUserId,
  });

  return tenant;
}

/**
 * A handful of rows, written the only way rows are written.
 *
 * `iam.write_audit` derives `client_id` and `actor_id` from the session context
 * and takes no parameter for either (migration 0010), so the context is set
 * first and the rows come out attributed exactly as a request's would be. That
 * is what makes these fixtures worth having: an `insert` — which the app role
 * could not issue anyway — would let this suite fabricate a shape production can
 * never produce.
 */
async function seedTrail(
  admin: DataSource,
  tenant: Tenant,
  batch: 'first' | 'second',
): Promise<void> {
  await admin.query(`select set_config('app.is_platform_admin', 'false', false)`);
  await admin.query(`select set_config('app.current_client_id', $1, false)`, [
    tenant.clientId,
  ]);
  await admin.query(`select set_config('app.current_user_id', $1, false)`, [
    tenant.auditorUserId,
  ]);

  const rows =
    batch === 'first'
      ? ([
          ['user.created', 'user', tenant.targetId],
          ['role.created', 'role', randomUUID()],
        ] as const)
      : ([
          ['user.created', 'user', tenant.targetId],
          ['user.disabled', 'user', tenant.targetId],
        ] as const);

  for (const [action, targetType, targetId] of rows) {
    await admin.query(`select ${S}.write_audit($1, $2, $3, $4::jsonb)`, [
      action,
      targetType,
      targetId,
      JSON.stringify({ suite: PREFIX, batch }),
    ]);
  }

  await admin.query(`select set_config('app.current_user_id', '', false)`);
}

/**
 * The `client_id is null` row of Doc 10 §2 — a platform-level action.
 *
 * No tenant, and no actor either: this is the shape `platform.bootstrap` has.
 * It exists so that "a platform admin sees all audit **including** the
 * platform rows" has something to be true of.
 */
async function seedPlatformRow(admin: DataSource): Promise<string> {
  await asPlatformCatalog(admin);
  await admin.query(`select set_config('app.current_user_id', '', false)`);

  const targetId = randomUUID();
  await admin.query(`select ${S}.write_audit($1, $2, $3, $4::jsonb)`, [
    'client.created',
    'client',
    targetId,
    JSON.stringify({ suite: PREFIX }),
  ]);

  return targetId;
}

/**
 * Removes this suite's tenants and the rows they caused.
 *
 * Three groups. The fixture tenants' rows go with their client; the
 * platform-level row is identified by the marker in its own payload; and the
 * rows the *application* wrote while the suite ran — the denials, the exports —
 * are attributed to whoever called, which for every call but one is a fixture
 * tenant and therefore already covered. The exception is any `audit.exported`
 * that landed outside them, swept by action within `startedAt`'s window: as
 * narrow an identification as an append-only table allows, and narrow enough
 * that a concurrent suite's rows cannot be reached by accident.
 */
async function purge(admin: DataSource, startedAt?: string): Promise<void> {
  await asPlatformCatalog(admin);

  const clients = (await admin.query(`select id from ${S}."client" where slug like $1`, [
    `${PREFIX}%`,
  ])) as { id: string }[];

  for (const { id } of clients) {
    await elevate(admin, id);
    for (const statement of [
      `delete from ${S}."role_binding" where client_id = $1`,
      `delete from ${S}."session" where client_id = $1`,
      `delete from ${S}."user_identity" where client_id = $1`,
      `delete from ${S}."user" where client_id = $1`,
      `delete from ${S}."role_permission" where role_id in
         (select id from ${S}."role" where client_id = $1)`,
      `delete from ${S}."role" where client_id = $1`,
      `delete from ${S}."client_application" where client_id = $1`,
      `delete from ${S}."audit_trail" where client_id = $1`,
      `delete from ${S}."scope_node" where client_id = $1`,
    ]) {
      await admin.query(statement, [id]);
    }
    await admin.query(`delete from ${S}."client" where id = $1`, [id]);
  }

  await asPlatformCatalog(admin);

  // The platform-level row this suite seeded, by its own marker.
  await admin.query(
    `delete from ${S}."audit_trail"
      where client_id is null and payload->>'suite' = $1`,
    [PREFIX],
  );

  // Anything the application wrote under the platform tenant during the run.
  // Bounded by both the action and the window, which is as narrow an
  // identification as an append-only table allows.
  if (startedAt !== undefined) {
    await admin.query(
      `delete from ${S}."audit_trail"
        where action = $1 and created_at >= $2::timestamptz`,
      [AUDIT_ACTIONS.AUDIT_EXPORTED, startedAt],
    );
  }
}
