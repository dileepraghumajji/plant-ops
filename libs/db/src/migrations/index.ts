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
import { AuthFunctions1786406400012 } from './0012-auth-functions.js';
import { RefreshRotation1786406400013 } from './0013-refresh-rotation.js';
import { PasswordResetAccountState1786406400014 } from './0014-password-reset-account-state.js';
import { ServiceAccountAuth1786406400015 } from './0015-service-account-auth.js';
import { BindingExpirySweep1786406400016 } from './0016-binding-expiry-sweep.js';
import { IamPermissionSeed1786406400017 } from './0017-iam-permission-seed.js';
import { PinnedClientLookup1786406400018 } from './0018-pinned-client-lookup.js';
import { OnPremPlatformRole1786406400019 } from './0019-onprem-platform-role.js';

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
export {
  AuthFunctions1786406400012,
  AUTH_BEGIN_SESSION_SIGNATURE,
  AUTH_LOOKUP_PASSWORD_IDENTITY_SIGNATURE,
  AUTH_RECORD_LOGIN_FAILURE_SIGNATURE,
  LOGIN_FAILURE_REASONS,
  SESSION_IS_REVOKED_SIGNATURE,
  type LoginFailureReason,
} from './0012-auth-functions.js';
export {
  RefreshRotation1786406400013,
  AUTH_ROTATE_REFRESH_TOKEN_SIGNATURE,
  REFRESH_AUDIT_ACTIONS,
  REFRESH_OUTCOMES,
  type RefreshOutcome,
} from './0013-refresh-rotation.js';
export {
  PasswordResetAccountState1786406400014,
  ACCOUNT_AUDIT_ACTIONS,
  AUTH_COMPLETE_PASSWORD_RESET_SIGNATURE,
  AUTH_RECORD_LOGIN_FAILURE_V2_SIGNATURE,
  AUTH_REQUEST_PASSWORD_RESET_SIGNATURE,
  AUTO_LOCK_REASON,
  PASSWORD_RESET_OUTCOMES,
  type PasswordResetOutcome,
} from './0014-password-reset-account-state.js';
export {
  ServiceAccountAuth1786406400015,
  AUTH_LOOKUP_SERVICE_ACCOUNT_SIGNATURE,
  AUTH_RECORD_SERVICE_TOKEN_FAILURE_SIGNATURE,
  SERVICE_ACCOUNT_AUDIT_ACTIONS,
  SERVICE_TOKEN_FAILURE_REASONS,
  type ServiceTokenFailureReason,
} from './0015-service-account-auth.js';
export {
  BindingExpirySweep1786406400016,
  EXPIRY_SWEEP_INDEX,
  EXPIRY_SWEPT_AT_COLUMN,
  ROLE_BINDING_EXPIRED_ACTION,
  SWEEP_EXPIRED_BINDINGS_SIGNATURE,
} from './0016-binding-expiry-sweep.js';
export {
  IamPermissionSeed1786406400017,
  CLIENT_ADMIN_ROLE_NAME,
  IAM_APPLICATION_DESCRIPTION,
  IAM_APPLICATION_KEY,
  IAM_APPLICATION_NAME,
  IAM_CLIENT_PERMISSION_SEED,
  IAM_PLATFORM_PERMISSION_SEED,
} from './0017-iam-permission-seed.js';
export { PinnedClientLookup1786406400018 } from './0018-pinned-client-lookup.js';
export {
  OnPremPlatformRole1786406400019,
  ONPREM_AUDIT_ACTIONS,
  ONPREM_ROLE_NAME,
  ONPREM_ROLE_PERMISSION_KEYS,
  ONPREM_SERVICE_ACCOUNT_KEY,
  ONPREM_SERVICE_ACCOUNT_NAME,
} from './0019-onprem-platform-role.js';

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
  AuthFunctions1786406400012,
  RefreshRotation1786406400013,
  PasswordResetAccountState1786406400014,
  ServiceAccountAuth1786406400015,
  BindingExpirySweep1786406400016,
  IamPermissionSeed1786406400017,
  PinnedClientLookup1786406400018,
  OnPremPlatformRole1786406400019,
] as const;
