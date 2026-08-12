/**
 * `iam.menu_permission` — which permission reveals which nav node
 * (Doc 01 §4.4). This is what makes navigation a pure function of grants
 * (Doc 05).
 *
 * Several rows for one node are **OR** semantics: holding any one of the mapped
 * permissions reveals it. A leaf with no rows at all is hidden unless
 * `nav_node.is_public` is set (Doc 05 §3).
 *
 * Catalog, not tenant data: it maps applications' nav to applications'
 * permissions, neither of which belongs to a client — so Session 5 gives it the
 * catalog RLS policy (globally readable, platform-writable), not the join-table
 * tenant policy `role_permission` gets (Doc 07 §6).
 */

import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { NavNode } from './nav-node.entity.js';
import { Permission } from './permission.entity.js';

@Entity({ schema: IAM_SCHEMA, name: 'menu_permission' })
export class MenuPermission {
  @PrimaryColumn({ name: 'nav_node_id', type: 'uuid' })
  navNodeId!: string;

  @PrimaryColumn({ name: 'permission_id', type: 'uuid' })
  permissionId!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @ManyToOne(() => NavNode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'nav_node_id' })
  navNode!: NavNode;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_id' })
  permission!: Permission;
}
