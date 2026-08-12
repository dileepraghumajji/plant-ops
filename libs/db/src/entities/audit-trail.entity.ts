/**
 * `iam.audit_trail` — the append-only record (Doc 01 §4.8, Doc 10).
 *
 * Read through this entity; **never written through it.** Session 5 revokes
 * INSERT/UPDATE/DELETE/TRUNCATE on the table from the app role and leaves one
 * way in: the `iam.write_audit` SECURITY DEFINER function, which stamps actor
 * and tenant from the request context so neither can be spoofed (Doc 07 §6).
 * A `repository.save()` here fails at the database, by design.
 *
 * Two absences are deliberate and load-bearing:
 *
 * - **No `updatedAt`.** Every other entity has one. There is no update path to
 *   stamp (Doc 10 §1) and a column would imply there is.
 * - **No relations.** `clientId`, `actorId` and `targetId` are plain uuids with
 *   no foreign keys: audit has to outlive whatever it describes.
 *
 * Never let a secret, hash or token reach {@link AuditTrail.payload} — the
 * redaction boundary is `AuditService` (Doc 10 §8, Session 12).
 */

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';

export const AUDIT_ACTOR_TYPES = ['user', 'service_account', 'platform'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Postgres enum type backing {@link AuditTrail.actorType}, from migration 0001. */
export const AUDIT_ACTOR_TYPE_ENUM = IAM_ENUMS.AUDIT_ACTOR_TYPE;

@Entity({ schema: IAM_SCHEMA, name: 'audit_trail' })
export class AuditTrail {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  /** `null` = a platform-level action, outside any tenant (Doc 10 §2). */
  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId!: string | null;

  @Column({
    name: 'actor_type',
    type: 'enum',
    enum: AUDIT_ACTOR_TYPES,
    enumName: AUDIT_ACTOR_TYPE_ENUM,
  })
  actorType!: AuditActorType;

  /** `null` only where there is genuinely no subject yet — `platform.bootstrap`. */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId!: string | null;

  /** A dotted verb from the Doc 10 §4 catalog, e.g. `role_binding.created`. */
  @Column({ name: 'action', type: 'text' })
  action!: string;

  @Column({ name: 'target_type', type: 'text', nullable: true })
  targetType!: string | null;

  @Column({ name: 'target_id', type: 'uuid', nullable: true })
  targetId!: string | null;

  /** Compact before/after or the salient fields — never secrets (Doc 10 §2, §8). */
  @Column({ name: 'payload', type: 'jsonb', default: () => `'{}'::jsonb` })
  payload!: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
