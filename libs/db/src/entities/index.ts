/**
 * Every entity the data sources load, listed explicitly.
 *
 * Explicit over glob: directory globs break under ESM + bundling (the app is
 * webpacked, Doc 08 §6), and an entity that silently fails to load surfaces as
 * a confusing "metadata not found" at first query instead of a build error.
 *
 * Ordered as Doc 01 presents them: registry, then tenant, then mapping, then
 * audit.
 */

import { Application } from './application.entity.js';
import { AuditTrail } from './audit-trail.entity.js';
import { Client } from './client.entity.js';
import { ClientApplication } from './client-application.entity.js';
import { MenuPermission } from './menu-permission.entity.js';
import { NavNode } from './nav-node.entity.js';
import { Permission } from './permission.entity.js';
import { Role } from './role.entity.js';
import { RoleBinding } from './role-binding.entity.js';
import { RolePermission } from './role-permission.entity.js';
import { ScopeNode } from './scope-node.entity.js';
import { ServiceAccount } from './service-account.entity.js';
import { Session } from './session.entity.js';
import { User } from './user.entity.js';
import { UserIdentity } from './user-identity.entity.js';

// ── registry / catalog (Doc 01 §3.1–3.3) ─────────────────────────────────
export { Application } from './application.entity.js';
export { Permission } from './permission.entity.js';
export { NavNode, NAV_NODE_KINDS, NAV_NODE_KIND_ENUM } from './nav-node.entity.js';

// ── tenant (Doc 01 §3.4–3.7, §4.2) ───────────────────────────────────────
export { Client, CLIENT_STATUSES, CLIENT_STATUS_ENUM } from './client.entity.js';
export type { ClientStatus } from './client.entity.js';
export {
  ScopeNode,
  SCOPE_NODE_KINDS,
  SCOPE_NODE_KIND_ENUM,
  scopePathLabel,
} from './scope-node.entity.js';
export type { ScopeNodeKind } from './scope-node.entity.js';
export { User, USER_STATUSES, USER_STATUS_ENUM } from './user.entity.js';
export type { UserStatus } from './user.entity.js';
export {
  ServiceAccount,
  SERVICE_ACCOUNT_STATUSES,
  SERVICE_ACCOUNT_STATUS_ENUM,
} from './service-account.entity.js';
export type { ServiceAccountStatus } from './service-account.entity.js';
export { Role } from './role.entity.js';

// ── mapping (Doc 01 §4.1, §4.3–4.7) ──────────────────────────────────────
export { ClientApplication } from './client-application.entity.js';
export { RolePermission } from './role-permission.entity.js';
export { MenuPermission } from './menu-permission.entity.js';
export { RoleBinding } from './role-binding.entity.js';
export {
  UserIdentity,
  IDENTITY_PROVIDERS,
  IDENTITY_PROVIDER_ENUM,
} from './user-identity.entity.js';
export type { IdentityProvider } from './user-identity.entity.js';
export { Session } from './session.entity.js';

// ── audit (Doc 01 §4.8) ──────────────────────────────────────────────────
export {
  AuditTrail,
  AUDIT_ACTOR_TYPES,
  AUDIT_ACTOR_TYPE_ENUM,
} from './audit-trail.entity.js';
export type { AuditActorType } from './audit-trail.entity.js';

export const entities = [
  Application,
  Permission,
  NavNode,
  Client,
  ScopeNode,
  User,
  ServiceAccount,
  Role,
  ClientApplication,
  RolePermission,
  MenuPermission,
  RoleBinding,
  UserIdentity,
  Session,
  AuditTrail,
] as const;
