/**
 * `iam.nav_node` — the navigable tree inside an application (Doc 01 §3.3).
 *
 * Module → menu → sub_menu is one self-referencing table with a `kind`
 * discriminator, so depth stays flexible. Navigation is *always* resolved from
 * these rows plus `menu_permission`; it is never a static file (Doc 02 §8).
 *
 * Visibility (Doc 05 §3, enforced by the pruning algorithm, not the schema):
 * a leaf is shown when the subject holds a mapped permission **or**
 * `is_public = true`; a container is shown when a descendant leaf is.
 */

import type { NavNodeKind } from '@plantops/contracts';
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';
import { Application } from './application.entity.js';

/**
 * Depth discriminator, in the order the Postgres enum declares its labels.
 *
 * Spelled out rather than derived from `@plantops/contracts` so the column's
 * shape is readable here; `nav-node.entity.spec.ts` pins it to both the
 * contract and migration 0001, which is where a drift would actually bite.
 */
export const NAV_NODE_KINDS = ['module', 'menu', 'sub_menu'] as const satisfies readonly NavNodeKind[];

/** Postgres enum type backing {@link NavNode.kind}, created in migration 0001. */
export const NAV_NODE_KIND_ENUM = IAM_ENUMS.NAV_NODE_KIND;

@Entity({ schema: IAM_SCHEMA, name: 'nav_node' })
@Index('nav_node_application_id_key_key', ['applicationId', 'key'], { unique: true })
@Index('nav_node_application_id_parent_id_sort_order_idx', [
  'applicationId',
  'parentId',
  'sortOrder',
])
@Index('nav_node_parent_id_idx', ['parentId'])
export class NavNode {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'application_id', type: 'uuid' })
  applicationId!: string;

  /** `null` = top-level module. Enforced to share `application_id` (0002). */
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({
    name: 'kind',
    type: 'enum',
    enum: NAV_NODE_KINDS,
    enumName: NAV_NODE_KIND_ENUM,
  })
  kind!: NavNodeKind;

  /** Unique within the application; the manifest upsert's natural key. */
  @Column({ name: 'key', type: 'text' })
  key!: string;

  @Column({ name: 'label', type: 'text' })
  label!: string;

  /** Frontend path. `null` for pure containers. */
  @Column({ name: 'route', type: 'text', nullable: true })
  route!: string | null;

  /** Icon *key*; the frontend maps it to its own icon set (Doc 05 §7). */
  @Column({ name: 'icon', type: 'text', nullable: true })
  icon!: string | null;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  /**
   * Leaf-only opt-in: an *unmapped* leaf is visible to anyone who can see the
   * app only when this is true. Defaults to `false` — deny-by-default is the
   * whole point (Doc 01 §3.3).
   */
  @Column({ name: 'is_public', type: 'boolean', default: false })
  isPublic!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Application, (application) => application.navNodes, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'application_id' })
  application!: Application;

  @ManyToOne(() => NavNode, (navNode) => navNode.children, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'parent_id' })
  parent!: NavNode | null;

  @OneToMany(() => NavNode, (navNode) => navNode.parent)
  children!: NavNode[];
}
