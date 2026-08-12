# Changelog — Validation Fixes (Principal Architect Review)

All 15 findings from the doc-suite validation, applied. Each entry: finding → severity → doc(s)/section touched → what changed. Design decisions taken: **UUID-derived ltree paths**, **RLS split (role_permission = tenant RLS; menu_permission = catalog)**, **SECURITY DEFINER audit inserts**.

---

## High severity (correctness / security holes)

**1. RLS context provenance not stated as an invariant**
Doc 00 §5 (new Invariant I0) · Doc 07 §5 (new PROVENANCE rule).
Added the hard rule: `app.current_client_id` / `app.current_user_id` / `app.is_platform_admin` are sourced **only** from the verified JWT, never from request body/header/param/path. Structural enforcement + lint gate mandated.

**2. Join-table RLS (`role_permission`, `menu_permission`) hand-waved**
Doc 07 §6.
Replaced "apply the same shape" shorthand with explicit policy SQL. **Decision:** `role_permission` gets real tenant RLS via an indexed `exists` subquery to `role.client_id`; `menu_permission` is catalog (platform-write, globally readable), documented as a deliberate split. Closes an I5 leak.

**3. Scope-move vs. resolution concurrency unaddressed**
Doc 04 new §7.1 · Doc 07 §7.
Mandated ordering: capture affected subjects → `BEGIN` REPEATABLE READ (SERIALIZABLE under contention) → single-statement subtree path rewrite → COMMIT → **then** invalidate. Never invalidate pre-commit. Uncertainty falls to deny.

**4. Materialized-path label correctness trap (labels from name)**
Doc 01 §3.5 · Doc 07 §7 · Doc 04 §3 (path examples flagged illustrative).
**Decision:** path labels are `n_<uuid-hex>`, id-derived, ltree-legal, rename-stable. Display `name` never appears in `path`. Only reparent (move) changes paths; rename does not.

**7. Audit forgeable + TRUNCATE gap**
Doc 07 §6 · Doc 01 §6 (invariant 5 updated).
**Decision:** audit writes go only through `iam.write_audit(...)` SECURITY DEFINER function that stamps `actor_id`/`client_id`/`actor_type` from session context. App role loses direct INSERT; UPDATE/DELETE/**TRUNCATE** revoked. `with check (true)` removed. Redaction rule for `payload` added.

---

## Medium severity

**6. Auth gaps (Doc 03)**
- JWKS rotation: publish-new-before-signing overlap window, retain old key ≥ max token lifetime, `kid`-based selection. (§1)
- Clock skew: 60 s leeway on exp/iat/nbf, shared via libs/config. (§6)
- Refresh reuse-detection race: 10–30 s grace window returning idempotent successor; real reuse still revokes. (§4)
- Service-account revocation: ephemeral `sid`, documented as deliberate; bounded by ≤5 min TTL + status-flip on next exchange; session-backed option noted. (§5)

**8. Cache-invalidation completeness (Doc 04 §7)**
Added: service_account revoked; client_application **re-enabled** (not just disabled); permission soft-deactivated via manifest re-upload; explicit note that `expires_at` fires **no** event (TTL/sweep bound).

---

## Smaller issues

- **Email per-client** — Doc 01 §3.6: clarified same email may exist across clients by design; login by `(client_slug, email)`.
- **`/permissions/resolve` payload bound** — Doc 06 §11: path minimization + optional `?applicationId=` filter; unbounded-binding smell noted.
- **Unmapped-leaf footgun** — Doc 05 §3 + Doc 01 §3.3: inverted default. Unmapped leaf now **hidden**; new `nav_node.is_public` flag required to expose. Resolution algorithm (Doc 05 §5) updated.
- **Nx `libs/db` isolation mechanism** — Doc 08 §2: concrete `depConstraints` via `app:iam-api` tag + allow-list-only strategy; lint-fail test mandated (§7).
- **Duplicate/overlapping bindings** — Doc 01 §4.5 + §6: `unique(coalesce(user_id,service_account_id), role_id, scope_node_id)`; ancestor+descendant permitted but resolve must dedupe (Doc 04 §4.1 path minimization added).

---

## New schema additions introduced by these fixes (flag for agents — NOT pre-existing)

1. `nav_node.is_public boolean default false` — Doc 01 §3.3 / Doc 05 §3.
2. `role_binding` expression unique index on `(coalesce(user_id, service_account_id), role_id, scope_node_id)` — Doc 01 §4.5.
3. `session`: previous-refresh-hash + rotation timestamp columns for the reuse grace window — Doc 03 §4.
4. `iam.write_audit(...)` SECURITY DEFINER function + owner role — Doc 07 §6.
5. Shared clock-skew constant in `libs/config` — Doc 03 §6.

## Invariant delta (Doc 00)

- **New I0**: tenant context is JWT-sourced only. (Renumbering: previous I1–I7 unaffected in text; I0 prepended to the governance list.)

## Not changed (deliberately)

- Core access model, resolve/point-check split, registry-as-data, IAM-as-authority, three-layer isolation — all validated sound, untouched.

---

## Post-implementation findings

Findings raised while building, not part of the original 15-finding review. Same format.

**16. Ownership bypass — Doc 07 §5's startup assertion was necessary but not sufficient**
*High severity.* Doc 07 §2 (role split note) · Doc 07 new §5.1 · Roadmap Session 5 (startup check scope).
Found during Session 5 setup, before any policy was written. §5 required the app's connection role to be non-superuser and non-BYPASSRLS. A **table's owner is also exempt from its own policies**, independent of both — `enable row level security` does not apply to the owner. Measured on PostgreSQL 17.6 with a two-tenant fixture and the context set to one tenant: connected as the table owner, an `enable`-only table returned **both** tenants' rows while `rolsuper` and `rolbypassrls` were both false — i.e. §5's assertion passed with isolation fully inert. The failure mode is what makes it high severity: an isolation suite executed under the owning role goes green with every policy disabled, so its output is not evidence.

**Decision (applies to every environment, local and hosted):** two roles, split by function — an *owner* role that owns schema `iam`, all tables and `iam.write_audit` and is used **only** by migrations (`DATABASE_DIRECT_URL`), and an *app* role that owns nothing and serves every request (`DATABASE_URL`), holding `usage` + DML + `execute` on the audit function. On Supabase the built-in `postgres` role is unsuitable as either — it is privileged and would own everything migrations create; it is used once to create the two roles and never appears in a connection string again. `DATABASE_URL` vs `DATABASE_DIRECT_URL` therefore differ by **role as well as endpoint**; the endpoint split alone protects nothing. Additionally every RLS-enabled table gets `force row level security`, with `audit_trail` deliberately exempt so the `SECURITY DEFINER` writer can still insert via the owner path (the app role is blocked there by privilege, not policy). Consequence for migrations: a seed writing into a forced table runs as owner and *is* subject to policy, so it must set the §5 session context itself.

**Startup check widened** from two assertions to three: not superuser, not `BYPASSRLS`, and **owns no table in `iam`**.

## New schema additions introduced by post-implementation findings

6. Two database roles per environment (owner + app) with the grant split above — Doc 07 §5.1. Not a schema object, but a deployment precondition: the RLS suite is meaningless without it.
