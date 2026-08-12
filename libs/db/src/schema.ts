/**
 * Every IAM table lives in the `iam` schema (Doc 01 §preamble), created by
 * migration 0001.
 *
 * The TypeORM bookkeeping table deliberately does **not**: it stays in the
 * connection's default schema so the first migration is free to create `iam`
 * itself, rather than needing a schema that only a migration can produce.
 */
export const IAM_SCHEMA = 'iam';

/** Postgres enum types, all created up front in migration 0001 (Doc 07 §4). */
export const IAM_ENUMS = {
  NAV_NODE_KIND: 'nav_node_kind',
  CLIENT_STATUS: 'client_status',
  SCOPE_NODE_KIND: 'scope_node_kind',
  USER_STATUS: 'user_status',
  SERVICE_ACCOUNT_STATUS: 'service_account_status',
  IDENTITY_PROVIDER: 'identity_provider',
  AUDIT_ACTOR_TYPE: 'audit_actor_type',
} as const;

export type IamEnumName = (typeof IAM_ENUMS)[keyof typeof IAM_ENUMS];
