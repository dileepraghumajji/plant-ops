/**
 * `@plantops/db` — TypeORM entities, migrations, and the data sources behind
 * the IAM (Doc 08 §2).
 *
 * Imported by `apps/iam-api` and nothing else: no other app touches IAM tables
 * directly, they call the API. The boundary is enforced by lint, not etiquette.
 */

// TypeORM's decorators emit `design:type` metadata; the polyfill has to be
// loaded before any entity class is evaluated. Importing it here means a
// consumer gets working entities from `import '@plantops/db'` alone.
import 'reflect-metadata';

export * from './data-source.js';
export * from './entities/index.js';
export * from './migrations/index.js';
export * from './schema.js';
