/**
 * Permission catalog CRUD — step 2 of registering an application (Doc 02 §2,
 * Doc 06 §4).
 *
 * ## Permissions are rows, never code
 *
 * Doc 02 §8 is explicit: no permission key may be hardcoded in a `switch` or an
 * `enum` as the source of truth, because the promise the registry makes is that
 * an application can add a capability without a deploy. So this service inserts
 * whatever keys it is handed, validates only their *shape*
 * (`dto/permissions.dto.ts`), and enumerates nothing.
 *
 * ## Bulk, one row at a time
 *
 * The body is an array — Doc 02 §2 calls it a bulk seed — and the loop below
 * inserts its entries individually rather than as one multi-row `values` list.
 * A single statement would be marginally faster and materially worse to be on
 * the receiving end of: the unique index fires on the *statement*, so a
 * duplicate anywhere in a two-hundred-key body would produce one 409 naming
 * nothing. Inserting in order means the conflict is attributed to the key that
 * caused it.
 *
 * Nothing is lost by failing partway through, because the request transaction
 * rolls the whole array back (Doc 07 §5) — the manifest upsert of Session 14
 * makes the same all-or-nothing guarantee for the same reason.
 *
 * ## There is no delete, and no update
 *
 * Doc 06 §4 offers add and list, and that is the whole surface. A permission
 * that no longer applies is deactivated by the manifest upsert (Doc 02 §7,
 * Session 14) rather than deleted, because `role_permission` rows and audit
 * payloads refer to it; hard-deleting one would silently revoke grants with no
 * record of what was revoked.
 */

import { Injectable } from '@nestjs/common';
import {
  normalizePagination,
  paginated,
  type Paginated,
  type PermissionDTO,
} from '@plantops/contracts';
import { IAM_SCHEMA } from '@plantops/db';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { IamException } from '../common/iam.exception';
import { entityManager } from '../common/transaction-context';
import { ApplicationsService } from './applications.service';
import { rethrowAsConflict } from './conflict';
import { assertPlatformAdmin } from '../common/platform-admin';

const S = `"${IAM_SCHEMA}"`;

const COLUMNS = `id, application_id, key, name, description, is_active, created_at, updated_at`;

interface PermissionRow {
  id: string;
  application_id: string;
  key: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreatePermissionInput {
  key: string;
  name: string;
  description?: string;
}

@Injectable()
export class PermissionsService {
  constructor(
    private readonly audit: AuditService,
    private readonly applications: ApplicationsService,
  ) {}

  /**
   * Adds permissions to an application (Doc 06 §4).
   *
   * A duplicate `(application_id, key)` is a 409 naming the key — the acceptance
   * criterion of this session, and the reason the insert is not `on conflict do
   * nothing`. Silently skipping a duplicate would make this endpoint an upsert,
   * which is Session 14's job and has different semantics (it also *updates* the
   * label and soft-deactivates what is missing). An add that quietly did nothing
   * would leave a caller believing a rename had taken.
   */
  async add(
    applicationId: string,
    inputs: readonly CreatePermissionInput[],
  ): Promise<PermissionDTO[]> {
    await assertPlatformAdmin();
    await this.requireApplication(applicationId);

    const created: PermissionRow[] = [];

    for (const input of inputs) {
      let rows: PermissionRow[];
      try {
        rows = (await entityManager().query(
          `insert into ${S}."permission" (application_id, key, name, description)
           values ($1, $2, $3, $4)
           returning ${COLUMNS}`,
          [applicationId, input.key, input.name, input.description ?? null],
        )) as PermissionRow[];
      } catch (error) {
        rethrowAsConflict(
          error,
          `The permission key "${input.key}" already exists in this application`,
        );
      }

      created.push(rows[0]);
    }

    // Audited after the whole array is in, one record per permission and one
    // statement for the batch. Auditing inside the loop would be equivalent —
    // same transaction, same rollback — but this keeps the insert loop's failure
    // path to the one thing it is about, and a manifest declaring a hundred keys
    // pays for one round-trip here rather than a hundred.
    await this.audit.recordMany(
      created.map((row) => ({
        action: AUDIT_ACTIONS.PERMISSION_CREATED,
        target: { type: 'permission' as const, id: row.id },
        payload: {
          application_id: row.application_id,
          key: row.key,
          name: row.name,
        },
      })),
    );

    return created.map(toDto);
  }

  /**
   * An application's permissions, alphabetically by key (Doc 06 §4).
   *
   * Alphabetical because a dotted key sorts into its own namespace —
   * `gatepass.dc.*` lands together — which is how a role editor wants to render
   * them (Doc 09) and how an operator reads a catalog.
   */
  async list(
    applicationId: string,
    query: { page?: number; limit?: number } = {},
  ): Promise<Paginated<PermissionDTO>> {
    await assertPlatformAdmin();
    await this.requireApplication(applicationId);

    const { page, limit } = normalizePagination(query);

    const rows = (await entityManager().query(
      `select ${COLUMNS} from ${S}."permission"
        where application_id = $1
        order by key asc
        limit $2 offset $3`,
      [applicationId, limit, (page - 1) * limit],
    )) as PermissionRow[];

    const [count] = (await entityManager().query(
      `select count(*)::int as total from ${S}."permission" where application_id = $1`,
      [applicationId],
    )) as { total: number }[];

    return paginated(rows.map(toDto), count?.total ?? rows.length, query);
  }

  /**
   * Resolves permission keys to ids within one application.
   *
   * Used by `NavService` to turn a mapping body's keys into `menu_permission`
   * rows. Returns only what it found; naming what is missing is the caller's
   * job, because only the caller knows whether an absent key is a 404 or an
   * empty result.
   */
  async idsByKey(
    applicationId: string,
    keys: readonly string[],
  ): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();

    const rows = (await entityManager().query(
      `select id, key from ${S}."permission"
        where application_id = $1 and key = any($2::text[])`,
      [applicationId, [...new Set(keys)]],
    )) as { id: string; key: string }[];

    return new Map(rows.map((row) => [row.key, row.id]));
  }

  /**
   * 404s when the application does not exist.
   *
   * Checked before the insert rather than left to the foreign key, because
   * `permission_application_id_fkey` firing produces SQLSTATE 23503, which the
   * filter does not recognise and would report as a 500 — an unknown id in a
   * path segment is a caller error and Doc 06 §2 gives it a 404.
   */
  private async requireApplication(applicationId: string): Promise<void> {
    if ((await this.applications.findRow(applicationId)) === null) {
      throw IamException.notFound('The application');
    }
  }
}

function toDto(row: PermissionRow): PermissionDTO {
  return {
    id: row.id,
    application_id: row.application_id,
    key: row.key,
    name: row.name,
    description: row.description,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
