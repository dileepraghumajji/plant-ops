/**
 * `iam.application` — a registrable service (Doc 01 §3.1).
 *
 * Registry, not tenant data: rows are globally readable and platform-writable
 * (Doc 07 §6). Applications are never hard-deleted — `is_active = false` hides
 * one everywhere while preserving every permission, nav node, and mapping that
 * references it (Doc 02 §7).
 */

import { Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import type { NavNode } from './nav-node.entity.js';
import type { Permission } from './permission.entity.js';

@Entity({ schema: IAM_SCHEMA, name: 'application' })
export class Application {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  /** Machine key, e.g. `gatepass`. Globally unique — the manifest's natural key. */
  @Index('application_key_key', { unique: true })
  @Column({ name: 'key', type: 'text' })
  key!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  /** Global soft on/off. Deactivating preserves all data (Doc 02 §7). */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  /** App-level defaults; per-client overrides live on `client_application`. */
  @Column({ name: 'config', type: 'jsonb', default: () => `'{}'::jsonb` })
  config!: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @OneToMany('Permission', (permission: Permission) => permission.application)
  permissions!: Permission[];

  @OneToMany('NavNode', (navNode: NavNode) => navNode.application)
  navNodes!: NavNode[]; 

}
  