/**
 * `client_application` — which applications a tenant may run (Doc 06 §5,
 * Doc 02 §3 step 2, Doc 01 §4.1).
 *
 * ## Enablement is what makes a catalog usable by a tenant
 *
 * The application registry (Session 13) says what exists; this says who may have
 * it. Everything downstream keys off these rows: a role may only map permissions
 * belonging to an application **enabled for that role's client** (Doc 02 §6, the
 * rule Session 17 enforces), and a disabled app's permissions are simply absent
 * from resolved grants (Doc 04 §4).
 *
 * ## Disabling preserves, and that is the whole design
 *
 * `enabled = false`, never a delete (Doc 02 §7). The row keeps the tenant's
 * per-application `config` so re-enabling restores it, and every `role_permission`
 * mapping that referenced the app's permissions stays intact but **inert** —
 * which is what makes re-enabling a toggle rather than a re-setup. A delete would
 * be indistinguishable to the operator and destroy exactly that.
 *
 * There is consequently no `DELETE` route, matching Doc 06 §5's table.
 *
 * ## Writes go through the provisioning context
 *
 * `client_application` carries a real `client_id` and gets the tenant policy
 * shape (migration 0009), so its `with check` pins writes to
 * `app.current_client_id` — which, for a platform caller, is the platform
 * tenant. `withProvisioningTenant` points it at the target client for the
 * duration of the write, and the audit rows land in that client's tenant with
 * it. See `clients.service.ts` and `rls-context.ts` for the argument.
 */

import { Injectable } from '@nestjs/common';
import type { ClientApplicationDTO } from '@plantops/contracts';
import { IAM_SCHEMA, withProvisioningTenant } from '@plantops/db';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { GrantInvalidationService } from '../authz/invalidation.service';
import { IamException } from '../common/iam.exception';
import { assertPlatformAdmin } from '../common/platform-admin';
import { afterCommit, entityManager } from '../common/transaction-context';
import { ClientsService } from './clients.service';

const S = `"${IAM_SCHEMA}"`;

/**
 * Every read returns the application's key and name alongside the ids, so the
 * toggle list of Doc 09 §2.2 is renderable from one call.
 */
const SELECT_COLUMNS = `
  ca.client_id, ca.application_id, a.key as application_key, a.name as application_name,
  ca.enabled, ca.config, ca.created_at, ca.updated_at
`;

interface ClientApplicationRow {
  client_id: string;
  application_id: string;
  application_key: string;
  application_name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface EnableApplicationInput {
  application_id?: string;
  application_key?: string;
  config?: Record<string, unknown>;
}

export interface UpdateClientApplicationInput {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

@Injectable()
export class ClientApplicationsService {
  constructor(
    private readonly clients: ClientsService,
    private readonly audit: AuditService,
    private readonly invalidation: GrantInvalidationService,
  ) {}

  /**
   * Doc 04 §7's `client_application` row, for both writers below.
   *
   * "**disabled or re-enabled** → subjects of that client", and the spec spells
   * both directions out because only one of them is obvious. Disabling makes the
   * app's permissions inert, which everyone expects to need a flush; *enabling*
   * changes effective grants just as much, because every `role_permission`
   * mapping that survived the disable (Doc 02 §7 preserves them all) becomes live
   * again in the same instant. A cache written while the app was off holds grant
   * sets with those permissions missing, and without this they would stay missing
   * for up to a TTL after the toggle that restored them — an operator turning an
   * application back on and being told the access is not there yet.
   *
   * Runs inside `withProvisioningTenant`, so `entityManager()` sees the target
   * client rather than the platform tenant the caller is authenticated in — which
   * is what makes `subjectsOfClient` return the tenant's subjects and not none.
   */
  private async invalidateTenant(
    clientId: string,
    applicationId: string,
  ): Promise<void> {
    const subjects = await this.invalidation.subjectsOfClient(clientId);

    afterCommit(() =>
      this.invalidation.publish(clientId, subjects, {
        cause: 'client_application.toggled',
        applicationId,
      }),
    );
  }

  /**
   * Enables applications for a client (Doc 02 §3 step 2).
   *
   * Idempotent, and idempotent in the useful direction: re-enabling something
   * already enabled changes nothing and audits nothing, while re-enabling
   * something previously disabled flips the flag back and **keeps the stored
   * config** unless the call supplies a new one. That last rule is why an
   * omitted (or empty) `config` on a re-enable is treated as "leave it alone" —
   * an operator turning an app back on is restoring a state, not resetting one.
   * `PATCH` is how a config is deliberately cleared.
   *
   * A globally deactivated application is refused with a 409. Doc 02 §7 says
   * `is_active = false` means "hidden everywhere", so enabling one for a tenant
   * would create a row that grants nothing and displays nowhere — a state whose
   * only effect is to mislead whoever reads the toggle list later.
   */
  async enable(
    clientId: string,
    inputs: readonly EnableApplicationInput[],
  ): Promise<ClientApplicationDTO[]> {
    await assertPlatformAdmin();

    const client = await this.clients.findRow(clientId);
    if (client === null) throw IamException.notFound('The client');

    const manager = entityManager();
    const resolved = await this.resolveApplications(inputs);

    return withProvisioningTenant(manager, clientId, async () => {
      const applicationIds = resolved.map((entry) => entry.id);

      // What is already there, so the audit can distinguish a first enablement
      // from a re-enablement from a no-op. Reading first rather than deriving it
      // from `xmax` keeps the intent legible; the only thing it gives up is
      // exactness under two concurrent enablements of the same pair, where the
      // worst outcome is a duplicate `client_application.enabled` record.
      const existing = (await manager.query(
        `select application_id, enabled
           from ${S}."client_application"
          where client_id = $1 and application_id = any($2::uuid[])`,
        [clientId, applicationIds],
      )) as { application_id: string; enabled: boolean }[];

      const before = new Map(existing.map((row) => [row.application_id, row.enabled]));

      const rows: ClientApplicationRow[] = [];
      const audited: AuditEntry[] = [];
      for (const entry of resolved) {
        const [row] = (await manager.query(
          `with upserted as (
             insert into ${S}."client_application" (client_id, application_id, enabled, config)
             values ($1, $2, true, coalesce($3::jsonb, '{}'::jsonb))
             on conflict (client_id, application_id) do update
                set enabled = true,
                    config = case
                               when excluded.config = '{}'::jsonb then client_application.config
                               else excluded.config
                             end
             returning client_id, application_id, enabled, config, created_at, updated_at
           )
           select ${SELECT_COLUMNS}
             from upserted ca
             join ${S}."application" a on a.id = ca.application_id`,
          [
            clientId,
            entry.id,
            entry.config === undefined ? null : JSON.stringify(entry.config),
          ],
        )) as ClientApplicationRow[];

        rows.push(row);

        // Only the rows this call actually turned on — re-enabling what was
        // already enabled writes nothing, the rule `update` states below.
        if (before.get(entry.id) !== true) {
          audited.push({
            action: AUDIT_ACTIONS.CLIENT_APPLICATION_ENABLED,
            target: { type: 'client_application', id: row.application_id },
            payload: { client_id: clientId, application_key: row.application_key },
          });

          // Gated on the same condition as the audit record, and for the same
          // reason: re-enabling something already enabled changed nothing, so
          // there is nothing to invalidate. One publish per application actually
          // turned on — a batch that enables three apps is three events, each
          // naming which one, rather than one event naming none.
          await this.invalidateTenant(clientId, row.application_id);
        }
      }

      await this.audit.recordMany(audited);

      return rows.map(toDto);
    });
  }

  /**
   * The client's enabled and disabled applications (Doc 09 §2.2).
   *
   * Beyond Doc 06 §5's table, which stops at the two writes — added for the
   * reason the registry's `DELETE /nav-permissions` was: the screen the spec
   * *does* describe cannot be drawn without it. Doc 09 §2.2's client detail is a
   * list of toggles, and a toggle needs to know which way it currently points.
   *
   * Disabled rows are included, obviously: they are the ones whose toggle is off.
   * Not paginated — the application catalog is a handful of rows, and the caller
   * is rendering all of them at once.
   */
  async list(clientId: string): Promise<ClientApplicationDTO[]> {
    await assertPlatformAdmin();

    const client = await this.clients.findRow(clientId);
    if (client === null) throw IamException.notFound('The client');

    const rows = (await entityManager().query(
      `select ${SELECT_COLUMNS}
         from ${S}."client_application" ca
         join ${S}."application" a on a.id = ca.application_id
        where ca.client_id = $1
        order by a.key asc`,
      [clientId],
    )) as ClientApplicationRow[];

    return rows.map(toDto);
  }

  /**
   * Toggles one application for one client, or replaces its config (Doc 06 §5).
   *
   * Idempotent in the same way `ServiceAccountsService.setStatus` is: setting the
   * state a row already has changes nothing and writes no audit record, and the
   * caller still gets a 200 with the current row. An audit trail that logs
   * "disabled" three times because a switch was double-clicked is one nobody can
   * read.
   *
   * Unlike `enable`, an explicit `config` here is taken literally — `{}` clears
   * it. This is the deliberate edit; that one is the restore.
   *
   * Returns `null` when the application is not enabled for this client at all,
   * which the controller turns into a 404. Enabling is `POST`'s job.
   */
  async update(
    clientId: string,
    applicationId: string,
    input: UpdateClientApplicationInput,
  ): Promise<ClientApplicationDTO | null> {
    await assertPlatformAdmin();

    const client = await this.clients.findRow(clientId);
    if (client === null) throw IamException.notFound('The client');

    const manager = entityManager();

    return withProvisioningTenant(manager, clientId, async () => {
      const [current] = (await manager.query(
        `select ${SELECT_COLUMNS}
           from ${S}."client_application" ca
           join ${S}."application" a on a.id = ca.application_id
          where ca.client_id = $1 and ca.application_id = $2`,
        [clientId, applicationId],
      )) as ClientApplicationRow[];

      if (current === undefined) return null;

      const assignments: string[] = [];
      const parameters: unknown[] = [clientId, applicationId];

      if (input.enabled !== undefined && input.enabled !== current.enabled) {
        parameters.push(input.enabled);
        assignments.push(`enabled = $${parameters.length}`);
      }
      if (
        input.config !== undefined &&
        JSON.stringify(input.config) !== JSON.stringify(current.config)
      ) {
        parameters.push(JSON.stringify(input.config));
        assignments.push(`config = $${parameters.length}::jsonb`);
      }

      if (assignments.length === 0) return toDto(current);

      // CTE-wrapped so the statement's command is SELECT — see
      // `ClientsService.update` for why a bare `update … returning` misreads.
      const [row] = (await manager.query(
        `with updated as (
           update ${S}."client_application"
              set ${assignments.join(', ')}
            where client_id = $1 and application_id = $2
           returning client_id, application_id, enabled, config, created_at, updated_at
         )
         select ${SELECT_COLUMNS}
           from updated ca
           join ${S}."application" a on a.id = ca.application_id`,
        parameters,
      )) as ClientApplicationRow[];

      if (input.enabled !== undefined && input.enabled !== current.enabled) {
        await this.audit.record(
          row.enabled
            ? AUDIT_ACTIONS.CLIENT_APPLICATION_ENABLED
            : AUDIT_ACTIONS.CLIENT_APPLICATION_DISABLED,
          { type: 'client_application', id: row.application_id },
          { client_id: clientId, application_key: row.application_key },
        );

        // The `enabled` flag moved, in either direction. A `config` edit does
        // not reach here and should not: `client_application.config` is the
        // tenant's per-app settings blob and nothing in `resolve()` reads it, so
        // flushing the tenant's grants over one would be work with no effect.
        await this.invalidateTenant(clientId, row.application_id);
      }

      return toDto(row);
    });
  }

  /**
   * Turns the request's `application_id` / `application_key` entries into rows.
   *
   * One query rather than one per entry, and the failures it can produce are all
   * 4xx with a name in them: an id or key that matches nothing is a 404 quoting
   * what was asked for (the catalog is globally readable, so there is nothing to
   * conceal), a globally deactivated application is a 409, and two entries that
   * resolve to the same application is a 409 — the case the DTO's uniqueness
   * check cannot see, because one entry named it by id and the other by key.
   */
  private async resolveApplications(
    inputs: readonly EnableApplicationInput[],
  ): Promise<{ id: string; key: string; config?: Record<string, unknown> }[]> {
    const ids = inputs
      .map((entry) => entry.application_id)
      .filter((id): id is string => id !== undefined);
    const keys = inputs
      .map((entry) => entry.application_key)
      .filter((key): key is string => key !== undefined);

    const rows = (await entityManager().query(
      `select id, key, is_active from ${S}."application"
        where id = any($1::uuid[]) or key = any($2::text[])`,
      [ids, keys],
    )) as { id: string; key: string; is_active: boolean }[];

    const byId = new Map(rows.map((row) => [row.id, row]));
    const byKey = new Map(rows.map((row) => [row.key, row]));

    const resolved: { id: string; key: string; config?: Record<string, unknown> }[] = [];
    const seen = new Set<string>();

    for (const entry of inputs) {
      const named = entry.application_id ?? entry.application_key ?? '';
      const row =
        entry.application_id === undefined
          ? byKey.get(entry.application_key ?? '')
          : byId.get(entry.application_id);

      if (row === undefined) {
        throw IamException.notFound(`The application "${named}"`);
      }
      if (!row.is_active) {
        throw IamException.conflict(
          `The application "${row.key}" is deactivated and cannot be enabled for a client`,
        );
      }
      if (seen.has(row.id)) {
        throw IamException.conflict(
          `The application "${row.key}" is named more than once in this request`,
        );
      }

      seen.add(row.id);
      resolved.push({ id: row.id, key: row.key, config: entry.config });
    }

    return resolved;
  }
}

function toDto(row: ClientApplicationRow): ClientApplicationDTO {
  return {
    client_id: row.client_id,
    application_id: row.application_id,
    application_key: row.application_key,
    application_name: row.application_name,
    enabled: row.enabled,
    config: row.config,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
