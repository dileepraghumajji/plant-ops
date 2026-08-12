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
import { RlsTenant1786406400007 } from './0007-rls-tenant.js';
import { RlsCatalog1786406400008 } from './0008-rls-catalog.js';
import { RlsJoinTables1786406400009 } from './0009-rls-join-tables.js';
import { AuditWriteFn1786406400010 } from './0010-audit-write-fn.js';
import { BootstrapSeed1786406400011 } from './0011-bootstrap-seed.js';

export { ENUM_VALUES, Extensions1786406400001 } from './0001-extensions-enums.js';
export { RegistryTables1786406400002 } from './0002-registry-tables.js';
export { TenantTables1786406400003 } from './0003-tenant-tables.js';
export { MappingTables1786406400004 } from './0004-mapping-tables.js';
export { AuditTrail1786406400005 } from './0005-audit-trail.js';
export { Indexes1786406400006, PERFORMANCE_INDEX_NAMES } from './0006-indexes.js';
export {
  RlsTenant1786406400007,
  APP_GROUP_ROLE,
  CTX_CLIENT_ID,
  CTX_IS_PLATFORM_ADMIN,
  TENANT_RLS_TABLES,
} from './0007-rls-tenant.js';
export { RlsCatalog1786406400008, CATALOG_RLS_TABLES } from './0008-rls-catalog.js';
export { RlsJoinTables1786406400009 } from './0009-rls-join-tables.js';
export { AuditWriteFn1786406400010, WRITE_AUDIT_SIGNATURE } from './0010-audit-write-fn.js';
export {
  BootstrapSeed1786406400011,
  BOOTSTRAP_SECRET_ENV,
  PLATFORM_CLIENT_SLUG,
  PLATFORM_ROLE_NAME,
  PLATFORM_SERVICE_ACCOUNT_KEY,
} from './0011-bootstrap-seed.js';

export const migrations = [
  Extensions1786406400001,
  RegistryTables1786406400002,
  TenantTables1786406400003,
  MappingTables1786406400004,
  AuditTrail1786406400005,
  Indexes1786406400006,
  RlsTenant1786406400007,
  RlsCatalog1786406400008,
  RlsJoinTables1786406400009,
  AuditWriteFn1786406400010,
  BootstrapSeed1786406400011,
] as const;
