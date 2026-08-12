/**
 * `iam.user` — a human identity belonging to exactly one client (Doc 01 §3.6).
 *
 * There is no global user: `email` is unique **per client**, and the same
 * address may be a distinct person in two tenants. Login is by
 * `(client_slug, email)` (Doc 03 §3), which is what makes that safe.
 *
 * Credentials live on {@link UserIdentity}, never here — this row stays
 * readable in an admin list without carrying a password hash through it.
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';
import { Client } from './client.entity.js';
import type { UserIdentity } from './user-identity.entity.js';

/**
 * Account states (Doc 03 §8): `active` logs in, `locked` is refused with 423
 * — the "Account Locked Users" list — and `disabled` is offboarded, with every
 * session revoked.
 */
export const USER_STATUSES = ['active', 'locked', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Postgres enum type backing {@link User.status}, created in migration 0001. */
export const USER_STATUS_ENUM = IAM_ENUMS.USER_STATUS;

@Entity({ schema: IAM_SCHEMA, name: 'user' })
@Index('user_client_id_email_key', ['clientId', 'email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId!: string;

  /** Stored lowercased — migration 0003 rejects anything else. */
  @Column({ name: 'email', type: 'text' })
  email!: string;

  @Column({ name: 'full_name', type: 'text' })
  fullName!: string;

  /** Reserved for the WhatsApp OTP login Doc 03 §10 defers. */
  @Column({ name: 'phone', type: 'text', nullable: true })
  phone!: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: USER_STATUSES,
    enumName: USER_STATUS_ENUM,
    default: 'active',
  })
  status!: UserStatus;

  /**
   * A shortcut flag for listing and UI, *not* an authorization input: access
   * is decided by bindings and permissions, never by reading this (Doc 01 §3.6).
   */
  @Column({ name: 'is_client_admin', type: 'boolean', default: false })
  isClientAdmin!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Client, (client) => client.users, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client!: Client;

  @OneToMany('UserIdentity', (identity: UserIdentity) => identity.user)
  identities!: UserIdentity[];
}
