# 01 — Data Model

> Defines every entity and mapping table in the IAM. Column lists are authoritative for the core fields shown; agents may add standard audit columns (`created_at`, `updated_at`, `created_by`, `updated_by`) to every table and sensible indexes. All IDs are UUID v4 unless stated. All tables live in the `iam` schema.

---

## 1. Entity overview

Two groups: **registry entities** (the things created at runtime) and **mapping entities** (the wiring between them).

```
REGISTRY                         MAPPING
────────                         ───────
application                      client_application
permission                       role
module / menu / sub_menu         role_permission
client (tenant)                  menu_permission
scope_node (org tree)            role_binding
user                             user_identity (login methods)
service_account                  session
                                 audit_trail
```

## 2. The access equation, as tables

```
WHO      = user | service_account
WHAT     = permission        (via role → role_permission)
WHERE    = scope_node        (via role_binding.scope_node_id)
BINDING  = role_binding(user_id, role_id, scope_node_id)
```

---

## 3. Registry entities

### 3.1 application
A registrable service. The 6 PlantOps apps are rows here; new apps are added at runtime.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| key | text unique | machine key, e.g. `gatepass`, `visitor` |
| name | text | display name |
| description | text | |
| is_active | bool | soft on/off globally |
| config | jsonb | app-level defaults |

### 3.2 permission
Atomic action, owned by an application. Namespaced `app.resource.action`.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| application_id | uuid FK → application | |
| key | text | e.g. `gatepass.dc.approve`; unique per application |
| name | text | human label |
| description | text | |

> Constraint: `unique(application_id, key)`.

### 3.3 module → menu → sub_menu
The navigable tree inside an application. Modeled as **one self-referencing table** `nav_node` to keep depth flexible, with a `kind` discriminator.

**nav_node**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| application_id | uuid FK → application | |
| parent_id | uuid FK → nav_node (nullable) | null = top-level module |
| kind | enum(`module`,`menu`,`sub_menu`) | |
| key | text | unique per application |
| label | text | display text |
| route | text | frontend path (nullable for pure containers) |
| icon | text | |
| sort_order | int | |
| is_active | bool | |
| is_public | bool | default `false`. Leaf-only opt-in: an unmapped leaf is visible to any user who can see the app *only* when this is true. See Doc 05 §3. |

> A **leaf** node is shown to a user only if the user holds a permission mapped to it via `menu_permission` (Doc 05), **or** `is_public = true`. An unmapped leaf with `is_public = false` is hidden (deny-by-default). **Container** nodes (module/menu with children, no route) are visible iff at least one descendant leaf is visible — they are not made visible by `is_public`.

### 3.4 client (tenant)
An industrial group. Root isolation boundary.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| slug | text unique | |
| status | enum(`active`,`suspended`) | |
| config | jsonb | |

### 3.5 scope_node (the org tree — WHERE)
Self-referencing tree per client: Group → Plant → Department → Gate. **The most important table for physical scoping.**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| client_id | uuid FK → client | |
| parent_id | uuid FK → scope_node (nullable) | null = client root/group |
| kind | enum(`group`,`plant`,`department`,`gate`) | extensible |
| name | text | |
| path | ltree | materialized path for fast subtree queries (see label rule below) |
| metadata | jsonb | |

> Store a **materialized path** (`path`) so "does this binding's node cover node X?" is a prefix check, not a recursive walk. Postgres `ltree` is required (coverage is `<@`); a text path is **not** an acceptable substitute.
>
> **Path labels are derived from the node's `id`, never its `name`.** ltree labels are restricted to `[A-Za-z0-9_]` and cannot start with a digit, so a display name like `"Plant B"` or `"Gate-3"` would break or silently mangle the path — and a rename would then rewrite the path and invalidate every cached grant beneath it. Rule: each node's label is `n_` + its UUID with hyphens removed (e.g. `n_9f2c4a1b...`). This is collision-free, rename-stable, and needs no extra column. The human-readable `name` is display-only and never appears in `path`. Illustrative paths in this suite (`group.plantB.gate3`) are for readability only — real paths are `n_<hex>.n_<hex>.n_<hex>`.
>
> A role bound at a plant implicitly covers all departments/gates beneath it.

### 3.6 user
A human identity, belonging to exactly one client.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| client_id | uuid FK → client | |
| email | text | unique **per client** (`unique(client_id, email)`). The same email may exist as a distinct user in multiple clients — this is intended: users are tenant-scoped and login is by `(client_slug, email)` (Doc 03 §3), so there is no global user identity. |
| full_name | text | |
| phone | text | optional (WhatsApp later) |
| status | enum(`active`,`locked`,`disabled`) | `locked` = the "Account Locked Users" concept |
| is_client_admin | bool | shortcut flag; still enforced via permissions |

### 3.7 service_account
A machine identity for module-to-module calls.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| client_id | uuid FK → client (nullable) | null = platform-level |
| name | text | |
| key_hash | text | hashed API key/secret |
| status | enum(`active`,`revoked`) | |

---

## 4. Mapping entities

### 4.1 client_application
Which apps a client has enabled. The per-client on/off switch.

| Column | Type | Notes |
|---|---|---|
| client_id | uuid FK | |
| application_id | uuid FK | |
| enabled | bool | |
| config | jsonb | per-client app config |

> PK: `(client_id, application_id)`.

### 4.2 role
A client-specific named bundle of permissions.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| client_id | uuid FK → client | |
| name | text | unique per client |
| description | text | |
| is_system | bool | seeded defaults vs custom |

### 4.3 role_permission
Role ↔ permission.

| Column | Type | Notes |
|---|---|---|
| role_id | uuid FK → role | |
| permission_id | uuid FK → permission | |

> PK: `(role_id, permission_id)`. A role may only be mapped to permissions of applications enabled for its client (enforced in service layer).

### 4.4 menu_permission
Which permission gates which nav node. Drives dynamic navigation (Doc 05).

| Column | Type | Notes |
|---|---|---|
| nav_node_id | uuid FK → nav_node | |
| permission_id | uuid FK → permission | |

> A nav node may require any of several permissions (OR semantics) — multiple rows.

### 4.5 role_binding (the heart of the system)
Binds a subject to a role at a scope node. This is WHO × (role→WHAT) × WHERE.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| client_id | uuid FK → client | denormalized for RLS |
| user_id | uuid FK → user (nullable) | |
| service_account_id | uuid FK → service_account (nullable) | |
| role_id | uuid FK → role | |
| scope_node_id | uuid FK → scope_node | the WHERE |
| expires_at | timestamptz (nullable) | temporary access |

> Exactly one of `user_id` / `service_account_id` is set (check constraint). A binding at scope node N grants the role's permissions across N and its entire subtree.
>
> **Duplicate prevention:** `unique(coalesce(user_id, service_account_id), role_id, scope_node_id)` (partial/expression unique index) prevents two identical bindings for the same subject+role+node. Binding the same subject+role at both an ancestor and a descendant node is *permitted* and semantically harmless (the ancestor already covers the descendant) — but resolution MUST dedupe covering paths (Doc 04 §4.1) so a redundant descendant path does not appear twice in `scopes[permKey]`.
>
> **Expiry:** `expires_at` is enforced at resolve time (Doc 04 §4.1 filters expired bindings) and does **not** fire a cache-invalidation event on its own — time simply passing cannot trigger a hook. A binding that expires while cached remains effective until the entry's TTL lapses or an unrelated invalidation occurs. Keep the grants cache TTL short enough that this window is acceptable (Doc 04 §6), or run a periodic sweep that invalidates subjects with newly-expired bindings. This is a deliberate, documented staleness bound, not a correctness bug.

### 4.6 user_identity
Login methods for a user (keeps `user` clean; supports future SSO).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → user | |
| provider | enum(`password`,`oidc`,...) | v1: `password` |
| secret_hash | text | password hash (argon2) |
| provider_subject | text | for external providers |

### 4.7 session
Issued token session; revocable.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | = `sid` claim in JWT |
| user_id / service_account_id | uuid | subject |
| client_id | uuid | |
| refresh_token_hash | text | |
| issued_at / expires_at | timestamptz | |
| revoked_at | timestamptz (nullable) | force-logout |
| device_label | text | e.g. "Gate-3 Terminal" |

### 4.8 audit_trail (append-only)
See Doc 10 for full semantics.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| client_id | uuid (nullable) | null = platform action |
| actor_type | enum(`user`,`service_account`,`platform`) | |
| actor_id | uuid | |
| action | text | e.g. `role_binding.created` |
| target_type | text | |
| target_id | uuid | |
| payload | jsonb | before/after where relevant |
| created_at | timestamptz | immutable; no update/delete |

---

## 5. Relationship diagram (textual)

```
client ─┬─ client_application ── application ─┬─ permission
        │                                      └─ nav_node ── menu_permission ── permission
        ├─ scope_node (tree)
        ├─ role ── role_permission ── permission
        ├─ user ── user_identity
        ├─ service_account
        └─ role_binding (user|service_account, role, scope_node)

session, audit_trail reference client + subject.
```

## 6. Key constraints & invariants

1. `role_binding`: exactly one subject (user XOR service_account).
2. `role` and its `role_permission` entries must reference permissions of applications enabled for that client.
3. `permission.key` unique within an application; globally addressed as `application.key + permission.key`.
4. `scope_node.path` maintained on insert/move; subtree coverage is a path-prefix test.
5. `audit_trail` is insert-only and **non-forgeable** — inserts go only through a `SECURITY DEFINER` function that stamps `actor_id`/`client_id` from request context; no UPDATE/DELETE/TRUNCATE privilege for the app role (Doc 07 §6).
6. Every tenant-owned row carries `client_id` for RLS (Doc 07).
7. `role_binding`: `unique(coalesce(user_id, service_account_id), role_id, scope_node_id)` — no duplicate bindings for the same subject+role+node.
8. `scope_node.path` labels are `id`-derived (`n_<uuid-hex>`), never name-derived — see §3.5.
