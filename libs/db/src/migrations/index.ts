/**
 * The migration chain, in application order.
 *
 * TypeORM orders migrations by the 13-digit timestamp at the end of the class
 * name, not by array position — `libs/db/src/migrations/migrations.spec.ts`
 * pins the two orderings together so a mis-stamped class fails the test suite
 * rather than the release.
 *
 * The order follows Doc 07 §4: extensions and enums, registry, tenant,
 * mapping, audit — then indexes, then (Session 5) RLS and the bootstrap seed.
 */

import { Extensions1786406400001 } from './0001-extensions-enums.js';
import { RegistryTables1786406400002 } from './0002-registry-tables.js';
import { TenantTables1786406400003 } from './0003-tenant-tables.js';
import { MappingTables1786406400004 } from './0004-mapping-tables.js';
import { AuditTrail1786406400005 } from './0005-audit-trail.js';
import { Indexes1786406400006 } from './0006-indexes.js';

export { ENUM_VALUES, Extensions1786406400001 } from './0001-extensions-enums.js';
export { RegistryTables1786406400002 } from './0002-registry-tables.js';
export { TenantTables1786406400003 } from './0003-tenant-tables.js';
export { MappingTables1786406400004 } from './0004-mapping-tables.js';
export { AuditTrail1786406400005 } from './0005-audit-trail.js';
export { Indexes1786406400006, PERFORMANCE_INDEX_NAMES } from './0006-indexes.js';

export const migrations = [
  Extensions1786406400001,
  RegistryTables1786406400002,
  TenantTables1786406400003,
  MappingTables1786406400004,
  AuditTrail1786406400005,
  Indexes1786406400006,
] as const;
