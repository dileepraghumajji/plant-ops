# 09 — Admin UI Spec

> The two Next.js admin consoles at domain level: what each screen is for and the key interactions. Not pixel specs — the frontend-design skill and your design language govern visuals. Both consoles are one Next.js app (`admin-web`) gated by permission tier.

---

## 1. Two consoles, one app

`admin-web` renders one of two experiences based on the signed-in subject's permissions:

- **Platform console** (`iam.platform.*`) — manage the catalog and tenants.
- **Client console** (`iam.client.*`) — a tenant admin manages their own users, roles, scopes, bindings.

The shell, auth, and navigation are shared; the menu itself is **dynamic** (Doc 05) — the console reads `/iam/navigation` and renders what the subject may see. (The admin console is itself an application in the registry, dogfooding the nav system.)

---

## 2. Platform console

### 2.1 Applications
- **List** applications (key, name, active).
- **Register application** — form or **manifest upload** (JSON, Doc 02 §2). Manifest upload is the primary path: paste/upload → preview diff (new/changed permissions & nav) → confirm upsert.
- **Application detail** — three tabs:
  - *Permissions* — table of atomic permissions; add/edit.
  - *Navigation* — tree editor for module/menu/sub-menu (add node, set route/icon/sort).
  - *Menu permissions* — map permission(s) to each nav node (the gate).
- Activate/deactivate application.

### 2.2 Clients
- **List** clients (name, status, # enabled apps).
- **Create client** — name, slug.
- **Client detail**:
  - *Applications* — toggle which apps this client may use (client_application).
  - *Admins* — create the initial client-admin user (triggers a binding at the client root scope).
  - Suspend/reactivate.

### 2.3 Platform audit
- Global audit view (all clients), filterable by actor/action/target/date (Doc 10).

### 2.4 Service accounts (platform-level)
- Create/rotate/revoke platform service accounts; secret shown once.

---

## 3. Client console

The tenant admin's world. Everything scoped to their client automatically (RLS + JWT).

### 3.1 Scope tree (Org structure)
- **Tree editor** for Group → Plant → Department → Gate.
- Add child node (choose kind), rename, move (drag or menu), delete (blocked if bindings exist, with a clear message).
- This is the WHERE dimension made visible — emphasize it in the UI as "where access applies."

### 3.2 Roles
- **List** roles (name, # permissions, # users bound).
- **Create/edit role** — name + **permission picker** grouped by application (only apps enabled for the client appear). Multi-select, searchable.
- Delete role (warns about affected bindings).

### 3.3 Users
- **List/search** users; filter by status (active / **locked** / disabled). The locked filter is the "Account Locked Users" screen.
- **Create user** — email, name, phone, initial status.
- **User detail** — profile; **bindings** sub-panel (roles + scope nodes); lock/unlock/disable; reset password.
- **Bulk upload** — CSV/JSON; show a **per-row result report** (created / skipped / errored with reason). ("Bulk User Upload".)
- **Users by Role** — pick a role → list users holding it. ("Users by Role".)

### 3.4 Role bindings (the key screen)
- **Assign access**: pick user (or service account) → pick role → pick scope node → optional expiry. This single action is WHO × role(WHAT) × WHERE.
- Bindings list, filterable by user/role/scope; unbind.
- Make the scope picker a tree selector so the admin sees exactly where they're granting.

### 3.5 Service accounts (client-level)
- Create/rotate/revoke machine identities used by the client's integrations; bind them to roles+scopes like users.

### 3.6 Client audit
- Audit view scoped to the client (grants, logins, lock/unlock, binding changes).

---

## 4. Cross-cutting UI behaviors

- **Dynamic nav** — never hardcode the sidebar; render from `/iam/navigation`.
- **Permission-aware controls** — buttons/actions the subject lacks permission for are hidden/disabled (UX only; server enforces).
- **Optimistic invalidation feedback** — after a role/binding change, surface that access updates may take a few seconds (cache invalidation, Doc 04 §7).
- **Manifest diff preview** — registering/updating an app always previews the change before committing.
- **Scope-first mental model** — wherever access is granted, the scope node is shown prominently; never let an admin grant a role without choosing where.

## 5. Mapping to the reference screenshot

Every item in the reference menu has a home here, now correctly organized:

| Reference item | Where it lives now |
|---|---|
| Applications, Modules, Menu, Sub-Menu | Platform → Applications → Navigation tab |
| Permissions, Scopes | Platform → Applications (permissions); Scopes reframed as the client Scope Tree (WHERE) |
| Client, Client-Application | Platform → Clients / Applications toggle |
| Account Locked Users | Client → Users (locked filter) |
| Units | Client → Scope Tree (Plant kind) |
| Roles, User, Bulk User Upload, Users by Role, User Role Mapping, Role Permissions | Client → Roles / Users / Bindings |
| Mapping (ambiguous) | Superseded by explicit Role bindings + Menu permissions |

The important change: **Scopes/Units become a first-class org tree**, and **User Role Mapping becomes scope-aware role binding**.
