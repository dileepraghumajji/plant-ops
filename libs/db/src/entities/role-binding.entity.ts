/**
 * `iam.role_binding` — the heart of the system (Doc 01 §4.5).
 *
 * One row is WHO × (role → WHAT) × WHERE: a subject holds a role's permissions
 * across a scope node **and its entire subtree**. Everything the authorization
 * engine answers (Doc 04) is a union over these rows.
 *
 * Three invariants, all enforced by migration 0004 rather than trusted to the
 * service layer:
 *
 * - **Subject XOR** — exactly one of {@link RoleBinding.userId} /
 *   {@link RoleBinding.serviceAccountId} (Doc 01 §6.1).
 * - **No duplicates** — `unique(coalesce(user_id, service_account_id), role_id,
 *   scope_node_id)` (Doc 01 §6.7). Binding the same subject+role at an
 *   ancestor *and* a descendant stays legal; resolution dedupes the covering
 *   paths instead (Doc 04 §4.1).
 * - **One tenant** — composite foreign keys carry `client_id` into the role,
 *   node and user references, so a binding cannot reach across tenants
 *   (Doc 02 §6).
 */

import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { Client } from './client.entity.js';
import { Role } from './role.entity.js';
import { ScopeNode } from './scope-node.entity.js';
import { ServiceAccount } from './service-account.entity.js';
import { User } from './user.entity.js';

@Entity({ schema: IAM_SCHEMA, name: 'role_binding' })
export class RoleBinding {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  /** Denormalized for RLS, and the tenant half of every composite FK. */
  @Column({ name: 'client_id', type: 'uuid' })
  clientId!: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ name: 'service_account_id', type: 'uuid', nullable: true })
  serviceAccountId!: string | null;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  /** The WHERE. Grants cover this node and everything beneath it. */
  @Column({ name: 'scope_node_id', type: 'uuid' })
  scopeNodeId!: string;

  /**
   * Temporary access. Filtered at resolve time (Doc 04 §4.1) — expiry fires no
   * invalidation of its own, since time passing cannot trigger a hook, so a
   * binding that lapses while cached stays effective until the entry's TTL
   * does. A documented staleness bound, bounded by the sweep job (Doc 01 §4.5).
   */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  /**
   * When the expiry sweep noticed this binding had lapsed (migration 0016).
   *
   * Housekeeping, not access: {@link RoleBinding.expiresAt} is what resolution
   * filters on, and a lapsed binding is inert whether or not this is set. Its
   * only job is to make "newly expired" a fact about the row rather than about
   * the sweeper's memory, so the job is idempotent across restarts and replicas.
   */
  @Column({ name: 'expiry_swept_at', type: 'timestamptz', nullable: true })
  expirySweptAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Client, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client!: Client;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @ManyToOne(() => ServiceAccount, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'service_account_id' })
  serviceAccount!: ServiceAccount | null;

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role!: Role;

  /** Restrict, not cascade — deleting a node that still grants access is a 409. */
  @ManyToOne(() => ScopeNode, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'scope_node_id' })
  scopeNode!: ScopeNode;
}
