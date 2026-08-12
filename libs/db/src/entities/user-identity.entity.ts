/**
 * `iam.user_identity` — a user's login methods (Doc 01 §4.6).
 *
 * Split from `user` so credentials never ride along with an admin list query,
 * and so the SSO and MFA factors Doc 03 §10 defers are additional rows rather
 * than a schema change: `provider` + `provider_subject` are already here.
 *
 * v1 issues exactly one row per user, `provider = 'password'`, with an
 * **argon2id** hash in {@link UserIdentity.secretHash} (Doc 03 §7).
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';
import { User } from './user.entity.js';

export const IDENTITY_PROVIDERS = ['password', 'oidc'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

/** Postgres enum type backing {@link UserIdentity.provider}, from migration 0001. */
export const IDENTITY_PROVIDER_ENUM = IAM_ENUMS.IDENTITY_PROVIDER;

@Entity({ schema: IAM_SCHEMA, name: 'user_identity' })
@Index('user_identity_user_id_provider_key', ['userId', 'provider'], { unique: true })
export class UserIdentity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  /**
   * Denormalized tenant. Doc 07 §6 lists `user_identity` among the tables with
   * a direct-`client_id` RLS policy, and the composite FK to
   * `user (id, client_id)` keeps it in step with the user's.
   */
  @Column({ name: 'client_id', type: 'uuid' })
  clientId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    name: 'provider',
    type: 'enum',
    enum: IDENTITY_PROVIDERS,
    enumName: IDENTITY_PROVIDER_ENUM,
    default: 'password',
  })
  provider!: IdentityProvider;

  /** argon2id hash for `password`; null for external providers. */
  @Column({ name: 'secret_hash', type: 'text', nullable: true })
  secretHash!: string | null;

  /** The external provider's subject id — reserved for OIDC (Doc 03 §10). */
  @Column({ name: 'provider_subject', type: 'text', nullable: true })
  providerSubject!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => User, (user) => user.identities, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
