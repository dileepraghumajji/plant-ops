/**
 * Break-glass recovery of a client administrator (roadmap Session 45,
 * Doc 11 §6.4, §12 decision 4).
 *
 *   ./bootstrap.sh --break-glass --client <slug> --email <address>
 *   docker compose run --rm --entrypoint tsx migrate break-glass-admin.ts …
 *   npx tsx tools/break-glass-admin.ts --client <slug> --email <address>
 *
 * A self-hosted install on a plant network has no egress, and we are not
 * reachable from it. If the only administrator locks themselves out at 3am,
 * withholding a way back in does not protect anything — it manufactures an
 * outage that nobody, us included, is in a position to fix. So there is a way
 * back in.
 *
 * ## Why it is a command and not a permission
 *
 * `iam.platform.client.admin.create` would do this from a browser, and Doc 11
 * §12 decision 4 calls that "the better 3am experience" — but it would then sit
 * in a role for the life of the deployment, held by whoever holds the role,
 * usable without anybody noticing. This costs a shell on the server, the current
 * platform credential, and an audit record that says plainly what happened. The
 * capability is the same; what differs is that it leaves a mark and cannot be
 * exercised by accident.
 *
 * Somebody who can run this already has the database — that is the honest
 * framing of Doc 11 §6.2, and it is why the bootstrap secret here is a
 * *deliberateness* check rather than a security boundary. It is still verified
 * against the stored hash rather than compared to a string in the environment,
 * so a stale value in `.env` is refused instead of quietly accepted.
 *
 * ## Why it goes to the database rather than to the API
 *
 * Two reasons, and the second is the one that matters.
 *
 * 1. There is no API path for half of it. Creating an administrator is
 *    `POST /iam/clients/:id/admins`, which the platform identity can call — but
 *    *unlocking* one is `PATCH /iam/users/:id`, gated on `iam.client.user.update`
 *    in the tenant, and a platform token's `cid` is the platform client. The
 *    platform tier deliberately holds no client-tier user permissions
 *    (migration 0017), so there is nothing to call.
 * 2. The realistic reason to run this is that the console or the API is not
 *    working. A recovery tool that needs the thing being recovered is not a
 *    recovery tool.
 *
 * ## What it does, and what it deliberately does not
 *
 * One operation with one meaning: **make this address a working administrator of
 * this organisation, with a password you are about to be shown.**
 *
 * - The user exists → it is returned to `active`, its failed-attempt counter is
 *   cleared, its password is replaced, and its sessions are revoked.
 * - The user does not exist → it is created, with a password identity and a
 *   binding to the tenant's existing `Client Admin` role at its existing root
 *   scope node.
 * - Either way the grant is made good: created when absent, and *un-expired*
 *   when it is there but timed out — which is a state the unique index makes
 *   impossible to fix by inserting, see {@link recover}.
 *
 * It **adopts** that role and that scope; it never creates them. A tenant with
 * neither has never been provisioned, and what it needs is `deploy/bootstrap.sh`,
 * not this. Refusing there keeps the four-row provisioning rule in
 * `client-admin.service.ts` as the single definition of what an administrator is
 * — this file recovers one, it does not re-invent one.
 *
 * ## One honest limitation
 *
 * Revoking the sessions writes `revoked_at`, which is authoritative and stops
 * every refresh (migration 0013 reads the row). It does **not** reach the
 * revocation cache the running API consults first, because this process has no
 * Redis connection and no business opening one. An access token issued before
 * the recovery therefore keeps working until it expires — minutes, bounded by
 * `ACCESS_TOKEN_TTL`. Worth knowing; not worth a second code path to close.
 *
 * Lives in `tools/` for the reason `release-migrate.ts` gives: it needs both
 * `@plantops/config` and `@plantops/db`, and `libs/db` may depend only on
 * `@plantops/contracts` (Doc 08 §2). `tools/` is outside the boundary graph.
 */

import { migrationEnvSchema, type MigrationEnvConfig } from '@plantops/config';
import {
  BOOTSTRAP_SECRET_ENV,
  CLIENT_ADMIN_ROLE_NAME,
  IAM_SCHEMA,
  ONPREM_AUDIT_ACTIONS,
  PLATFORM_SERVICE_ACCOUNT_KEY,
  createMigrationDataSource,
  hashSecret,
  verifySecret,
} from '@plantops/db';
import { config as loadDotenv } from 'dotenv';
import { randomBytes } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

const S = `"${IAM_SCHEMA}"`;

/**
 * Long enough to be past `PASSWORD_MIN_LENGTH` several times over, and short
 * enough that somebody can read it off a terminal and type it into a login form
 * on a machine that cannot copy and paste from this one.
 */
const GENERATED_PASSWORD_BYTES = 18;

interface Options {
  clientSlug: string;
  email: string;
  fullName: string;
  reason: string;
}

const USAGE =
  'Usage: break-glass-admin --client <slug> --email <address>\n' +
  '                        [--name "Full Name"] [--reason "why"]\n\n' +
  'Creates or recovers an administrator of the named organisation and prints a\n' +
  'new password once. Needs DATABASE_DIRECT_URL and the current\n' +
  'PLATFORM_BOOTSTRAP_SECRET. See deploy/README.md §4.';

/**
 * Flags only, no positional arguments.
 *
 * The values are all non-secret — an email, a slug, a sentence — so an argument
 * list is the right place for them. The one secret this needs comes from the
 * environment, as it does everywhere else in the install.
 */
function parseOptions(argv: readonly string[]): Options {
  // Handled before anything else, and answering 0. Somebody reaching for this
  // file is usually locked out and guessing at its arguments; "--help needs a
  // value" is the wrong thing to say to them.
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) {
      throw new Error(`Unexpected argument "${flag}".\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a value.\n${USAGE}`);
    }
    values.set(flag.slice(2), value);
    index += 1;
  }

  const known = new Set(['client', 'email', 'name', 'reason']);
  const unknown = [...values.keys()].filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unrecognised: --${unknown.join(', --')}\n${USAGE}`);
  }

  const clientSlug = values.get('client')?.trim() ?? '';
  const email = values.get('email')?.trim().toLowerCase() ?? '';
  if (clientSlug === '' || email === '') {
    throw new Error(`--client and --email are both required.\n${USAGE}`);
  }

  return {
    clientSlug,
    email,
    fullName: values.get('name')?.trim() || 'Break-glass administrator',
    // Free text, and it lands in the audit payload. Defaulted rather than
    // required: an operator locked out at 3am should not be arguing with an
    // argument parser, and "not stated" is itself an honest record.
    reason: values.get('reason')?.trim() || 'not stated',
  };
}

/** Validates the same narrow environment the migration runner uses. */
function loadEnv(source: NodeJS.ProcessEnv): MigrationEnvConfig {
  const result = migrationEnvSchema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    return `  - ${name}: ${issue.message}`;
  });
  throw new Error(
    `Invalid environment:\n${issues.join('\n')}\n\n` +
      'This tool needs DATABASE_DIRECT_URL (the owning role) and DATABASE_SSL, ' +
      `plus ${BOOTSTRAP_SECRET_ENV}.`,
  );
}

/**
 * The platform context every statement below runs in.
 *
 * `force row level security` (Doc 07 §5.1) applies to the owning role too, so
 * the owner connection sees nothing without this — the same reason migration
 * 0011 sets it before its own inserts. Session-scoped (`false`) rather than
 * transaction-local, because the tenant is switched once the client is known and
 * the process exits immediately afterwards; nothing else will ever be handed
 * this connection.
 */
async function elevate(manager: EntityManager, clientId?: string): Promise<void> {
  await manager.query(`select set_config('app.is_platform_admin', 'true', false)`);
  if (clientId !== undefined) {
    await manager.query(`select set_config('app.current_client_id', $1, false)`, [
      clientId,
    ]);
  }
}

/**
 * Refuses unless the caller holds the credential the platform identity was
 * seeded or last rotated with.
 *
 * Verified against `service_account.key_hash` rather than against a value in the
 * environment: the point is to prove the operator holds the *current* platform
 * credential, and an install that followed the runbook rotated the one that was
 * in `.env` at install time. A stale value fails here, loudly, instead of
 * granting a recovery to somebody reading an old file.
 */
async function assertBootstrapSecret(manager: EntityManager): Promise<void> {
  const secret = process.env[BOOTSTRAP_SECRET_ENV];
  if (secret === undefined || secret.trim() === '') {
    throw new Error(
      `${BOOTSTRAP_SECRET_ENV} is not set.\n\n` +
        'A finished installation deliberately does not keep it (Doc 07 §8), so ' +
        'this is expected — put the current platform credential back into .env ' +
        'for the length of this recovery, and remove it again afterwards.',
    );
  }

  const rows = (await manager.query(
    `select key_hash, status from ${S}."service_account" where key = $1`,
    [PLATFORM_SERVICE_ACCOUNT_KEY],
  )) as { key_hash: string; status: string }[];

  const account = rows[0];
  if (account === undefined) {
    throw new Error(
      `No service account with key "${PLATFORM_SERVICE_ACCOUNT_KEY}" exists in ` +
        'this database. It is created by migration 0011 — this database has not ' +
        'been migrated, or is not a PlantOps database.',
    );
  }
  if (account.status !== 'active') {
    throw new Error(
      `The platform identity is "${account.status}". Reactivate it before using ` +
        'this tool; a revoked credential is not a credential.',
    );
  }
  if (!(await verifySecret(account.key_hash, secret))) {
    throw new Error(
      `${BOOTSTRAP_SECRET_ENV} does not match the stored platform credential.\n\n` +
        'If the installation was rotated as the runbook instructs, the value you ' +
        'need is the one printed by `./bootstrap.sh --rotate-platform-secret`, ' +
        'not the one the install started with.',
    );
  }
}

interface ClientRow {
  id: string;
  name: string;
  slug: string;
}

interface UserRow {
  id: string;
  email: string;
  status: string;
}

/**
 * What happened to the administrator's grant at the tenant's root scope.
 *
 * `expiry_cleared` is its own state rather than folded into `created`, because
 * the two are different facts about how the lockout happened and the audit
 * record should not blur them: one account never had the grant, the other had it
 * and outlived it.
 */
type BindingOutcome = 'created' | 'expiry_cleared' | 'unchanged';

interface Outcome {
  created: boolean;
  userId: string;
  password: string;
  revokedSessions: number;
  binding: BindingOutcome;
}

/**
 * The recovery itself, in one transaction.
 *
 * All of it or none of it: a user with no password identity is an account that
 * cannot log in, and a user with no binding is an account that can log in and do
 * nothing. Either would be a worse state than the one being recovered from.
 */
async function recover(manager: EntityManager, options: Options): Promise<Outcome> {
  const [client] = (await manager.query(
    `select id, name, slug from ${S}."client" where slug = $1`,
    [options.clientSlug],
  )) as ClientRow[];

  if (client === undefined) {
    throw new Error(
      `No organisation with the slug "${options.clientSlug}" exists. ` +
        'Check PLANTOPS_CLIENT_SLUG in .env.',
    );
  }

  // From here on every statement is checked against the tenant, not against the
  // platform flag (migrations 0007 and 0009).
  await elevate(manager, client.id);

  const password = randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
  const secretHash = await hashSecret(password);

  const [existing] = (await manager.query(
    `select id, email, status from ${S}."user" where client_id = $1 and lower(email) = $2`,
    [client.id, options.email],
  )) as UserRow[];

  const userId =
    existing?.id ??
    (
      (await manager.query(
        `insert into ${S}."user" (client_id, email, full_name, status, is_client_admin)
         values ($1, $2, $3, 'active', true)
         returning id`,
        [client.id, options.email, options.fullName],
      )) as { id: string }[]
    )[0].id;

  if (existing !== undefined) {
    // Returned to `active` from `locked` *or* `disabled`. The API refuses the
    // second of those transitions (`refuseIllegalTransition`) and is right to:
    // re-enabling somebody who was offboarded should be a deliberate act by a
    // named administrator. This *is* that deliberate act, performed by somebody
    // holding the platform credential, and it is recorded as one.
    await manager.query(
      `update ${S}."user"
          set status = 'active',
              failed_login_attempts = 0,
              last_failed_login_at = null,
              is_client_admin = true
        where id = $1 and client_id = $2`,
      [userId, client.id],
    );
  }

  await manager.query(
    `insert into ${S}."user_identity" (client_id, user_id, provider, secret_hash)
     values ($1, $2, 'password', $3)
     on conflict (user_id, provider)
       do update set secret_hash = excluded.secret_hash, updated_at = now()`,
    [client.id, userId, secretHash],
  );

  const [adminRole] = (await manager.query(
    `select id from ${S}."role" where client_id = $1 and name = $2 and is_system`,
    [client.id, CLIENT_ADMIN_ROLE_NAME],
  )) as { id: string }[];

  const [rootScope] = (await manager.query(
    `select id from ${S}."scope_node"
      where client_id = $1 and parent_id is null
      order by created_at asc, id asc
      limit 1`,
    [client.id],
  )) as { id: string }[];

  if (adminRole === undefined || rootScope === undefined) {
    // Deliberately after the writes above and inside the transaction, which
    // rolls back: it means the check reports the *real* obstacle rather than an
    // ordering artefact, and nothing is left behind.
    throw new Error(
      `Organisation "${client.slug}" has no ${adminRole === undefined ? `"${CLIENT_ADMIN_ROLE_NAME}" role` : 'root scope node'}, ` +
        'which means it has never been provisioned.\n\n' +
        'This tool recovers an administrator; it does not create an organisation. ' +
        'Run ./bootstrap.sh instead.',
    );
  }

  // Three states, not two, and the third is the one that matters.
  //
  // `role_binding_subject_role_scope_key` (migration 0004) is unique on
  // (subject, role, scope) and says nothing about `expires_at` — so an
  // administrator whose binding merely *expired* still occupies the row. An
  // insert guarded on "no live binding exists" would hit that index and abort
  // the whole recovery, in precisely the case this tool exists for. The expiry
  // is cleared instead.
  const [currentBinding] = (await manager.query(
    `select id, expires_at from ${S}."role_binding"
      where client_id = $1 and user_id = $2 and role_id = $3 and scope_node_id = $4`,
    [client.id, userId, adminRole.id, rootScope.id],
  )) as { id: string; expires_at: Date | null }[];

  let binding: BindingOutcome;
  if (currentBinding === undefined) {
    await manager.query(
      `insert into ${S}."role_binding" (client_id, user_id, role_id, scope_node_id)
       values ($1, $2, $3, $4)`,
      [client.id, userId, adminRole.id, rootScope.id],
    );
    binding = 'created';
  } else if (currentBinding.expires_at !== null) {
    await manager.query(
      `update ${S}."role_binding" set expires_at = null where id = $1`,
      [currentBinding.id],
    );
    binding = 'expiry_cleared';
  } else {
    binding = 'unchanged';
  }

  // The password changed, so anything already signed in with the old one should
  // stop. See the header for what this does and does not reach.
  const revoked = (await manager.query(
    `with revoked as (
       update ${S}."session" s
          set revoked_at = now()
        where s.user_id = $1 and s.revoked_at is null
        returning s.id
     )
     select id from revoked`,
    [userId],
  )) as { id: string }[];

  // One record, naming the act rather than its parts. `user.created` and
  // `auth.account.unlocked` would both be true and neither would be legible as
  // what this was (Doc 11 §6.4). The password is not in the payload and could
  // not be — the redaction boundary denies the key outright (Doc 10 §8).
  await manager.query(
    `select ${S}.write_audit($1, 'user', $2, $3::jsonb)`,
    [
      ONPREM_AUDIT_ACTIONS.BREAK_GLASS,
      userId,
      JSON.stringify({
        email: options.email,
        client_slug: client.slug,
        outcome: existing === undefined ? 'created' : 'recovered',
        previous_status: existing?.status ?? null,
        password_reset: true,
        role_binding: binding,
        sessions_revoked: revoked.length,
        reason: options.reason,
        performed_via: 'tools/break-glass-admin.ts',
      }),
    ],
  );

  return {
    created: existing === undefined,
    userId,
    password,
    revokedSessions: revoked.length,
    binding,
  };
}

function report(options: Options, outcome: Outcome): void {
  const lines = [
    '',
    '────────────────────────────────────────────────────────────────────────────',
    outcome.created
      ? `Created ${options.email} as an administrator of "${options.clientSlug}".`
      : `Recovered ${options.email} in "${options.clientSlug}".`,
    '',
    `  organisation  ${options.clientSlug}`,
    `  email         ${options.email}`,
    `  password      ${outcome.password}`,
    '',
    'This is the only time the password will be shown. Sign in with it and change',
    'it immediately — it was generated by a recovery tool and has been printed to',
    'a terminal.',
    '',
  ];

  if (!outcome.created) {
    lines.push(
      `The account was returned to "active" and its failed-attempt counter cleared.`,
    );
    if (outcome.revokedSessions > 0) {
      lines.push(
        `${outcome.revokedSessions} session(s) were revoked; an access token issued`,
        'before now may still work for the few minutes until it expires.',
      );
    }
    if (outcome.binding === 'created') {
      lines.push(
        `It had no "${CLIENT_ADMIN_ROLE_NAME}" grant at the root scope. One was created.`,
      );
    } else if (outcome.binding === 'expiry_cleared') {
      lines.push(
        `Its "${CLIENT_ADMIN_ROLE_NAME}" grant at the root scope had expired. The expiry was removed.`,
      );
    }
    lines.push('');
  }

  lines.push(
    `Recorded in the audit trail as "${ONPREM_AUDIT_ACTIONS.BREAK_GLASS}", with the reason`,
    `"${options.reason}". Remove ${BOOTSTRAP_SECRET_ENV} from .env again now.`,
    '────────────────────────────────────────────────────────────────────────────',
    '',
  );

  console.log(lines.join('\n'));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  // A no-op where a platform's secret store already populated `process.env`;
  // present so the same command works from a developer's shell.
  loadDotenv();
  const env = loadEnv(process.env);

  let dataSource: DataSource | undefined;
  try {
    dataSource = createMigrationDataSource(env);
    await dataSource.initialize();

    const outcome = await dataSource.transaction(async (manager) => {
      await elevate(manager);
      await assertBootstrapSecret(manager);
      return recover(manager, options);
    });

    report(options, outcome);
  } finally {
    if (dataSource?.isInitialized === true) await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\nbreak-glass-admin failed.\n\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
