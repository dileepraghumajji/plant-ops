/**
 * 0018 — resolving a single-tenant deployment's pinned client (roadmap Session
 * 44, Doc 11 §6.5, Doc 07 §6).
 *
 * ## The problem this one function exists for
 *
 * In `DEPLOYMENT_MODE=single_tenant` the process serves exactly one tenant, and
 * that tenant is named in configuration by slug. The API has to turn that slug
 * into a client at boot — before any request, therefore before any JWT, and
 * therefore before there is an RLS context of any kind.
 *
 * `client` carries `force row level security` with
 * `using (is_platform_admin or id = current_client_id)` (migration 0007), so
 * with no context set the table reads as empty. That is exactly right and must
 * stay that way: `applyRlsContext` accepts only verified claims, and the lint
 * gate in `eslint.config.mjs` refuses a raw `set_config('app.…')` anywhere
 * outside `rls-context.ts`. So the boot check cannot elevate itself, and it
 * should not be able to.
 *
 * The sanctioned way out is the one migration 0012 already takes for the same
 * shape of problem — "the tenant is what this function is being asked to find":
 * a `security definer` function that elevates for the length of one lookup and
 * puts the context back before it returns.
 *
 * ## Why it is not `auth_lookup_password_identity`
 *
 * That function answers the same question as a side effect — it returns one row
 * per client — and calling it with a sentinel email would work today. It would
 * also mean a deployment-mode check that breaks the day somebody narrows the
 * login lookup, for reasons that have nothing to do with deployment modes. One
 * question, one function, with its own name in the failure message.
 *
 * ## What it deliberately does not do
 *
 * It takes a slug and returns a row. It does not read configuration, decide
 * anything about deployment mode, or cache. Everything about *whether* the
 * answer is acceptable — a missing client, a suspended one — belongs to
 * `apps/iam-api/src/config/deployment-mode.ts`, where the error message can say
 * which variable to fix.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { APP_GROUP_ROLE } from './0007-rls-tenant.js';
import { PLATFORM_CLIENT_SLUG } from './0011-bootstrap-seed.js';

const S = `"${IAM_SCHEMA}"`;

/** Signatures, for the grants and the drops. */
const FUNCTION_SIGNATURES = [
  'deployment_lookup_client(text)',
  'deployment_has_tenants()',
] as const;

export class PinnedClientLookup1786406400018 implements MigrationInterface {
  name = 'PinnedClientLookup1786406400018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create or replace function ${S}.deployment_lookup_client(_slug text)
      returns table (
        client_id     uuid,
        client_name   text,
        client_status text
      )
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
      begin
        -- Elevated for one select, and put back before returning — the same
        -- pattern, and the same reason, as migration 0012's lookups.
        perform set_config('app.is_platform_admin', 'true', true);

        return query
          select c.id, c.name, c.status::text
            from ${S}."client" c
           where c.slug = _slug;

        perform set_config('app.is_platform_admin', _prev_platform, true);
      end;
      $fn$;
    `);

    // ── "Has this installation been provisioned yet?" ──────────────────────
    //
    // Needed because the pinned client is created *through the API*, by the
    // installer, after the API is running — so on a first boot the slug
    // legitimately names nothing yet, and refusing to start would be a deadlock
    // rather than a safety check (`deploy/bootstrap.sh` restarts the API once
    // the tenant exists, which is when the strict check becomes meaningful).
    //
    // The two situations have to be told apart, and this is what tells them:
    // an empty installation has exactly one client, the platform identity
    // migration 0011 seeds. Any *other* client means this database has been
    // provisioned, and a pinned slug that names nothing in it is a
    // misconfiguration rather than a not-yet.
    await queryRunner.query(`
      create or replace function ${S}.deployment_has_tenants()
      returns boolean
      language plpgsql
      security definer
      set search_path = ${IAM_SCHEMA}, pg_temp
      as $fn$
      declare
        _prev_platform text := coalesce(current_setting('app.is_platform_admin', true), '');
        _any boolean;
      begin
        perform set_config('app.is_platform_admin', 'true', true);

        select exists (
          select 1 from ${S}."client" c where c.slug <> '${PLATFORM_CLIENT_SLUG}'
        ) into _any;

        perform set_config('app.is_platform_admin', _prev_platform, true);
        return _any;
      end;
      $fn$;
    `);

    // Strip the implicit `execute to public` every new function comes with.
    // Left in place, a SECURITY DEFINER function hands these paths to every role
    // in the cluster (Doc 07 §6).
    for (const signature of FUNCTION_SIGNATURES) {
      await queryRunner.query(`revoke all on function ${S}.${signature} from public;`);
      await queryRunner.query(
        `grant execute on function ${S}.${signature} to ${APP_GROUP_ROLE};`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const signature of [...FUNCTION_SIGNATURES].reverse()) {
      await queryRunner.query(`drop function if exists ${S}.${signature};`);
    }
  }
}
