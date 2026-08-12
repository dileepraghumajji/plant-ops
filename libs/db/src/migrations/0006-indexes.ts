/**
 * 0006 — the performance indexes (Doc 07 §10, Doc 06 §8/§12).
 *
 * Split out from the table migrations on purpose. The indexes that live
 * alongside their tables in 0002–0004 carry *invariants* — uniqueness the
 * system's correctness depends on. Everything here is about access paths, so
 * it can be reviewed, added to, or re-tuned without reopening a migration that
 * defines what is legal.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';

const S = `"${IAM_SCHEMA}"`;

/**
 * `name → create statement body`, in creation order.
 *
 * Named so `down()` can drop exactly what `up()` created without repeating the
 * list, and so the integration test can assert the set exists.
 */
const INDEXES: readonly (readonly [name: string, ddl: string])[] = [
  // ── the hot path: resolve() (Doc 04 §4, Doc 07 §10) ────────────────────
  //
  // Subtree coverage is `path <@ ancestor_path`, which btree cannot answer.
  // GiST is what makes "does this binding cover node X?" a prefix test instead
  // of a recursive walk (Doc 01 §3.5) — the single most load-bearing index
  // in the schema.
  ['scope_node_path_gist', `on ${S}."scope_node" using gist (path)`],
  // Ordered sibling fetch for the tree editor, and the index the self-FK's
  // restrict check uses when a delete asks "does this node have children?".
  ['scope_node_client_id_parent_id_idx', `on ${S}."scope_node" (client_id, parent_id)`],

  // Doc 07 §10 names both of these explicitly: bindings are read by subject
  // (resolve) and by role (role edits, "Users by Role" — Doc 06 §8).
  ['role_binding_client_id_user_id_idx', `on ${S}."role_binding" (client_id, user_id)`],
  ['role_binding_role_id_idx', `on ${S}."role_binding" (role_id)`],
  // The service-account arm of the same resolve query (Doc 03 §5).
  [
    'role_binding_client_id_service_account_id_idx',
    `on ${S}."role_binding" (client_id, service_account_id)`,
  ],
  // Backs the `on delete restrict` towards scope_node — without it, every
  // node delete degrades to a sequential scan of all bindings.
  ['role_binding_scope_node_id_idx', `on ${S}."role_binding" (scope_node_id)`],
  // The expiry sweep (Doc 10 §9, Session 22) reads only dated bindings, which
  // are the rare case — hence partial.
  [
    'role_binding_expires_at_idx',
    `on ${S}."role_binding" (expires_at) where expires_at is not null`,
  ],

  // Postgres indexes the referencing side of a FK only if asked. These are the
  // reverse lookups the join tables are actually read by: "which roles grant
  // this permission?" and, for nav pruning, "which nodes does it reveal?".
  ['role_permission_permission_id_idx', `on ${S}."role_permission" (permission_id)`],
  ['menu_permission_permission_id_idx', `on ${S}."menu_permission" (permission_id)`],
  ['client_application_application_id_idx', `on ${S}."client_application" (application_id)`],

  // ── admin surfaces ────────────────────────────────────────────────────
  // `GET /iam/users?status=locked` — the "Account Locked Users" screen
  // (Doc 06 §8, Doc 09 §3.3).
  ['user_client_id_status_idx', `on ${S}."user" (client_id, status)`],
  // Session list, and the force-logout-everywhere sweep that lock/disable
  // triggers (Doc 03 §6, §8). Both read by subject; the `revoked_at is null`
  // narrowing rides along on the same index rather than earning its own.
  ['session_client_id_user_id_idx', `on ${S}."session" (client_id, user_id)`],

  // ── audit reads (Doc 06 §12, Doc 10 §7) ───────────────────────────────
  // Every filter is combined with a time ordering, so each index leads with
  // the filter column and carries `created_at desc` to serve the sort too.
  ['audit_trail_client_id_created_at_idx', `on ${S}."audit_trail" (client_id, created_at desc)`],
  ['audit_trail_action_created_at_idx', `on ${S}."audit_trail" (action, created_at desc)`],
  ['audit_trail_actor_id_created_at_idx', `on ${S}."audit_trail" (actor_id, created_at desc)`],
  [
    'audit_trail_target_type_target_id_created_at_idx',
    `on ${S}."audit_trail" (target_type, target_id, created_at desc)`,
  ],
];

/** The index names 0006 owns — asserted by the integration suite. */
export const PERFORMANCE_INDEX_NAMES: readonly string[] = INDEXES.map(([name]) => name);

export class Indexes1786406400006 implements MigrationInterface {
  name = 'Indexes1786406400006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, ddl] of INDEXES) {
      // Plain `create index`, not `concurrently`: this migration runs inside a
      // transaction (`migrationsTransactionMode: 'each'`) and CONCURRENTLY
      // cannot. On an empty schema at release time the lock is momentary.
      await queryRunner.query(`create index ${name} ${ddl};`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of [...INDEXES].reverse()) {
      await queryRunner.query(`drop index if exists ${S}."${name}";`);
    }
  }
}
