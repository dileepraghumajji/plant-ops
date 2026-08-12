/**
 * `iam.scope_node` — the org tree, and the WHERE of the access equation
 * (Doc 01 §3.5). Group → Plant → Department → Gate, one self-referencing tree
 * per client.
 *
 * `path` is a real Postgres `ltree`, not a text path: coverage is the `<@`
 * operator over a GiST index (0006), so "does this binding's node cover node
 * X?" is a prefix test rather than a recursive walk (Doc 07 §7, §10).
 *
 * **Labels are id-derived** — `n_` + the node's UUID hex, never the display
 * `name` (Doc 01 §3.5). Migration 0003 enforces that with a check constraint,
 * so a rename touches `name` alone and cannot rewrite the paths beneath it.
 * Use {@link scopePathLabel} rather than assembling the label by hand.
 */

import { SCOPE_PATH_LABEL_PREFIX } from '@plantops/contracts';
import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';
import { Client } from './client.entity.js';

/** Node kinds, in the order the Postgres enum declares them. Extensible. */
export const SCOPE_NODE_KINDS = ['group', 'plant', 'department', 'gate'] as const;
export type ScopeNodeKind = (typeof SCOPE_NODE_KINDS)[number];

/** Postgres enum type backing {@link ScopeNode.kind}, created in migration 0001. */
export const SCOPE_NODE_KIND_ENUM = IAM_ENUMS.SCOPE_NODE_KIND;

/**
 * The ltree label for a node id: `n_` + the UUID with hyphens removed.
 *
 * ltree labels are limited to `[A-Za-z0-9_]` and may not start with a digit,
 * which is why the prefix exists — a bare hex UUID can begin with a digit.
 * This is the single definition of the rule that migration 0003's check
 * constraint enforces; Session 16 builds paths from it.
 */
export function scopePathLabel(id: string): string {
  return `${SCOPE_PATH_LABEL_PREFIX}${id.replace(/-/g, '')}`;
}

@Entity({ schema: IAM_SCHEMA, name: 'scope_node' })
export class ScopeNode {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId!: string;

  /** `null` = the client's root node. Enforced to share `client_id` (0003). */
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({
    name: 'kind',
    type: 'enum',
    enum: SCOPE_NODE_KINDS,
    enumName: SCOPE_NODE_KIND_ENUM,
  })
  kind!: ScopeNodeKind;

  /** Display only. Never appears in {@link path} (Doc 01 §3.5). */
  @Column({ name: 'name', type: 'text' })
  name!: string;

  /**
   * Materialized path, e.g. `n_9f2c….n_4a1b….n_7d3e…`. Maintained on insert
   * and move by the service layer (Doc 07 §7) — there is no trigger, because a
   * move rewrites a whole subtree in one statement.
   */
  @Column({ name: 'path', type: 'ltree' })
  path!: string;

  @Column({ name: 'metadata', type: 'jsonb', default: () => `'{}'::jsonb` })
  metadata!: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Client, (client) => client.scopeNodes, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client!: Client;

  @ManyToOne(() => ScopeNode, (scopeNode) => scopeNode.children, {
    onDelete: 'RESTRICT',
    nullable: true,
  })
  @JoinColumn({ name: 'parent_id' })
  parent!: ScopeNode | null;

  @OneToMany(() => ScopeNode, (scopeNode) => scopeNode.parent)
  children!: ScopeNode[];
}
