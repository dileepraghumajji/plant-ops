/**
 * `iam.client_application` — which applications a tenant has enabled, and the
 * per-client config for each (Doc 01 §4.1).
 *
 * Disabling is `enabled = false`, never a delete: the row keeps the tenant's
 * config so re-enabling restores it, and every role mapping that referenced the
 * app's permissions stays intact but inert (Doc 02 §7). A disabled app's
 * permissions are simply absent from resolved grants (Doc 04 §4).
 */

import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { IAM_SCHEMA } from '../schema.js';
import { Application } from './application.entity.js';
import { Client } from './client.entity.js';

@Entity({ schema: IAM_SCHEMA, name: 'client_application' })
export class ClientApplication {
  @PrimaryColumn({ name: 'client_id', type: 'uuid' })
  clientId!: string;

  @PrimaryColumn({ name: 'application_id', type: 'uuid' })
  applicationId!: string;

  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ name: 'config', type: 'jsonb', default: () => `'{}'::jsonb` })
  config!: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Client, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client!: Client;

  @ManyToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id' })
  application!: Application;
}
