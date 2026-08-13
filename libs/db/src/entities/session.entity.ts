/**
 * `iam.session` — an issued, revocable token session (Doc 01 §4.7).
 *
 * {@link Session.id} **is** the `sid` claim in the access token (Doc 03 §2),
 * which is what makes force-logout possible: revocation sets
 * {@link Session.revokedAt} and the `sid` lands in the Redis revoked set, so
 * the guard rejects within seconds without a database round-trip (Doc 03 §6).
 * That matters most for shared gate terminals logged out at shift end.
 *
 * Service-account tokens normally have **no row here** — their `sid` is
 * ephemeral by design and their short TTL is the revocation window (Doc 03 §5).
 * The subject columns still allow one, for an integration that needs instant
 * mid-token kill.
 *
 * There is no `created_at`: `issued_at` is the creation stamp, and two names
 * for one instant is how they drift apart.
 */

import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { Client } from './client.entity.js';
import { ServiceAccount } from './service-account.entity.js';
import { User } from './user.entity.js';

@Entity({ schema: IAM_SCHEMA, name: 'session' })
export class Session {
  /** The `sid` claim (Doc 03 §2). */
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId!: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ name: 'service_account_id', type: 'uuid', nullable: true })
  serviceAccountId!: string | null;

  /**
   * Hash of the opaque refresh token, rotated on every use (Doc 03 §4). The
   * token itself is never stored. Uniquely indexed — the constraint that two
   * live sessions can never share a token — though from Session 9 the refresh
   * flow finds the session by id rather than by this column.
   */
  @Column({ name: 'refresh_token_hash', type: 'text', nullable: true })
  refreshTokenHash!: string | null;

  /**
   * The token one generation back, and when it stopped being current — together,
   * the reuse grace window Doc 03 §4 requires so that two clients refreshing at
   * once do not look like theft. Both are null until the first rotation, and
   * `session_rotation_state` (migration 0013) keeps them null or set together.
   */
  @Column({ name: 'previous_refresh_token_hash', type: 'text', nullable: true })
  previousRefreshTokenHash!: string | null;

  @Column({ name: 'rotated_at', type: 'timestamptz', nullable: true })
  rotatedAt!: Date | null;

  @Column({ name: 'issued_at', type: 'timestamptz', default: () => 'now()' })
  issuedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /** Set by force-logout. Never cleared — a revoked session stays revoked. */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  /** e.g. "Gate-3 Terminal" — what makes a session list actionable. */
  @Column({ name: 'device_label', type: 'text', nullable: true })
  deviceLabel!: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Client, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client!: Client;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @ManyToOne(() => ServiceAccount, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'service_account_id' })
  serviceAccount!: ServiceAccount | null;
}
