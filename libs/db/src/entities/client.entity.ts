/**
 * `iam.client` — a tenant, and the root isolation boundary (Doc 01 §3.4).
 *
 * Every tenant-owned row in the schema carries this row's `id` as `client_id`,
 * which is the column RLS keys off (Doc 07 §6). Clients are **suspended, never
 * deleted**: a suspended client's users cannot log in (Doc 06 §5), while every
 * scope node, role, binding and audit record stays exactly where it was.
 */

import { Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';
import type { Role } from './role.entity.js';
import type { ScopeNode } from './scope-node.entity.js';
import type { User } from './user.entity.js';

/**
 * Lifecycle states, in the order the Postgres enum declares its labels.
 *
 * Since Session 15 `@plantops/contracts` publishes the same two values as
 * `ClientStatus`, because `ClientDTO` now exposes them on the wire (Doc 06 §5).
 * They stay spelled twice — contracts depends on nothing, this file depends on
 * TypeORM — and `entities.spec.ts` pins both to migration 0001's enum, which is
 * what keeps the API from accepting a status the column would reject. Same
 * arrangement as {@link ServiceAccountStatus}.
 */
export const CLIENT_STATUSES = ['active', 'suspended'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Postgres enum type backing {@link Client.status}, created in migration 0001. */
export const CLIENT_STATUS_ENUM = IAM_ENUMS.CLIENT_STATUS;

@Entity({ schema: IAM_SCHEMA, name: 'client' })
export class Client {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  /** Half of the login credential — `POST /auth/login` resolves it (Doc 03 §3). */
  @Index('client_slug_key', { unique: true })
  @Column({ name: 'slug', type: 'text' })
  slug!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: CLIENT_STATUSES,
    enumName: CLIENT_STATUS_ENUM,
    default: 'active',
  })
  status!: ClientStatus;

  @Column({ name: 'config', type: 'jsonb', default: () => `'{}'::jsonb` })
  config!: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @OneToMany('ScopeNode', (scopeNode: ScopeNode) => scopeNode.client)
  scopeNodes!: ScopeNode[];

  @OneToMany('User', (user: User) => user.client)
  users!: User[];

  @OneToMany('Role', (role: Role) => role.client)
  roles!: Role[];
}
