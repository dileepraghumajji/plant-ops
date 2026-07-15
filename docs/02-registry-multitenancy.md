# 02 — Registry & Multi-tenancy

> Defines how applications, clients, menus, and permissions are registered and wired at runtime, and how the platform-admin vs client-admin boundary is enforced. No deploy is ever required to onboard a client or launch an application.

---

## 1. The two administrative tiers

| Tier | Who | Governs | Permission namespace |
|---|---|---|---|
| Platform admin | You / super-admin | Applications, permission catalogs, nav catalogs, clients, client→app enablement | `iam.platform.*` |
| Client admin | Each tenant's administrator | Own scope tree, roles, role→permission mapping, users, role bindings | `iam.client.*` |

The tiers are themselves ordinary IAM subjects. Platform admins are `service_account`s or users bound to a special platform scope; client admins are users with `iam.client.*` permissions bound at their client's root scope node. There is no privileged bypass path — the admin console calls the same authorized APIs everyone else does.

## 2. Registering an application (platform admin)

An application is a service like `gatepass`. Registration is a sequence of runtime inserts, no deploy:

```
1. POST /applications                     → create application row
2. POST /applications/:id/permissions     → seed atomic permissions (bulk)
3. POST /applications/:id/nav              → build module/menu/sub_menu tree (bulk)
4. POST /applications/:id/nav-permissions  → map permissions to nav nodes (menu_permission)
```

**Seeding pattern.** Each application ships a **manifest** (a JSON document) enumerating its permissions and nav tree. Registering an app = uploading its manifest. This keeps the catalog declarative and repeatable across environments.

Example manifest shape (illustrative):

```json
{
  "key": "gatepass",
  "name": "Gate Pass",
  "permissions": [
    { "key": "gatepass.dc.create",  "name": "Create DC" },
    { "key": "gatepass.dc.approve", "name": "Approve DC" },
    { "key": "gatepass.gate.verify","name": "Verify at gate" }
  ],
  "nav": [
    { "kind": "module", "key": "gatepass", "label": "Gate Pass", "children": [
      { "kind": "menu", "key": "dc.create", "label": "New DC", "route": "/gatepass/new",
        "requires": ["gatepass.dc.create"] },
      { "kind": "menu", "key": "dc.approvals", "label": "Approvals", "route": "/gatepass/approvals",
        "requires": ["gatepass.dc.approve"] }
    ]}
  ]
}
```

Registering the manifest creates `permission`, `nav_node`, and `menu_permission` rows transactionally. Re-uploading is an **upsert** keyed by `(application, key)` — this is how you evolve an app's catalog over time without deploys.

## 3. Registering a client (platform admin)

```
1. POST /clients                        → create tenant
2. POST /clients/:id/applications        → enable one or more applications (client_application)
3. (optional) create the initial client-admin user + binding
```

Enabling an application for a client makes that app's permissions available for the client's roles. Disabling it (`enabled=false`) hides the app and its permissions from role editing, without deleting existing mappings (they simply become inert until re-enabled).

## 4. Client self-onboarding (client admin)

Once a client exists with apps enabled, its admin operates entirely self-service:

```
1. POST /clients/:id/scopes    → build org tree (Group→Plant→Dept→Gate)
2. POST /clients/:id/roles     → create roles
3. POST /roles/:id/permissions → map permissions (only from enabled apps)
4. POST /users  /  /users/bulk → create or bulk-upload users
5. POST /role-bindings         → bind user + role + scope node
```

At no point does client onboarding touch code or require platform involvement beyond the initial enablement.

## 5. Multi-tenancy isolation model

Isolation is enforced at **three layers**, defense-in-depth:

1. **Row ownership** — every tenant-owned row carries `client_id`.
2. **Request context** — on every authenticated request the kernel sets the Postgres session variable `app.current_client_id` (and `app.current_user_id`) inside the transaction.
3. **RLS** — Row-Level Security policies (Doc 07) restrict every tenant table to `client_id = current_setting('app.current_client_id')`. A bug in service code cannot leak across tenants because the database itself refuses.

Platform-admin operations run with an elevated context that bypasses tenant RLS for registry tables only (applications, nav catalog) — never for tenant data.

## 6. Cross-tenant safety rules

- A role may only map permissions belonging to applications **enabled for that role's client**.
- A role binding's `scope_node` must belong to the **same client** as the role.
- A user may only be bound to roles of **their own client**.
- Platform admins never appear inside a client's role/binding space; their authority is separate.

## 7. Application lifecycle

| Action | Effect |
|---|---|
| Register app | Catalog available for enablement. |
| Enable for client | Client can build roles against it. |
| Disable for client | App hidden; mappings inert, preserved. |
| Deactivate app globally (`is_active=false`) | Hidden everywhere; existing data preserved. |
| Evolve catalog (re-upload manifest) | Upsert permissions/nav; additive changes safe; removals soft-deactivate nodes. |

## 8. What "no deploy" requires of the build

For the registry promise to hold, agents must ensure:

- No permission key is hardcoded in a `switch`/`enum` in application code as the *source of truth* — permissions are data. (Consuming modules may reference known keys as constants, but the IAM never enumerates them in code.)
- Navigation is never a static file — it is always resolved from `nav_node` + `menu_permission` (Doc 05).
- Adding a client, app, menu, role, or permission is always an API call, never a migration.
