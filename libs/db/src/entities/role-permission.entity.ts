/**
 * `iam.role_permission` — role ↔ permission (Doc 01 §4.3).
 *
 * Tenant-sensitive despite having no `client_id` of its own: role composition
 * leaks what a tenant can do, so Session 5's RLS policy reaches through
 * `role_id` to the parent role's `client_id` rather than applying the plain
 * tenant shape (Doc 07 §6). `menu_permission` deliberately goes the other way.
 *
 * No `updated_at`: the row *is* its key. It is inserted and deleted.
 */

import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { Permission } from './permission.entity.js';
import { Role } from './role.entity.js';

@Entity({ schema: IAM_SCHEMA, name: 'role_permission' })
export class RolePermission {
  @PrimaryColumn({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @PrimaryColumn({ name: 'permission_id', type: 'uuid' })
  permissionId!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role!: Role;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_id' })
  permission!: Permission;
}
