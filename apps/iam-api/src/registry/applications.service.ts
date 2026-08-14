/**
 * Application CRUD — the root of the platform catalog (Doc 06 §4, Doc 02 §2).
 *
 * ## The catalog is data, and this is the endpoint that says so
 *
 * Doc 02 §8 sets the constraint the whole registry exists to satisfy: adding an
 * application, a permission, a menu or a client is "always an API call, never a
 * migration". This service is step 1 of that — `POST /iam/applications` creates
 * the row every permission and nav node hangs off, at runtime, with no deploy.
 *
 * ## There is no delete, and that is the specification
 *
 * Doc 02 §7 lists exactly one way to retire an application: `is_active = false`,
 * "hidden everywhere, existing data preserved". The route is a PATCH, and
 * `DELETE` is absent from Doc 06 §4 for a reason the schema makes concrete —
 * `permission.application_id` and `nav_node.application_id` both cascade
 * (migration 0002), so deleting an application would take with it every
 * permission that existing `role_permission` rows still grant and every key an
 * `audit_trail` payload still names. Deactivation keeps all of it and costs
 * nothing: resolution and nav pruning filter on `is_active`.
 *
 * ## Everything here runs on the request transaction, under catalog RLS
 *
 * Reads are unconditional for any authenticated subject and writes require
 * `app.is_platform_admin` — the policies of migration 0008. The service-level
 * `assertPlatformAdmin()` in front of each method is the interim gate that turns
 * a would-be policy violation into the 403 Doc 06 §2 asks for; see
 * `platform-admin.ts` for what replaces it in Session 23 and why it is not a
 * guard.
 *
 * Audit goes through `AuditService`, so every record is written in the same
 * transaction as the change it describes (Doc 10 §3).
 */

import { Injectable } from '@nestjs/common';
import {
  normalizePagination,
  paginated,
  type ApplicationDTO,
  type Paginated,
} from '@plantops/contracts';
import { IAM_SCHEMA } from '@plantops/db';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { entityManager } from '../common/transaction-context';
import { rethrowAsConflict } from './conflict';
import { assertPlatformAdmin } from './platform-admin';

const S = `"${IAM_SCHEMA}"`;

const COLUMNS = `id, key, name, description, is_active, config, created_at, updated_at`;

export interface ApplicationRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_active: boolean;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateApplicationInput {
  key: string;
  name: string;
  description?: string;
  config?: Record<string, unknown>;
}

export interface UpdateApplicationInput {
  name?: string;
  description?: string | null;
  is_active?: boolean;
  config?: Record<string, unknown>;
}

@Injectable()
export class ApplicationsService {
  constructor(private readonly audit: AuditService) {}

  /** Registers an application (Doc 02 §2 step 1). */
  async create(input: CreateApplicationInput): Promise<ApplicationDTO> {
    await assertPlatformAdmin();

    let rows: ApplicationRow[];
    try {
      rows = (await entityManager().query(
        `insert into ${S}."application" (key, name, description, config)
         values ($1, $2, $3, coalesce($4::jsonb, '{}'::jsonb))
         returning ${COLUMNS}`,
        [
          input.key,
          input.name,
          input.description ?? null,
          input.config === undefined ? null : JSON.stringify(input.config),
        ],
      )) as ApplicationRow[];
    } catch (error) {
      rethrowAsConflict(error, `An application with the key "${input.key}" already exists`);
    }

    const row = rows[0];
    await this.audit.record(
      AUDIT_ACTIONS.APPLICATION_CREATED,
      { type: 'application', id: row.id },
      { key: row.key, name: row.name },
    );

    return toDto(row);
  }

  /**
   * The catalog, alphabetically by key (Doc 06 §4).
   *
   * Ordered by key rather than by `created_at desc` — the ordering
   * `ServiceAccountsService.list` uses — because these two lists answer
   * different questions. A tenant's service accounts are a log of things that
   * were minted, so the newest matters most; the application catalog is a
   * reference an operator scans for a name they already know.
   *
   * Inactive applications are included. This is the platform admin's own view of
   * what exists, and hiding a deactivated row here would leave no way to
   * reactivate it through the API.
   */
  async list(query: { page?: number; limit?: number } = {}): Promise<Paginated<ApplicationDTO>> {
    await assertPlatformAdmin();

    const { page, limit } = normalizePagination(query);

    const rows = (await entityManager().query(
      `select ${COLUMNS} from ${S}."application"
        order by key asc
        limit $1 offset $2`,
      [limit, (page - 1) * limit],
    )) as ApplicationRow[];

    const [count] = (await entityManager().query(
      `select count(*)::int as total from ${S}."application"`,
    )) as { total: number }[];

    return paginated(rows.map(toDto), count?.total ?? rows.length, query);
  }

  /**
   * Updates an application, or flips its global switch (Doc 06 §4, Doc 02 §7).
   *
   * Only genuinely changed fields reach the `update`, and an entirely no-op
   * PATCH writes no audit record — the same rule
   * `ServiceAccountsService.setStatus` follows, for the same reason: a trail
   * that logs "updated" every time a form is re-submitted unchanged is one
   * nobody can read. The caller still gets a 200 and the current row.
   *
   * Deactivation is recorded as `application.deactivated` rather than as another
   * `application.updated`, because Doc 10 §4 gives it its own action and it is
   * the one edit here with system-wide consequences. Reactivation has no
   * dedicated action in the catalog, so it rides in `application.updated` with
   * `is_active` among the changed fields.
   *
   * Returns `null` when no such application exists.
   */
  async update(
    id: string,
    input: UpdateApplicationInput,
  ): Promise<ApplicationDTO | null> {
    await assertPlatformAdmin();

    const [current] = (await entityManager().query(
      `select ${COLUMNS} from ${S}."application" where id = $1`,
      [id],
    )) as ApplicationRow[];

    if (current === undefined) return null;

    const assignments: string[] = [];
    const parameters: unknown[] = [id];
    const changed: string[] = [];

    const assign = (column: string, value: unknown, cast = ''): void => {
      parameters.push(value);
      assignments.push(`${column} = $${parameters.length}${cast}`);
      changed.push(column);
    };

    if (input.name !== undefined && input.name !== current.name) {
      assign('name', input.name);
    }
    if (input.description !== undefined && input.description !== current.description) {
      assign('description', input.description);
    }
    if (input.is_active !== undefined && input.is_active !== current.is_active) {
      assign('is_active', input.is_active);
    }
    if (
      input.config !== undefined &&
      JSON.stringify(input.config) !== JSON.stringify(current.config)
    ) {
      assign('config', JSON.stringify(input.config), '::jsonb');
    }

    if (assignments.length === 0) return toDto(current);

    // Wrapped in a CTE so the statement's command is SELECT: TypeORM's Postgres
    // driver returns `[rows, rowCount]` for a bare `update … returning`, and the
    // row destructuring below would silently read the count as a row. Same
    // reason `ServiceAccountsService.rotate` does it.
    const [row] = (await entityManager().query(
      `with updated as (
         update ${S}."application"
            set ${assignments.join(', ')}
          where id = $1
         returning ${COLUMNS}
       )
       select ${COLUMNS} from updated`,
      parameters,
    )) as ApplicationRow[];

    const deactivated = current.is_active && input.is_active === false;
    const otherChanges = changed.filter((column) => column !== 'is_active');

    if (otherChanges.length > 0 || !deactivated) {
      await this.audit.record(
        AUDIT_ACTIONS.APPLICATION_UPDATED,
        { type: 'application', id: row.id },
        {
          key: row.key,
          changed,
          // A compact before/after (Doc 10 §2) of the fields that moved. `config`
          // is named but not quoted: it is an opaque per-application blob whose
          // size this API does not bound, and a trail that pastes one in on every
          // edit stops being scannable.
          before: summarize(current, otherChanges),
          after: summarize(row, otherChanges),
        },
      );
    }

    if (deactivated) {
      await this.audit.record(
        AUDIT_ACTIONS.APPLICATION_DEACTIVATED,
        { type: 'application', id: row.id },
        { key: row.key, name: row.name },
      );
    }

    return toDto(row);
  }

  /**
   * The application, or `null`.
   *
   * Not a route of its own — Doc 06 §4 has no `GET /iam/applications/:id` — but
   * every sub-resource needs it, because a permission or nav node added under an
   * id that does not exist must be a 404 naming the application rather than a
   * foreign-key violation reported as a 500.
   *
   * Deliberately **not** gated: the callers are already past
   * `assertPlatformAdmin()`, and a second check here would be one more place for
   * the two to disagree once Session 23 replaces the first.
   */
  async findRow(id: string): Promise<ApplicationRow | null> {
    const [row] = (await entityManager().query(
      `select ${COLUMNS} from ${S}."application" where id = $1`,
      [id],
    )) as ApplicationRow[];

    return row ?? null;
  }
}

/** The changed fields, by name, for a `before`/`after` payload. */
function summarize(
  row: ApplicationRow,
  columns: readonly string[],
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const column of columns) {
    if (column === 'name') summary['name'] = row.name;
    if (column === 'description') summary['description'] = row.description;
  }
  return summary;
}

export function toDto(row: ApplicationRow): ApplicationDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    is_active: row.is_active,
    config: row.config,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
