# 10 — Audit & Governance

> The append-only audit trail, what must be logged, how it stays immutable, and retention. In a system governing physical access to plants, goods, and security patrols, audit is a compliance requirement, not a nicety.

---

## 1. Principles

1. **Append-only.** Records are inserted, never updated or deleted. Enforced at the DB layer (Doc 07 §6): no UPDATE/DELETE grants, no RLS update/delete policies.
2. **Complete.** Every security-relevant action writes a record — registrations, mappings, grants, logins, revocations, denials.
3. **Attributable.** Every record names the actor (user / service account / platform), the target, and the change.
4. **Queryable.** Filterable by actor, action, target, client, and time (Doc 06 §12).

## 2. Record shape

(See `audit_trail`, Doc 01 §4.8.)

```
{ id, client_id?, actor_type, actor_id, action, target_type, target_id, payload, created_at }
```

- `action` is a dotted verb string (see catalog §4).
- `payload` (jsonb) holds context: for mutations, a compact `before`/`after` or the salient fields; for auth, the reason code and device label; never secrets or password material.
- `client_id` null ⇒ platform-level action.

## 3. Who writes audit records

The **service layer** writes them, in the **same transaction** as the change, so a committed change always has its audit record (no drift). A NestJS interceptor or an explicit `AuditService.record(...)` call at each mutation point. For denials (403), a lightweight guard-level writer records the attempt (these may be outside a business transaction — best-effort but should not be silently dropped).

## 4. Action catalog (minimum)

**Auth** (Doc 03 §9):
`auth.login.success`, `auth.login.failed`, `auth.logout`, `auth.refresh.rotated`, `auth.refresh.reuse_detected`, `auth.session.revoked`, `auth.password.reset_requested`, `auth.password.reset_completed`, `auth.account.locked`, `auth.account.unlocked`.

**Registry (platform):**
`application.created`, `application.updated`, `application.manifest.upserted`, `application.deactivated`, `permission.created`, `nav.node.created/updated/deactivated`, `menu_permission.mapped/unmapped`, `client.created`, `client.suspended`, `client_application.enabled/disabled`.

**Tenant admin:**
`scope_node.created/moved/renamed/deleted`, `role.created/updated/deleted`, `role_permission.set`, `user.created/updated`, `user.locked/unlocked/disabled`, `user.bulk_uploaded`, `role_binding.created/deleted/expired`, `service_account.created/rotated/revoked`.

**Authorization:**
`authz.permission_denied`, `authz.scope_denied` (with the attempted permission + target scope in payload).

**Bootstrap:** `platform.bootstrap`.

## 5. Immutability enforcement

- No UPDATE/DELETE on `audit_trail` for the application role (Doc 07 §6).
- Optionally add a **hash chain** for tamper-evidence: each row stores `prev_hash` and `row_hash = H(prev_hash || canonical(row))`. A break in the chain reveals tampering. Recommended if a customer has strict compliance needs; optional otherwise.
- Backups of the audit table are treated as records of record.

## 6. Retention

- Default retention: **indefinite** for access-control events, or a client-configurable minimum (e.g. ≥ 1–2 years) driven by the customer's compliance regime.
- If archival is needed, move older records to cold storage (never delete in place); keep the chain intact across the boundary.
- Retention policy is documented per client and itself audited when changed.

## 7. Access to audit

- **Client admins** read their own client's audit (`iam.client.audit.read`), RLS-scoped.
- **Platform admins** read all audit (`iam.platform.audit.read`).
- Audit is **read-only** through the API — there is no mutate/delete endpoint by design.
- Exports (CSV) are themselves audited (`audit.exported`).

## 8. What must never be logged

- Passwords, password hashes, refresh tokens, service-account secrets, JWT signing keys.
- Full PII beyond what's necessary to attribute the action.
- Redact/omit these at the `AuditService` boundary so they cannot reach `payload`.

## 9. Governance beyond audit (roadmap hooks)

The schema already supports these; implement when needed:
- **Temporary access** via `role_binding.expires_at` (a scheduled job expires bindings and audits `role_binding.expired`).
- **Access reviews** — periodic report of "who has what, where" derived from bindings, for admin attestation.
- **Delegation / approval of access requests** — a request→approve flow before a binding is created (reuses the future kernel ApprovalEngine; out of scope for IAM v1 but the binding endpoint is the natural completion point).

## 10. Why this matters for PlantOps

The operational modules that come later govern **physical** events — a person entering a plant, goods leaving a gate, a patrol round completed. The authorization behind those events must be provable after the fact: who could approve that gatepass, who granted them that power, and when. This audit design makes every such question answerable from an immutable record.
