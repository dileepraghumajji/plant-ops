/**
 * `iam.permission` — an atomic action owned by an application (Doc 01 §3.2).
 *
 * Permissions are **data, never code** (Doc 02 §8): the IAM must not enumerate
 * keys in a switch or enum. Addressed globally as `application.key` +
 * `permission.key`, which is what `unique(application_id, key)` guarantees.
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { Application } from './application.entity.js';

@Entity({ schema: IAM_SCHEMA, name: 'permission' })
@Index('permission_application_id_key_key', ['applicationId', 'key'], { unique: true })
export class Permission {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'application_id', type: 'uuid' })
  applicationId!: string;

  /** Namespaced `app.resource.action`, e.g. `gatepass.dc.approve`. */
  @Column({ name: 'key', type: 'text' })
  key!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  /**
   * Soft-deactivation target for manifest shrink (Doc 02 §7): a key absent
   * from a re-uploaded manifest is deactivated, never deleted, so existing
   * `role_permission` rows and audit history stay intact.
   */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Application, (application) => application.permissions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'application_id' })
  application!: Application;
}
