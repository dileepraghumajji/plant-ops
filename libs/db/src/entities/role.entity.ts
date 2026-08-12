/**
 * `iam.role` — a client-specific named bundle of permissions (Doc 01 §4.2).
 *
 * Roles are tenant data, not catalog: two clients may both have a "Gate
 * Supervisor" and they share nothing. A role may only map permissions of
 * applications **enabled for its client** — a rule the service layer enforces
 * (Doc 01 §4.3, Doc 02 §6), since it depends on `client_application` state
 * that a foreign key cannot see.
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { Client } from './client.entity.js';

@Entity({ schema: IAM_SCHEMA, name: 'role' })
@Index('role_client_id_name_key', ['clientId', 'name'], { unique: true })
export class Role {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId!: string;

  /** Unique within the client (Doc 07 §9). */
  @Column({ name: 'name', type: 'text' })
  name!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  /**
   * Seeded default (e.g. the client-admin role created with the tenant,
   * Doc 06 §5) as opposed to one an admin defined.
   */
  @Column({ name: 'is_system', type: 'boolean', default: false })
  isSystem!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Client, (client) => client.roles, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client!: Client;
}
