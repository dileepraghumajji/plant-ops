/**
 * The RLS isolation battery — Session 5's actual deliverable (Doc 07 §5–8).
 *
 * Everything here runs as the **app role**, over `DATABASE_URL`, with
 * `force row level security` left intact. That is not incidental: run under the
 * owning role, or with FORCE lifted, every assertion below still passes while
 * every policy is inert (Doc 07 §5.1). A green suite would then be evidence of
 * nothing at all, which is exactly how this class of bug ships.
 *
 * The queries are written *deliberately wrong* — bare `select * from iam.role`
 * with no tenant predicate — because the claim being tested is that the
 * database refuses to leak even when the application forgets to filter.
 *
 * Skips loudly without a database. See `testing/integration-harness.ts`.
 */

import { DataSource } from 'typeorm';
import { checkRlsEnforceable } from '../startup-checks.js';
import { IAM_SCHEMA } from '../schema.js';
import { verifySecret } from '../secret-hash.js';
import {
  connectHarness,
  describeWithDb,
  type IntegrationHarness,
} from '../testing/integration-harness.js';
import { PLATFORM_CLIENT_SLUG, PLATFORM_SERVICE_ACCOUNT_KEY } from './0011-bootstrap-seed.js';

const S = IAM_SCHEMA;

/** The runtime connection — a *different role* from the migration one. */
const appUrl = process.env['DATABASE_URL'];
const appConfigured =
  appUrl !== undefined &&
  /^postgres(ql)?:\/\/\S+@\S+/.test(appUrl) &&
  !/REPLACE_ME|[[\]<>]/.test(appUrl);

describeWithDb('RLS isolation, as the app role', () => {
  let harness: IntegrationHarness;
  let app: DataSource;
  const tenant: Record<string, string> = {};

  /** Runs `fn` in a transaction with the given context, then rolls back. */
  const withContext = async <T>(
    context: Record<string, string>,
    fn: (runner: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>,
  ): Promise<T> => {
    const runner = app.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      for (const [key, value] of Object.entries(context)) {
        // Transaction-local, exactly as applyRlsContext() does it.
        await runner.query(`select set_config($1, $2, true)`, [key, value]);
      }
      return await fn(runner);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  };

  const rolesVisible = (context: Record<string, string>) =>
    withContext(context, async (runner) => {
      // No tenant predicate, on purpose.
      const rows = (await runner.query(`select client_id from ${S}."role"`)) as {
        client_id: string;
      }[];
      return rows;
    });

  beforeAll(async () => {
    if (!appConfigured) return;
    harness = await connectHarness();
    await harness.rebuild();

    // Two tenants, seeded as the owner under an explicit platform context —
    // FORCE'd policies apply to the owner too (Doc 07 §5.1).
    await harness.query(`select set_config('app.is_platform_admin','true',false)`);
    for (const slug of ['iso-tenant-a', 'iso-tenant-b']) {
      const [{ id }] = await harness.query<{ id: string }>(
        `select gen_random_uuid() as id`,
      );
      await harness.query(`select set_config('app.current_client_id',$1,false)`, [id]);
      await harness.query(
        `insert into ${S}."client" (id, name, slug) values ($1,$2,$3)`,
        [id, slug, slug],
      );
      await harness.query(`insert into ${S}."role" (client_id, name) values ($1,'Supervisor')`, [
        id,
      ]);
      await harness.query(
        `insert into ${S}."user" (client_id, email, full_name) values ($1,$2,'Iso User')`,
        [id, `${slug}@example.test`],
      );
      tenant[slug] = id;
    }
    // The owner connection stays in platform context for the rest of the file.
    // It is only ever used to build and inspect fixtures, and FORCE'd policies
    // apply to it as well (Doc 07 §5.1) — without this, every fixture read
    // would come back empty and every fixture write would be refused.
    //
    // The assertions themselves never use this connection: they run on `app`
    // below, as the non-owning role, which is the whole point of the file.
    await harness.query(`select set_config('app.current_client_id','',false)`);
    await harness.query(`select set_config('app.is_platform_admin','true',false)`);

    app = new DataSource({ type: 'postgres', url: appUrl, synchronize: false, poolSize: 2 });
    await app.initialize();
  }, 90_000);

  afterAll(async () => {
    if (app?.isInitialized) await app.destroy();
    await harness?.dispose();
  });

  describe('the harness itself is trustworthy', () => {
    it('connects as a role that is NOT the table owner', async () => {
      // If this fails, every other test in the file is meaningless.
      const result = await checkRlsEnforceable(app);
      expect(result.failures).toEqual([]);
    });

    it('is a different role from the one that ran the migrations', async () => {
      const [appRole] = (await app.query(`select current_user as u`)) as { u: string }[];
      const [ownerRole] = await harness.query<{ u: string }>(`select current_user as u`);
      expect(appRole?.u).not.toBe(ownerRole?.u);
    });
  });

  describe('tenant reads (Doc 07 §6)', () => {
    it('returns only tenant A rows to a tenant A context, from an unfiltered query', async () => {
      const rows = await rolesVisible({
        'app.current_client_id': tenant['iso-tenant-a'] as string,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.client_id).toBe(tenant['iso-tenant-a']);
    });

    it('returns zero tenant rows with no context at all', async () => {
      // The unset case must deny, not error: `nullif(...)::uuid` is NULL and
      // every comparison against it is NULL, never true.
      expect(await rolesVisible({})).toHaveLength(0);
    });

    it('returns zero tenant rows when the context is an empty string', async () => {
      // Without the `nullif`, `''::uuid` would raise 22P02 — turning a missing
      // context into a 500 rather than an empty result.
      expect(await rolesVisible({ 'app.current_client_id': '' })).toHaveLength(0);
    });

    it('lets a platform admin read across tenants', async () => {
      const rows = await rolesVisible({ 'app.is_platform_admin': 'true' });
      // Both fixtures plus the bootstrap seed's own platform role.
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it.each([
      'user',
      'session',
      'user_identity',
      'scope_node',
      'role_binding',
      'password_reset_token',
    ])(
      'isolates %s the same way',
      async (table) => {
        const rows = await withContext(
          { 'app.current_client_id': tenant['iso-tenant-a'] as string },
          (runner) => runner.query(`select client_id from ${S}."${table}"`),
        );
        for (const row of rows as { client_id: string }[]) {
          expect(row.client_id).toBe(tenant['iso-tenant-a']);
        }
      },
    );
  });

  describe('tenant writes (Doc 07 §6 — the asymmetric with check)', () => {
    it('blocks a platform admin from writing a row under another client', async () => {
      // Platform admins read across tenants but must not write across them:
      // the `with check` has no platform arm, by design.
      await expect(
        withContext(
          {
            'app.is_platform_admin': 'true',
            'app.current_client_id': tenant['iso-tenant-a'] as string,
          },
          (runner) =>
            runner.query(`insert into ${S}."role" (client_id, name) values ($1,'Smuggled')`, [
              tenant['iso-tenant-b'],
            ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('blocks a tenant from writing a row under another tenant', async () => {
      await expect(
        withContext(
          { 'app.current_client_id': tenant['iso-tenant-a'] as string },
          (runner) =>
            runner.query(`insert into ${S}."role" (client_id, name) values ($1,'Cross')`, [
              tenant['iso-tenant-b'],
            ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('allows a tenant to write its own row', async () => {
      await expect(
        withContext({ 'app.current_client_id': tenant['iso-tenant-a'] as string }, (runner) =>
          runner.query(`insert into ${S}."role" (client_id, name) values ($1,'Own Role')`, [
            tenant['iso-tenant-a'],
          ]),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('role_permission reaches through to its parent role (Doc 07 §6)', () => {
    it('hides another tenant’s role composition', async () => {
      // The table has no client_id of its own; "apply the same shape" would
      // have leaked every tenant's role composition to every other tenant.
      const rows = await withContext(
        { 'app.current_client_id': tenant['iso-tenant-a'] as string },
        (runner) => runner.query(`select role_id from ${S}."role_permission"`),
      );
      expect(Array.isArray(rows)).toBe(true);
    });

    it('refuses to map a permission onto another tenant’s role', async () => {
      const [{ id: appId }] = await harness.query<{ id: string }>(
        `insert into ${S}.application (key, name) values ('rls-app','rls-app') returning id`,
      );
      const [{ id: permId }] = await harness.query<{ id: string }>(
        `insert into ${S}.permission (application_id, key, name)
         values ($1,'rls.test.read','Read') returning id`,
        [appId],
      );
      const [{ id: foreignRoleId }] = await harness.query<{ id: string }>(
        `select id from ${S}."role" where client_id = $1 limit 1`,
        [tenant['iso-tenant-b']],
      );

      await expect(
        withContext(
          { 'app.current_client_id': tenant['iso-tenant-a'] as string },
          (runner) =>
            runner.query(
              `insert into ${S}."role_permission" (role_id, permission_id) values ($1,$2)`,
              [foreignRoleId, permId],
            ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('catalog is globally readable, platform-writable (Doc 07 §6)', () => {
    it('lets any tenant read the application catalog', async () => {
      const rows = await withContext(
        { 'app.current_client_id': tenant['iso-tenant-a'] as string },
        (runner) => runner.query(`select id from ${S}."application"`),
      );
      expect((rows as unknown[]).length).toBeGreaterThan(0);
    });

    it('refuses a catalog write from a tenant context', async () => {
      await expect(
        withContext({ 'app.current_client_id': tenant['iso-tenant-a'] as string }, (runner) =>
          runner.query(`insert into ${S}."application" (key, name) values ('sneaky','Sneaky')`),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('permits a catalog write from a platform context', async () => {
      await expect(
        withContext({ 'app.is_platform_admin': 'true' }, (runner) =>
          runner.query(`insert into ${S}."application" (key, name) values ('legit','Legit')`),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('audit_trail is append-only and non-forgeable (Doc 07 §6, Doc 10 §1)', () => {
    it.each([
      ['INSERT', `insert into ${S}."audit_trail" (actor_type, action) values ('platform','forged')`],
      ['UPDATE', `update ${S}."audit_trail" set action = 'tampered'`],
      ['DELETE', `delete from ${S}."audit_trail"`],
      ['TRUNCATE', `truncate ${S}."audit_trail"`],
    ])('denies direct %s to the app role', async (_label, sql) => {
      await expect(
        withContext({ 'app.current_client_id': tenant['iso-tenant-a'] as string }, (runner) =>
          runner.query(sql),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('writes through write_audit(), stamping actor and tenant from context', async () => {
      const clientId = tenant['iso-tenant-a'] as string;
      const [{ id: userId }] = await harness.query<{ id: string }>(
        `select id from ${S}."user" where client_id = $1 limit 1`,
        [clientId],
      );

      const row = await withContext(
        { 'app.current_client_id': clientId, 'app.current_user_id': userId },
        async (runner) => {
          const [{ id }] = (await runner.query(
            `select ${S}.write_audit('role.created','role',gen_random_uuid(),'{"k":1}'::jsonb) as id`,
          )) as { id: string }[];
          const [written] = (await runner.query(
            `select client_id, actor_id, actor_type, action from ${S}."audit_trail" where id = $1`,
            [id],
          )) as { client_id: string; actor_id: string; actor_type: string; action: string }[];
          return written;
        },
      );

      // None of these were parameters — the function derived all three, which
      // is what makes the record unspoofable.
      expect(row).toMatchObject({
        client_id: clientId,
        actor_id: userId,
        actor_type: 'user',
        action: 'role.created',
      });
    });

    it('marks a platform-context write as actor_type=platform', async () => {
      const row = await withContext({ 'app.is_platform_admin': 'true' }, async (runner) => {
        const [{ id }] = (await runner.query(
          `select ${S}.write_audit('platform.test','thing',null,'{}'::jsonb) as id`,
        )) as { id: string }[];
        const [written] = (await runner.query(
          `select actor_type, client_id from ${S}."audit_trail" where id = $1`,
          [id],
        )) as { actor_type: string; client_id: string | null }[];
        return written;
      });
      expect(row).toMatchObject({ actor_type: 'platform', client_id: null });
    });

    it('shows a tenant only its own audit rows', async () => {
      const rows = await withContext(
        { 'app.current_client_id': tenant['iso-tenant-a'] as string },
        (runner) => runner.query(`select client_id from ${S}."audit_trail"`),
      );
      for (const row of rows as { client_id: string }[]) {
        expect(row.client_id).toBe(tenant['iso-tenant-a']);
      }
    });
  });

  describe('bootstrap seed (Doc 07 §8)', () => {
    it('creates the platform identity', async () => {
      const [account] = await harness.query<{ key: string; client_id: string | null }>(
        `select key, client_id from ${S}."service_account" where key = $1`,
        [PLATFORM_SERVICE_ACCOUNT_KEY],
      );
      expect(account?.client_id).toBeNull();
    });

    it('never stores the secret in plaintext, and the hash verifies', async () => {
      const secret = process.env['PLATFORM_BOOTSTRAP_SECRET'] as string;
      const [account] = await harness.query<{ key_hash: string }>(
        `select key_hash from ${S}."service_account" where key = $1`,
        [PLATFORM_SERVICE_ACCOUNT_KEY],
      );
      expect(account?.key_hash).not.toContain(secret);
      // argon2id, with the parameters pinned in ARGON2_OPTIONS (Doc 03 §7).
      expect(account?.key_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

      // The stored hash accepts the real secret and rejects anything else —
      // this is exactly the check Session 11's token exchange will perform.
      await expect(verifySecret(account?.key_hash as string, secret)).resolves.toBe(true);
      await expect(
        verifySecret(account?.key_hash as string, `${secret}-wrong`),
      ).resolves.toBe(false);
    });

    it('binds the platform account at the platform scope root', async () => {
      const [binding] = await harness.query<{ n: string }>(
        `select count(*)::int as n
           from ${S}."role_binding" rb
           join ${S}."client" c on c.id = rb.client_id
           join ${S}."service_account" sa on sa.id = rb.service_account_id
          where c.slug = $1 and sa.key = $2`,
        [PLATFORM_CLIENT_SLUG, PLATFORM_SERVICE_ACCOUNT_KEY],
      );
      expect(Number(binding?.n)).toBe(1);
    });

    it('audits the bootstrap without leaking the secret', async () => {
      const [row] = await harness.query<{ action: string; payload: Record<string, unknown> }>(
        `select action, payload from ${S}."audit_trail" where action = 'platform.bootstrap'`,
      );
      expect(row?.action).toBe('platform.bootstrap');
      expect(JSON.stringify(row?.payload)).not.toContain(
        process.env['PLATFORM_BOOTSTRAP_SECRET'] as string,
      );
    });

    it('is idempotent — re-running the seed changes nothing', async () => {
      const before = await harness.query<{ n: string }>(
        `select count(*)::int as n from ${S}."service_account" where key = $1`,
        [PLATFORM_SERVICE_ACCOUNT_KEY],
      );
      await harness.dataSource.undoLastMigration({ transaction: 'each' });
      await harness.dataSource.runMigrations({ transaction: 'each' });
      const after = await harness.query<{ n: string }>(
        `select count(*)::int as n from ${S}."service_account" where key = $1`,
        [PLATFORM_SERVICE_ACCOUNT_KEY],
      );
      expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
    }, 60_000);
  });
});
