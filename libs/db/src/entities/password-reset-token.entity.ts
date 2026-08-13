/**
 * `iam.password_reset_token` — one issued, time-boxed reset credential
 * (Doc 03 §7).
 *
 * Not in Doc 01's table list, because Doc 01 describes the identity model and
 * this is a mechanism rather than a thing the model has an opinion about. It
 * arrives with migration 0014, which explains at length why reset needs a table
 * of its own rather than three columns on `user`.
 *
 * {@link PasswordResetToken.tokenHash} is a SHA-256 digest, not argon2id — the
 * token is 256 bits from a CSPRNG, so there is nothing for a work factor to
 * slow down and a salt would break the equality lookup. `refresh-token.util.ts`
 * sets out the full reasoning; it is the same secret shape.
 *
 * The application role holds `select` on this table and nothing more: every
 * write goes through the migration-0014 definer functions, which are what pin
 * the audit record to the issue and the spend.
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { User } from './user.entity.js';

@Entity({ schema: IAM_SCHEMA, name: 'password_reset_token' })
@Index('password_reset_token_token_hash_key', ['tokenHash'], { unique: true })
export class PasswordResetToken {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  /** Denormalized tenant, carrying the RLS policy as everywhere else. */
  @Column({ name: 'client_id', type: 'uuid' })
  clientId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** SHA-256 of the token. The token itself is never stored, anywhere. */
  @Column({ name: 'token_hash', type: 'text' })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /**
   * Set when the token is spent — and also when a newer request supersedes it,
   * which is what keeps at most one live token per account.
   */
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
