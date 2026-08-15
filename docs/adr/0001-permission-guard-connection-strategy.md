# ADR 0001 — Which connection `PermissionGuard` resolves grants on

> **Status:** accepted — 2026-08-15
> **Decides for:** roadmap Session 21 (`ResolverService`, grants cache) and Session 23 (`PermissionGuard`, endpoint gating).
> **Supersedes nothing.** Changes no documented behaviour, route, error code or schema — the spec suite (docs 00–10) remains the sole authority. Doc 04 §8 carries a pointer to this file.

ADRs live in `docs/adr/` and are numbered independently of the `00`–`10` spec docs. A spec doc says what the system does; an ADR says why one of several correct-looking ways of building it was chosen, so that the rejected ones are not re-proposed a session later.

---

## 1. Context

`PermissionGuard` (Session 23) answers "does this subject hold this permission at this scope?" before the handler runs. Its data path is:

1. Read the subject's resolved grants from the Redis grants cache (Doc 04 §6).
2. **On a miss, run `ResolverService.resolve()` against Postgres and populate** (Doc 04 §6, last line).

Step 2 is the whole difficulty. It is easy to read the cache as the normal case and the miss as an exception, but misses are routine and mostly not the subject's fault:

- every deploy or Redis restart empties the cache;
- every version bump from Session 22's invalidation table — a binding created, a role's permissions edited, a scope node moved, an application toggled — invalidates the entry deliberately;
- the ≤10-minute TTL (Doc 04 §6) expires it anyway.

So the guard reaches Postgres often enough that "how it gets there" is a design decision, not an edge case.

Meanwhile, every service in `apps/iam-api` reads the database through `entityManager()` — the ambient request transaction held in an `AsyncLocalStorage` (`common/transaction-context.ts`). That function **throws** rather than falling back to the global `DataSource`, on purpose: the RLS context is set with `set_config(..., true)`, which is transaction-local, so a query on any other connection runs with no tenant context (Doc 07 §5).

`TenantContextInterceptor` opens that transaction. Nest runs **guards before interceptors**. Therefore, at guard time:

- there is no ambient transaction, so `entityManager()` throws; and
- there is no RLS context, so any query the guard makes on a pooled connection sees an unset `app.current_client_id` and matches nothing.

Four files state this correctly today and each promises that Session 23 replaces the interim check with `@RequirePermission(...)`:

- `apps/iam-api/src/common/platform-admin.ts`
- `apps/iam-api/src/common/administrator.ts`
- `apps/iam-api/src/roles/roles.controller.ts`
- `apps/iam-api/src/roles/roles.service.ts`

The promise is sound in intent and unimplementable as worded: if Session 21 writes `resolve()` against `entityManager()` — the convention it would otherwise be right to follow — Session 23 cannot call it, and Session 21's work is reworked inside Session 23. That is why this decision is taken **before** Session 21 rather than discovered during Session 23.

## 2. Decision

**`ResolverService.resolve()` takes an explicit `EntityManager` parameter. It never calls `entityManager()`.**

```ts
resolve(manager: EntityManager, subject: SubjectRef, options?: ResolveOptions): Promise<ResolvedGrants>
```

Two callers, two connections, one implementation:

| Caller | Connection | Why |
|---|---|---|
| Request handlers (`/iam/permissions/resolve`, `/permissions/check`, `/introspect`) | `entityManager()` — the request transaction | Resolution joins the caller's own transaction and sees its uncommitted writes, exactly as today. |
| `PermissionGuard` (cache miss) | its own `QueryRunner`, with `applyRlsContext` applied from the verified claims, released in `finally` | There is no request transaction yet, and the guard must not create one it cannot close. |

The guard's shape is **`AuditService.recordDenial`'s shape**, already in the codebase and already proven for the same reason — work that must precede or survive the request transaction:

```
createQueryRunner → connect → startTransaction → applyRlsContext(runner.manager, claims)
                  → resolve(runner.manager, …) → commit → release   (release in `finally`)
```

`applyRlsContext` requires a transaction (its `set_config` is transaction-local); the guard's transaction is read-only in effect and short-lived, and it is committed and released before the handler's own transaction is opened by the interceptor — so the two never overlap and the guard holds no connection across handler execution.

Session 23's denial-audit half needs no further decision: `AuditService.recordDenial` is written, is narrowed to the two `authz.*` actions, and already commits on its own connection for the same reason the guard now resolves on one.

## 3. Options considered and rejected

### Option B — open the request transaction in the guard instead of the interceptor

Rejected. **A guard has no "after" phase.** `canActivate` returns a boolean (or throws); it is not wrapped around handler execution the way an interceptor is. So a transaction opened in a guard has to be committed or rolled back somewhere else, and ownership splits:

- a request rejected between the guard and the interceptor — by a later guard, by `ZodValidationPipe`, by a `@RequirePermission` on a second guard — leaks the `QueryRunner`, and pool exhaustion is the failure mode;
- `TenantContextInterceptor`'s rollback path stops seeing every failure, which is the one property that makes "a rolled-back business transaction leaves no audit row" true (`audit.service.ts`);
- the retry loop for serialization failures (`@Transactional({ retries })`) re-runs the handler on a *fresh* transaction. A transaction opened upstream of the retry cannot be discarded by it.

The interceptor must keep owning the request transaction. This option is not a trade-off, it is a defect.

### Option C — resolve inside a `SECURITY DEFINER` function

Not chosen, but legitimate, and the closest to the grain of this codebase: migrations 0010 and 0012–0015 already put `write_audit`, login and refresh behind definer functions precisely because they must run without an RLS context. A definer `iam.resolve_grants(subject_type, subject_id, client_id)` derives everything from its arguments, so the guard could call it on any pooled connection with no context set-up at all — the cheapest possible cache-miss path.

Rejected for now because `resolve()` is not a lookup. It carries ltree path minimisation (dropping a descendant path when an ancestor is present), expiry filtering, and the `applicationId` slice — the algorithm of Doc 04 §4, and the part of the system with the largest correctness surface. Moving it into PL/pgSQL trades the exhaustive unit-test matrix Session 21 is scoped to produce (≥15 cases, Doc 04) for connection-independence we can get more cheaply from Option A.

**Revisit C if, and only if,** the guard's per-request latency budget makes Option A's extra `connect → BEGIN → applyRlsContext` round-trips unaffordable on the cache-miss path. Note that `applyRlsContext` itself costs one indexed existence check (the platform-admin derivation), which Doc 04 §6 already contemplates caching alongside grants.

### Option D — resolve from the token alone, with no database access

Rejected outright, recorded because it is the tempting shortcut. Grants are not in the token: Doc 03 keeps the access token small and Doc 04 §7 makes grant changes take effect immediately via invalidation, never via token expiry. Putting grants in the token would make every binding change wait out the token lifetime — the exact failure Doc 04 §7 exists to prevent.

## 4. Consequences

**Wanted:**

- Session 21 can be built without an open question about which connection it runs on, and Session 23 consumes it unchanged.
- `resolve()` becomes directly testable against any manager — a transaction, a runner, a test fixture — because it no longer reaches into ambient state.
- The guard's connection handling has a precedent in the same repository rather than being novel, and both places can be read against each other.

**Accepted costs:**

- `resolve()` breaks the `entityManager()` convention every other service follows. This is a deliberate, documented exception and needs to be stated in the file's own header, or the next author will "fix" it back.
- A cache miss inside the guard costs one extra connection acquisition plus `applyRlsContext` before the request's own transaction opens. Bounded by the miss rate, which Session 22's invalidation is designed to keep low.
- Two connections are briefly in play per cache-missing request (the guard's, then the handler's — sequentially, never nested). Pool sizing should account for the guard's, and it must be released in a `finally`.

## 5. What this obliges each session to do

**Session 21 (`ResolverService`, grants cache)**

- `resolve()` takes an `EntityManager` as its first parameter and does not call `entityManager()`.
- The header of `resolver.service.ts` states why, and points here.
- The HTTP endpoints (`/permissions/resolve`, `/check`, `/introspect`) pass `entityManager()`, so their behaviour inside the request transaction is unchanged.
- `GrantsCacheService` is likewise callable outside a request transaction (it talks to Redis, not Postgres, so this is a matter of not acquiring one incidentally).

**Session 23 (`PermissionGuard`)**

- On a cache miss the guard opens its own `QueryRunner`, applies `applyRlsContext` from the verified claims, calls `resolve(runner.manager, …)`, commits and releases in a `finally`.
- It does **not** open, reuse, or leave open the request transaction; `TenantContextInterceptor` remains the sole owner.
- Denials go through `AuditService.recordDenial`, which already commits on its own connection.
- Replacing `assertPlatformAdmin()` / `assertAdministrator()` deletes `common/platform-admin.ts` and `common/administrator.ts`; the endpoints and their status codes do not move.
