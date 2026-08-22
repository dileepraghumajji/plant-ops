/**
 * The request-serving database connection (Doc 07 §2).
 *
 * One pool, against `DATABASE_URL` and as the non-owning app role — the role
 * that RLS actually constrains. Whether a pooler sits in front of that URL is
 * `DATABASE_POOLED`, stated in configuration rather than inferred from the
 * variable's name (Doc 11 §8, gap 3). `main.ts` has already proved that role
 * cannot bypass policy before this module is constructed; if that assertion is
 * ever moved or removed, this connection silently becomes a connection that
 * returns other tenants' rows (Doc 07 §5.1).
 *
 * Unlike Redis, an unreachable Postgres at boot is fatal: there is no degraded
 * mode for an IAM that cannot read its own tables, and starting anyway would
 * only turn a clear connection error into a wall of 500s.
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import { createAppDataSource, describeAppConnection } from '@plantops/db';
import type { DataSource } from 'typeorm';
import { ENV } from '../config/env.token';
import { withTimeout } from '../common/with-timeout';

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly dataSource: DataSource;

  constructor(@Inject(ENV) private readonly env: EnvConfig) {
    this.dataSource = createAppDataSource(env);
  }

  async onModuleInit(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      await this.dataSource.initialize();
      // The topology, not the endpoint. For a self-hosted install nobody can
      // log into, the boot log is the only place that says whether this process
      // believes it is behind a pooler — and DATABASE_POOLED is now a claim an
      // operator makes rather than one the code infers (Doc 11 §8, gap 3).
      this.logger.log(`Database pool ready — ${describeAppConnection(this.env)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }

  /**
   * Is Postgres answering within the readiness budget?
   *
   * `select 1` over the pool rather than `dataSource.isInitialized`: the flag
   * says a pool object exists, which stays true across a database restart, a
   * failed-over primary, and an exhausted connection limit.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await withTimeout(
        this.dataSource.query('select 1'),
        this.env.READINESS_TIMEOUT_MS,
        'postgres select 1',
      );
      return true;
    } catch {
      return false;
    }
  }
}
