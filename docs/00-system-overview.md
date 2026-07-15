# 00 — System Overview & Principles

> **Product:** PlantOps IAM — a standalone, multi-tenant Identity & Access Management service.
> **Audience:** Coding agents building this system, and the human directing them.
> **Style:** This document defines *what* and *why*. It does not prescribe line-by-line implementation. Where a concrete shape is given (a table, an algorithm, a contract), treat it as authoritative; everything else is the agent's judgment within these boundaries.

---

## 1. What this is

PlantOps IAM is the identity and authorization authority for a family of manufacturing non-core operations applications (visitor management, meeting-room booking, vehicle requisition, security patrol, gatepass). It is built **first and standalone**, before any operational module, because every module depends on it.

It is not merely an RBAC library. It is a **self-service registry**: applications, clients (tenants), menus, and permissions are all runtime data created through an admin UI. Onboarding a new client, launching a new application, or adding a new menu or permission requires **no code change and no deploy** — only inserting and wiring rows.

## 2. The three-dimensional access principle

Every authorization decision answers three orthogonal questions:

```
Effective access = WHO × WHAT × WHERE
```

- **WHO** — a human `user` or a machine `service_account`.
- **WHAT** — an atomic `permission` (e.g. `gatepass.dc.approve`), registered against an application.
- **WHERE** — a `scope node` in the client's physical/organizational tree (Group → Plant → Department → Gate).

A security guard does not simply have "patrol permission." They have `patrol.round.execute` **at Gate 3 of Plant B**. This WHERE dimension is first-class and is the single most important design property of the system. It is modeled explicitly (see Doc 01) so that physical scoping falls out naturally rather than being bolted on later.

## 3. Registry principle — everything is data

| Thing | Created at runtime by | Requires deploy? |
|---|---|---|
| Application (a service) | Platform admin | No |
| Permission | Platform admin (per app) | No |
| Module / Menu / Sub-menu | Platform admin (per app) | No |
| Client (tenant) | Platform admin | No |
| Client's enabled apps | Platform admin | No |
| Scope tree (plants/gates) | Client admin | No |
| Role | Client admin | No |
| Role → Permission mapping | Client admin | No |
| User + bulk upload | Client admin | No |
| Role binding (user+role+scope) | Client admin | No |

If any of the above needs a code change to add a new instance, the design has failed.

## 4. Two administrative tiers

- **Platform admin** (you / super-admin): registers applications and their permission/menu catalogs; registers clients; toggles which applications each client may use.
- **Client admin** (each tenant's administrator): builds their own scope tree, creates roles, maps permissions to roles, uploads users, binds users to roles at scope nodes.

The boundary between these tiers is itself enforced by permissions (`iam.platform.*` vs `iam.client.*`).

## 5. Non-negotiable governance properties

0. **Tenant context is JWT-sourced only** — the request's tenant (`client_id`) and subject are set *exclusively* from the verified JWT claims (`cid`, `sub`), never from a request body, header, query param, or path. RLS depends on this; a single code path that trusts a request-supplied `client_id` collapses tenant isolation silently. See Doc 07 §5.
1. **Append-only audit trail** — every registration, mapping, grant, login, and revocation is recorded immutably.
2. **Service accounts** — module-to-module calls use machine identities, not human users.
3. **Session revocation** — tokens are revocable (force-logout), important for shared gate-terminal devices.
4. **Cached resolution with invalidation** — permission and navigation resolution is Redis-cached and invalidated on any mapping change.

## 6. Stack decisions (and their consequences)

| Choice | Decision | Consequence |
|---|---|---|
| Backend | NestJS | Modular structure; guards/decorators for authz. |
| Database host | Supabase | Used as **plain managed Postgres**, not via Supabase SDK/Auth. |
| ORM | TypeORM | Owns entities and migrations. RLS policies are **hand-written SQL** in migrations. |
| Frontend | Next.js | Two admin consoles (platform + client). |
| Repo | **Nx monorepo** | Shared contracts, guards, entities in `libs/`; atomic cross-cutting changes. |
| Cache/queue | Redis (+ BullMQ later) | Permission/nav cache; queues arrive with operational modules. |

**Important:** Because we build our own IAM, we deliberately **do not use Supabase Auth**. Supabase is only the Postgres host. TypeORM connects via the connection string and owns the schema. Row-Level Security is written by hand in migrations (see Doc 07).

## 7. Why Nx monorepo

The IAM emits contracts (JWT claim shape, permission keys, the `/permissions/resolve` and `/navigation` response types, guard decorators) that every future module consumes. Separate repos would turn every contract change into a publish-and-version dance. A monorepo lets the IAM API, shared types, NestJS guards, and Next.js admin console import from one `libs/` folder and change together atomically. Nx enforces module boundaries via lint rules, giving separation of concerns without separation of repositories. Extraction to a separate repo later (if a module spins out) remains straightforward.

## 8. Document map

| Doc | Title | Purpose |
|---|---|---|
| 00 | System Overview & Principles | This document. |
| 01 | Data Model | Every entity, mapping table, the scope tree. |
| 02 | Registry & Multi-tenancy | Runtime registration; admin tier boundary. |
| 03 | Authentication | Login, JWT, refresh, sessions, service accounts. |
| 04 | Authorization & Scope Resolution | Permission model, resolution algorithm, caching. |
| 05 | Dynamic Navigation | menu_permission, nav resolution endpoint. |
| 06 | API Surface | All endpoints, contracts, error model. |
| 07 | Database & RLS | TypeORM + Supabase, migrations, hand-written RLS. |
| 08 | Nx Workspace & Structure | Layout, lib boundaries, build/deploy. |
| 09 | Admin UI Spec | Two consoles, screen by screen (domain level). |
| 10 | Audit & Governance | Append-only trail, what's logged, retention. |

## 9. Scope of this suite

This suite covers **IAM/RBAC only**. The shared kernel (approval engine, notifications, file service) and the six operational modules are explicitly out of scope and will be specified separately once the IAM is built and proven.
