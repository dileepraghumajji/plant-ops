/**
 * Shape tests over the entity metadata. These need no database: TypeORM
 * populates `getMetadataArgsStorage()` when the decorated classes are
 * evaluated, which is exactly where the naming and typing conventions of
 * Doc 07 §3 either hold or quietly stop holding.
 *
 * The invariants that only a database can prove — the XOR check, the expression
 * unique index, `on delete restrict` — are covered by the integration suites
 * next to the migrations.
 */

import {
  AUDIT_ACTOR_TYPE_VALUES,
  AuditActorType,
  CLIENT_STATUS_VALUES,
  ClientStatus,
  NavNodeKind,
  SCOPE_NODE_KIND_VALUES,
  SCOPE_PATH_LABEL_PREFIX,
  SERVICE_ACCOUNT_STATUS_VALUES,
  ScopeNodeKind,
  ServiceAccountStatus,
  USER_STATUS_VALUES,
  UserStatus,
} from '@plantops/contracts';
import { getMetadataArgsStorage } from 'typeorm';
import { ENUM_VALUES } from '../migrations/index.js';
import { IAM_ENUMS, IAM_SCHEMA } from '../schema.js';
import { Application } from './application.entity.js';
import { AUDIT_ACTOR_TYPES, AuditTrail } from './audit-trail.entity.js';
import { CLIENT_STATUSES, Client } from './client.entity.js';
import { ClientApplication } from './client-application.entity.js';
import { MenuPermission } from './menu-permission.entity.js';
import { NAV_NODE_KINDS, NavNode } from './nav-node.entity.js';
import { PasswordResetToken } from './password-reset-token.entity.js';
import { Permission } from './permission.entity.js';
import { Role } from './role.entity.js';
import { RoleBinding } from './role-binding.entity.js';
import { RolePermission } from './role-permission.entity.js';
import { SCOPE_NODE_KINDS, ScopeNode, scopePathLabel } from './scope-node.entity.js';
import { SERVICE_ACCOUNT_STATUSES, ServiceAccount } from './service-account.entity.js';
import { Session } from './session.entity.js';
import { User, USER_STATUSES } from './user.entity.js';
import { IDENTITY_PROVIDERS, UserIdentity } from './user-identity.entity.js';
import { entities } from './index.js';

const storage = getMetadataArgsStorage();
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

const tableOf = (target: object) =>
  storage.tables.find((table) => table.target === target);

const columnsOf = (target: object) =>
  storage.columns.filter((column) => column.target === target);

const columnOf = (target: object, property: string) =>
  columnsOf(target).find((column) => column.propertyName === property);

const columnName = (target: object, property: string) =>
  columnOf(target, property)?.options.name;

const indexesOf = (target: object) =>
  storage.indices.filter((index) => index.target === target);

const relationsOf = (target: object) =>
  storage.relations.filter((relation) => relation.target === target);

/** Every entity, paired with the table it maps, in `entities` order. */
const ALL: readonly (readonly [table: string, entity: object])[] = [
  ['application', Application],
  ['permission', Permission],
  ['nav_node', NavNode],
  ['client', Client],
  ['scope_node', ScopeNode],
  ['user', User],
  ['service_account', ServiceAccount],
  ['role', Role],
  ['client_application', ClientApplication],
  ['role_permission', RolePermission],
  ['menu_permission', MenuPermission],
  ['role_binding', RoleBinding],
  ['user_identity', UserIdentity],
  ['session', Session],
  // Session 10's reset credential — a mechanism (Doc 03 §7), not one of Doc
  // 01's model tables, but subject to every convention below all the same.
  ['password_reset_token', PasswordResetToken],
  ['audit_trail', AuditTrail],
];

/** The join tables — keyed by their pair, with no surrogate id. */
const COMPOSITE_KEY_ENTITIES = [ClientApplication, RolePermission, MenuPermission];

describe('entity registry', () => {
  it('loads every table the schema has, and only those', () => {
    expect([...entities]).toEqual(ALL.map(([, entity]) => entity));
  });

  it('pairs each entity with a distinct table', () => {
    const tables = ALL.map(([table]) => table);
    expect(new Set(tables).size).toBe(tables.length);
  });
});

describe.each(ALL)('%s', (expectedTable, entity) => {
  it('lives in the iam schema under a singular snake_case table name', () => {
    const table = tableOf(entity);
    expect(table?.schema).toBe(IAM_SCHEMA);
    expect(table?.name).toBe(expectedTable);
    expect(expectedTable).toMatch(SNAKE_CASE);
    // Singular, per Doc 07 §3 — the plural of every table here would end in
    // `s`, and none of the singular forms do.
    expect(expectedTable.endsWith('s')).toBe(false);
  });

  it('names every column in snake_case explicitly', () => {
    const columns = columnsOf(entity);
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column.options.name).toBeDefined();
      expect(column.options.name).toMatch(SNAKE_CASE);
    }
  });

  it('declares an explicit Postgres type for every column', () => {
    // Doc 07 §3: explicit column types matching the data model. Inferred
    // types are how a `timestamptz` silently becomes a `timestamp`.
    for (const column of columnsOf(entity)) {
      expect(column.options.type ?? column.mode).toBeDefined();
      if (column.mode === 'regular') {
        expect(column.options.type).toBeDefined();
      }
    }
  });

  it('timestamps with timestamptz, never a naive timestamp', () => {
    for (const column of columnsOf(entity)) {
      if (/_at$/.test(String(column.options.name))) {
        expect(column.options.type).toBe('timestamptz');
      }
    }
  });

  it('has a primary key', () => {
    const generated = storage.generations.find(
      (generation) => generation.target === entity,
    );
    if (COMPOSITE_KEY_ENTITIES.includes(entity as never)) {
      // A join row is nothing but its pair: no surrogate id to generate.
      expect(generated).toBeUndefined();
      const primaries = columnsOf(entity).filter(
        (column) => column.options.primary === true,
      );
      expect(primaries).toHaveLength(2);
    } else {
      expect(generated?.strategy).toBe('uuid');
    }
  });

  it('carries a created_at', () => {
    // Every table records when its row appeared — including the join tables,
    // where it is the only thing besides the key.
    expect(columnName(entity, 'createdAt') ?? columnName(entity, 'issuedAt')).toBeDefined();
  });
});

describe('tenant ownership (Doc 01 §6.6, Doc 07 §6)', () => {
  it.each([
    ['scope_node', ScopeNode],
    ['user', User],
    ['role', Role],
    ['role_binding', RoleBinding],
    ['user_identity', UserIdentity],
    ['session', Session],
    ['password_reset_token', PasswordResetToken],
  ] as const)('gives %s a non-null client_id for RLS to key off', (_label, entity) => {
    const clientId = columnOf(entity, 'clientId');
    expect(clientId?.options.name).toBe('client_id');
    expect(clientId?.options.type).toBe('uuid');
    expect(clientId?.options.nullable).toBeFalsy();
  });

  it('lets service_account.client_id be null — that means platform-level', () => {
    expect(columnOf(ServiceAccount, 'clientId')?.options.nullable).toBe(true);
  });

  it('lets audit_trail.client_id be null — that means a platform action', () => {
    expect(columnOf(AuditTrail, 'clientId')?.options.nullable).toBe(true);
  });
});

describe('Postgres enums (migration 0001)', () => {
  it.each([
    ['nav_node.kind', NavNode, 'kind', NAV_NODE_KINDS, IAM_ENUMS.NAV_NODE_KIND],
    ['client.status', Client, 'status', CLIENT_STATUSES, IAM_ENUMS.CLIENT_STATUS],
    ['scope_node.kind', ScopeNode, 'kind', SCOPE_NODE_KINDS, IAM_ENUMS.SCOPE_NODE_KIND],
    ['user.status', User, 'status', USER_STATUSES, IAM_ENUMS.USER_STATUS],
    [
      'service_account.status',
      ServiceAccount,
      'status',
      SERVICE_ACCOUNT_STATUSES,
      IAM_ENUMS.SERVICE_ACCOUNT_STATUS,
    ],
    [
      'user_identity.provider',
      UserIdentity,
      'provider',
      IDENTITY_PROVIDERS,
      IAM_ENUMS.IDENTITY_PROVIDER,
    ],
    [
      'audit_trail.actor_type',
      AuditTrail,
      'actorType',
      AUDIT_ACTOR_TYPES,
      IAM_ENUMS.AUDIT_ACTOR_TYPE,
    ],
  ] as const)('binds %s to the named type with the migration\'s labels', (
    _label,
    entity,
    property,
    values,
    enumName,
  ) => {
    const column = columnOf(entity, property);
    // A named type, not an inline one: an inline enum would generate a second
    // type beside the one migration 0001 created.
    expect(column?.options.type).toBe('enum');
    expect(column?.options.enumName).toBe(enumName);
    expect(column?.options.enum).toEqual([...values]);
    // ...and the labels, in order, must be what 0001 actually created.
    expect([...values]).toEqual([...ENUM_VALUES[enumName]]);
  });

  it('agrees with @plantops/contracts on the nav kind discriminator', () => {
    expect([...NAV_NODE_KINDS]).toEqual(Object.values(NavNodeKind));
  });

  it('agrees with @plantops/contracts on the service-account states', () => {
    // Two vocabularies for one column: the Postgres enum (0001) that this
    // entity mirrors, and the wire status `@plantops/contracts` publishes for
    // `PATCH /iam/service-accounts/:id`. Contracts cannot import this lib —
    // it has zero dependencies by design (Doc 08 §3) — so the values are spelled
    // twice, and this is what stops the two spellings from drifting into a
    // status the API accepts and the column rejects.
    expect([...SERVICE_ACCOUNT_STATUSES]).toEqual([...SERVICE_ACCOUNT_STATUS_VALUES]);
    expect([...SERVICE_ACCOUNT_STATUSES]).toEqual(Object.values(ServiceAccountStatus));
  });

  it('agrees with @plantops/contracts on the scope-node kinds', () => {
    // The same two-vocabulary problem again, for `POST /iam/scopes` (Doc 06 §6).
    // A drift here would be an API that accepts a kind the column rejects — and
    // it would surface as a 500 on the one surface a tenant admin uses most.
    expect([...SCOPE_NODE_KINDS]).toEqual([...SCOPE_NODE_KIND_VALUES]);
    expect([...SCOPE_NODE_KINDS]).toEqual(Object.values(ScopeNodeKind));
  });

  it('agrees with @plantops/contracts on the account states', () => {
    // The same two-vocabulary problem, for `PATCH /iam/users/:id` (Doc 06 §8).
    // A drift here would be an API that accepts a status login never checks
    // for — and the state machine of Doc 03 §8 is what decides whether somebody
    // can get in at all.
    expect([...USER_STATUSES]).toEqual([...USER_STATUS_VALUES]);
    expect([...USER_STATUSES]).toEqual(Object.values(UserStatus));
  });

  it('agrees with @plantops/contracts on the audit actor types', () => {
    // The same two-vocabulary problem once more, for `GET /iam/audit`
    // (Doc 06 §12). This column is never written by the API — `iam.write_audit`
    // derives it (migration 0010) — so the drift would be silent in the other
    // direction: a read shape publishing an `actor_type` the column can never
    // produce, and a filter on it that always returns nothing.
    expect([...AUDIT_ACTOR_TYPES]).toEqual([...AUDIT_ACTOR_TYPE_VALUES]);
    expect([...AUDIT_ACTOR_TYPES]).toEqual(Object.values(AuditActorType));
  });

  it('agrees with @plantops/contracts on the client states', () => {
    // The same two-vocabulary problem, for `PATCH /iam/clients/:id` (Doc 06 §5).
    // Suspension is the tenant off switch, so a drift here would be an API that
    // accepts a status login never checks for.
    expect([...CLIENT_STATUSES]).toEqual([...CLIENT_STATUS_VALUES]);
    expect([...CLIENT_STATUSES]).toEqual(Object.values(ClientStatus));
  });
});

describe('unique keys carrying the Doc 01 §6 invariants', () => {
  it.each([
    ['application.key is globally unique', Application, 'application_key_key', ['key']],
    [
      'permission is unique on (application_id, key)',
      Permission,
      'permission_application_id_key_key',
      ['applicationId', 'key'],
    ],
    [
      'nav_node is unique on (application_id, key)',
      NavNode,
      'nav_node_application_id_key_key',
      ['applicationId', 'key'],
    ],
    ['client.slug is globally unique', Client, 'client_slug_key', ['slug']],
    // Doc 01 §6 / Doc 07 §9 — per client, not global: the same address is a
    // distinct user in another tenant, and two clients may each name a role
    // "Gate Supervisor".
    ['user is unique on (client_id, email)', User, 'user_client_id_email_key', [
      'clientId',
      'email',
    ]],
    ['role is unique on (client_id, name)', Role, 'role_client_id_name_key', [
      'clientId',
      'name',
    ]],
    // The lookup handle for `POST /auth/token`, which carries no tenant.
    ['service_account.key is globally unique', ServiceAccount, 'service_account_key_key', [
      'key',
    ]],
    [
      'a user has at most one identity per provider',
      UserIdentity,
      'user_identity_user_id_provider_key',
      ['userId', 'provider'],
    ],
  ] as const)('%s', (_label, entity, indexName, columns) => {
    const index = indexesOf(entity).find((candidate) => candidate.name === indexName);
    expect(index?.unique).toBe(true);
    expect(index?.columns).toEqual([...columns]);
  });
});

describe('nav_node', () => {
  it('is a self-referencing tree with a nullable parent (Doc 01 §3.3)', () => {
    const parent = relationsOf(NavNode).find(
      (relation) => relation.propertyName === 'parent',
    );
    expect(parent?.relationType).toBe('many-to-one');
    expect(parent?.options.nullable).toBe(true);
    expect(columnName(NavNode, 'parentId')).toBe('parent_id');
  });

  it('defaults is_public to false — unmapped means hidden (Doc 05 §3)', () => {
    expect(columnOf(NavNode, 'isPublic')?.options.default).toBe(false);
  });

  it('carries sort_order and is_active for the pruning walk', () => {
    expect(columnOf(NavNode, 'sortOrder')?.options).toMatchObject({
      type: 'integer',
      default: 0,
    });
    expect(columnOf(NavNode, 'isActive')?.options).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });

  it('allows a routeless container node', () => {
    expect(columnOf(NavNode, 'route')?.options.nullable).toBe(true);
  });
});

describe('scope_node — the WHERE dimension (Doc 01 §3.5)', () => {
  it('stores path as a real ltree, not text', () => {
    // Coverage is the `<@` operator over a GiST index (Doc 07 §7). A text
    // path is explicitly not an acceptable substitute.
    expect(columnOf(ScopeNode, 'path')?.options.type).toBe('ltree');
    expect(columnOf(ScopeNode, 'path')?.options.nullable).toBeFalsy();
  });

  it('is a self-referencing tree with a nullable parent', () => {
    const parent = relationsOf(ScopeNode).find(
      (relation) => relation.propertyName === 'parent',
    );
    expect(parent?.relationType).toBe('many-to-one');
    expect(parent?.options.nullable).toBe(true);
  });

  it('restricts, rather than cascades, on delete', () => {
    // Doc 07 §9 — a node that still grants access must refuse to disappear.
    for (const property of ['client', 'parent']) {
      const relation = relationsOf(ScopeNode).find(
        (candidate) => candidate.propertyName === property,
      );
      expect(relation?.options.onDelete).toBe('RESTRICT');
    }
  });

  describe('scopePathLabel', () => {
    const id = '9f2c4a1b-3d5e-4f60-8a71-b2c3d4e5f607';

    it('derives the label from the id, never a name', () => {
      expect(scopePathLabel(id)).toBe('n_9f2c4a1b3d5e4f608a71b2c3d4e5f607');
    });

    it('uses the prefix @plantops/contracts publishes', () => {
      expect(scopePathLabel(id).startsWith(SCOPE_PATH_LABEL_PREFIX)).toBe(true);
    });

    it('produces a legal ltree label — [A-Za-z0-9_], never leading a digit', () => {
      // The prefix exists for exactly this reason: a bare UUID hex may start
      // with a digit, which ltree rejects.
      expect(scopePathLabel(id)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    });

    it('is stable under a rename, because the name is not an input', () => {
      expect(scopePathLabel(id)).toBe(scopePathLabel(id));
      expect(scopePathLabel(id)).not.toContain('Plant');
    });
  });
});

describe('role_binding — WHO × WHAT × WHERE (Doc 01 §4.5)', () => {
  it('makes both subject columns nullable, since exactly one is set', () => {
    // The XOR itself is a check constraint; metadata can only show that the
    // shape allows either arm. The integration suite proves the constraint.
    expect(columnOf(RoleBinding, 'userId')?.options.nullable).toBe(true);
    expect(columnOf(RoleBinding, 'serviceAccountId')?.options.nullable).toBe(true);
  });

  it('requires a role and a scope node', () => {
    expect(columnOf(RoleBinding, 'roleId')?.options.nullable).toBeFalsy();
    expect(columnOf(RoleBinding, 'scopeNodeId')?.options.nullable).toBeFalsy();
  });

  it('leaves expires_at optional — a binding without one is permanent', () => {
    expect(columnOf(RoleBinding, 'expiresAt')?.options).toMatchObject({
      type: 'timestamptz',
      nullable: true,
    });
  });

  it('restricts on scope_node but cascades from the subject and role', () => {
    const onDelete = (property: string) =>
      relationsOf(RoleBinding).find((relation) => relation.propertyName === property)
        ?.options.onDelete;
    expect(onDelete('scopeNode')).toBe('RESTRICT');
    expect(onDelete('user')).toBe('CASCADE');
    expect(onDelete('serviceAccount')).toBe('CASCADE');
    expect(onDelete('role')).toBe('CASCADE');
  });
});

describe('session (Doc 01 §4.7, Doc 03 §6)', () => {
  it('makes both subject columns nullable, since exactly one is set', () => {
    expect(columnOf(Session, 'userId')?.options.nullable).toBe(true);
    expect(columnOf(Session, 'serviceAccountId')?.options.nullable).toBe(true);
  });

  it('uses issued_at as the creation stamp rather than a second column', () => {
    expect(columnName(Session, 'issuedAt')).toBe('issued_at');
    expect(columnName(Session, 'createdAt')).toBeUndefined();
  });

  it('keeps revoked_at nullable — set once by force-logout, never cleared', () => {
    expect(columnOf(Session, 'revokedAt')?.options.nullable).toBe(true);
  });

  it('stores only the hash of the refresh token', () => {
    expect(columnName(Session, 'refreshTokenHash')).toBe('refresh_token_hash');
    expect(columnsOf(Session).map((column) => column.options.name)).not.toContain(
      'refresh_token',
    );
  });

  it('carries the reuse grace state as a hash and a time (Doc 03 §4)', () => {
    // Hashed like the current generation, and for the same reason: the token
    // one step back is still a live credential inside the window.
    expect(columnName(Session, 'previousRefreshTokenHash')).toBe(
      'previous_refresh_token_hash',
    );
    expect(columnName(Session, 'rotatedAt')).toBe('rotated_at');
    expect(columnOf(Session, 'previousRefreshTokenHash')?.options.nullable).toBe(true);
    expect(columnOf(Session, 'rotatedAt')?.options.nullable).toBe(true);
    expect(columnsOf(Session).map((column) => column.options.name)).not.toContain(
      'previous_refresh_token',
    );
  });
});

describe('user — the lockout counter (Doc 03 §8, migration 0014)', () => {
  it('counts failures on the row it locks, not in a cache', () => {
    const attempts = columnOf(User, 'failedLoginAttempts');
    expect(attempts?.options.name).toBe('failed_login_attempts');
    expect(attempts?.options.type).toBe('integer');
    // Not nullable: "no failures yet" is zero. A null would make every read
    // branch on a state that means the same thing.
    expect(attempts?.options.nullable).toBeFalsy();
    expect(attempts?.options.default).toBe(0);
  });

  it('records when the last failure was, nullably', () => {
    expect(columnOf(User, 'lastFailedLoginAt')?.options.name).toBe(
      'last_failed_login_at',
    );
    expect(columnOf(User, 'lastFailedLoginAt')?.options.nullable).toBe(true);
  });

  it('still keeps no credential material on the user row', () => {
    // The counter is about credentials; it must not become an excuse to put
    // one here. Hashes stay on `user_identity` (Doc 01 §4.6).
    const names = columnsOf(User).map((column) => String(column.options.name));
    expect(names.filter((name) => /hash|secret|password/.test(name))).toEqual([]);
  });
});

describe('password_reset_token (Doc 03 §7, migration 0014)', () => {
  it('stores only the hash of the token', () => {
    expect(columnName(PasswordResetToken, 'tokenHash')).toBe('token_hash');
    expect(
      columnsOf(PasswordResetToken).map((column) => column.options.name),
    ).not.toContain('token');
  });

  it('is time-boxed and single-use', () => {
    // Both halves of Doc 03 §7's "tokenized, time-boxed": an expiry the row
    // carries, and a spend marker that is set exactly once.
    expect(columnOf(PasswordResetToken, 'expiresAt')?.options.nullable).toBeFalsy();
    expect(columnOf(PasswordResetToken, 'usedAt')?.options.nullable).toBe(true);
  });

  it('has no updated_at — a token is issued and spent, never edited', () => {
    const names = columnsOf(PasswordResetToken).map((column) => column.options.name);
    expect(names).toContain('created_at');
    expect(names).not.toContain('updated_at');
  });

  it('finds a token by hash through a unique index', () => {
    const index = indexesOf(PasswordResetToken).find(
      (candidate) => candidate.name === 'password_reset_token_token_hash_key',
    );
    expect(index?.unique).toBe(true);
  });
});

describe('audit_trail — append-only (Doc 10 §1)', () => {
  it('has no updated_at, because there is no update path to stamp', () => {
    const names = columnsOf(AuditTrail).map((column) => column.options.name);
    expect(names).toContain('created_at');
    expect(names).not.toContain('updated_at');
  });

  it('holds no relations — audit outlives what it describes', () => {
    // No foreign keys: deleting a client or a role must neither fail on an
    // audit reference nor rewrite history.
    expect(relationsOf(AuditTrail)).toHaveLength(0);
  });

  it('keeps actor_id and target nullable, and action required', () => {
    expect(columnOf(AuditTrail, 'actorId')?.options.nullable).toBe(true);
    expect(columnOf(AuditTrail, 'targetType')?.options.nullable).toBe(true);
    expect(columnOf(AuditTrail, 'targetId')?.options.nullable).toBe(true);
    expect(columnOf(AuditTrail, 'action')?.options.nullable).toBeFalsy();
  });

  it('carries payload as jsonb', () => {
    expect(columnOf(AuditTrail, 'payload')?.options.type).toBe('jsonb');
  });
});

describe('join tables', () => {
  it.each([
    ['client_application', ClientApplication, ['clientId', 'applicationId']],
    ['role_permission', RolePermission, ['roleId', 'permissionId']],
    ['menu_permission', MenuPermission, ['navNodeId', 'permissionId']],
  ] as const)('keys %s by its pair', (_label, entity, properties) => {
    const primaries = columnsOf(entity)
      .filter((column) => column.options.primary === true)
      .map((column) => column.propertyName);
    expect(primaries).toEqual([...properties]);
  });

  it.each([
    ['role_permission', RolePermission],
    ['menu_permission', MenuPermission],
  ] as const)('gives %s no updated_at — the row is its own key', (_label, entity) => {
    const names = columnsOf(entity).map((column) => column.options.name);
    expect(names).not.toContain('updated_at');
  });

  it('keeps client_application updatable — enabled and config change', () => {
    // Disabling is `enabled = false`, not a delete (Doc 02 §7), so this row
    // does get updated and does need the stamp.
    const names = columnsOf(ClientApplication).map((column) => column.options.name);
    expect(names).toContain('updated_at');
    expect(columnOf(ClientApplication, 'enabled')?.options.default).toBe(true);
  });
});
