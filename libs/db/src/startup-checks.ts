/**
 * Boot-time assertions that RLS can actually take effect (Doc 07 §5, §5.1).
 *
 * These run before the API serves its first request and abort the process if
 * they fail. They exist because every RLS bypass is **silent**: policies do not
 * error when they are skipped, they simply stop filtering, and the application
 * keeps returning rows that look entirely plausible — other tenants' rows.
 *
 * There are three ways a connection escapes RLS, and a check that tests only
 * the first two is actively dangerous, because it gets quoted as proof:
 *
 * 1. `SUPERUSER`
 * 2. `BYPASSRLS`
 * 3. **owning the table** — an owner is exempt from its own policies,
 *    regardless of the other two. This is the one Doc 07 §5 originally missed;
 *    measured behaviour and the fix are in §5.1.
 *
 * The fourth assertion is the mirror image: policies that exist but are not
 * `FORCE`d would still be skipped for an owner, so a table carrying policies
 * without `relforcerowsecurity` is reported too.
 */

import type { DataSource } from 'typeorm';
import { IAM_SCHEMA } from './schema.js';

/** Tables intentionally exempt from `force row level security` (Doc 07 §5.1). */
const FORCE_EXEMPT_TABLES: readonly string[] = [
  // `iam.write_audit` is SECURITY DEFINER and relies on the owner path to
  // insert. The app role is stopped here by privilege — it holds no INSERT —
  // which is a stronger barrier than a policy.
  'audit_trail',
];

export interface StartupCheckResult {
  readonly role: string;
  readonly failures: readonly string[];
}

/** Thrown when the connection cannot enforce RLS. Fatal by design. */
export class RlsStartupCheckError extends Error {
  constructor(public readonly result: StartupCheckResult) {
    super(
      `Refusing to start: the database role "${result.role}" cannot enforce row-level security.\n` +
        result.failures.map((failure) => `  - ${failure}`).join('\n') +
        '\nSee Doc 07 §5.1 and tools/setup-db-roles.sql.',
    );
    this.name = 'RlsStartupCheckError';
  }
}

/**
 * Runs every assertion and returns them rather than throwing, so a health
 * endpoint or a test can inspect the result. {@link assertRlsEnforceable}
 * is the fatal wrapper.
 */
export async function checkRlsEnforceable(
  dataSource: DataSource,
): Promise<StartupCheckResult> {
  const failures: string[] = [];

  const [role] = (await dataSource.query(
    `select current_user as name,
            (select rolsuper     from pg_roles where rolname = current_user) as is_super,
            (select rolbypassrls from pg_roles where rolname = current_user) as is_bypassrls`,
  )) as { name: string; is_super: boolean; is_bypassrls: boolean }[];

  if (role === undefined) {
    return { role: 'unknown', failures: ['could not resolve current_user'] };
  }

  if (role.is_super) {
    failures.push('it is a SUPERUSER — every policy is skipped');
  }
  if (role.is_bypassrls) {
    failures.push('it has BYPASSRLS — every policy is skipped');
  }

  // (3) ownership. An owner is exempt from its own table's policies unless the
  // table is FORCEd, and relying on FORCE alone leaves no margin for a table
  // added later without it.
  const owned = (await dataSource.query(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind = 'r' and c.relowner = current_user::regrole
      order by c.relname`,
    [IAM_SCHEMA],
  )) as { relname: string }[];

  if (owned.length > 0) {
    failures.push(
      `it owns ${owned.length} table(s) in "${IAM_SCHEMA}" (${owned
        .slice(0, 3)
        .map((row) => row.relname)
        .join(', ')}${owned.length > 3 ? ', …' : ''}) — an owner is exempt from its ` +
        'own policies. Connect as the non-owning app role; migrations use the owner.',
    );
  }

  // (4) any table carrying policies but not forced.
  const unforced = (await dataSource.query(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1
        and c.relkind = 'r'
        and c.relrowsecurity
        and not c.relforcerowsecurity
        and c.relname <> all($2::text[])
      order by c.relname`,
    [IAM_SCHEMA, [...FORCE_EXEMPT_TABLES]],
  )) as { relname: string }[];

  if (unforced.length > 0) {
    failures.push(
      `these tables have RLS enabled but not FORCEd, so their owner bypasses them: ` +
        unforced.map((row) => row.relname).join(', '),
    );
  }

  return { role: role.name, failures };
}

/** {@link checkRlsEnforceable}, but fatal — call this from bootstrap. */
export async function assertRlsEnforceable(dataSource: DataSource): Promise<void> {
  const result = await checkRlsEnforceable(dataSource);
  if (result.failures.length > 0) {
    throw new RlsStartupCheckError(result);
  }
}
