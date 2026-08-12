/**
 * `iam.service_account` — a machine identity for module-to-module calls
 * (Doc 01 §3.7).
 *
 * Bound to roles exactly like a user (Doc 01 §4.5) and subject to the same
 * WHO × WHAT × WHERE resolution. A null {@link ServiceAccount.clientId} means
 * platform-level.
 *
 * The secret is shown once at creation and stored only as
 * {@link ServiceAccount.keyHash} (Doc 03 §7). Revocation is
 * `status = 'revoked'`, which fails the *next* `/auth/token` exchange — service
 * tokens carry an ephemeral `sid` and cannot be killed mid-token, so the ≤5 min
 * TTL is the exposure bound (Doc 03 §5).
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';
import { Client } from './client.entity.js';

export const SERVICE_ACCOUNT_STATUSES = ['active', 'revoked'] as const;
export type ServiceAccountStatus = (typeof SERVICE_ACCOUNT_STATUSES)[number];

/** Postgres enum type backing {@link ServiceAccount.status}, from migration 0001. */
export const SERVICE_ACCOUNT_STATUS_ENUM = IAM_ENUMS.SERVICE_ACCOUNT_STATUS;

@Entity({ schema: IAM_SCHEMA, name: 'service_account' })
export class ServiceAccount {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  /** `null` = platform-level, outside any tenant (Doc 01 §3.7). */
  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId!: string | null;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  /**
   * The public lookup handle — `account_key` in the client-credentials
   * exchange (Doc 03 §5). Globally unique because that request carries no
   * tenant, so the key has to resolve an account on its own.
   */
  @Index('service_account_key_key', { unique: true })
  @Column({ name: 'key', type: 'text' })
  key!: string;

  /** Hash of the secret. The secret itself is never stored or logged. */
  @Column({ name: 'key_hash', type: 'text' })
  keyHash!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: SERVICE_ACCOUNT_STATUSES,
    enumName: SERVICE_ACCOUNT_STATUS_ENUM,
    default: 'active',
  })
  status!: ServiceAccountStatus;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Client, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'client_id' })
  client!: Client | null;
}
