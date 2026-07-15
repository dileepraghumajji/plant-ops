# 04 — Authorization & Scope Resolution

> The core of the system. Defines the permission model, the WHO×WHAT×WHERE resolution algorithm, subtree scope coverage, Redis caching, and invalidation. This is where the physical-scope dimension earns its keep.

---

## 1. The authorization question

For any request, the system must answer:

> Does **subject S** (in client C) hold **permission P** at **scope node N** (or an ancestor of N)?

All three parts are required. Holding `patrol.round.execute` globally is meaningless; the subject must hold it at a scope node that **covers** the gate in question.

## 2. Permission model recap

- Permissions are atomic, namespaced `app.resource.action`, owned by an application (Doc 01 §3.2).
- Subjects never hold permissions directly. They hold **roles** (via `role_binding`), and roles hold permissions (via `role_permission`).
- A `role_binding` attaches `(subject, role, scope_node)`.

So a subject's effective grants are the union, over all their bindings, of:

```
{ (permission, scope_node) : role_binding(subject, role, scope_node)
                              ∧ role_permission(role, permission) }
```

## 3. Scope coverage (the WHERE test)

A binding at scope node `N_b` covers a target node `N_t` iff `N_b` is `N_t` or an **ancestor** of `N_t` in the client's scope tree.

Because `scope_node` stores a **materialized path** (`path`, e.g. `ltree` `group.plantB.gate3`), coverage is a **prefix test**:

```
covers(N_b, N_t) ⇔ N_t.path <@ N_b.path      (N_t is within N_b's subtree)
```

A role bound at `Plant B` (`group.plantB`) covers `Gate 3` (`group.plantB.gate3`) and every other node beneath Plant B — automatically, with no extra rows.

## 4. The resolution algorithm

Two shapes of the same computation:

### 4.1 Full resolve (for caching / `/permissions/resolve`)
Produce the subject's complete grant set as `permission → set of covered scope subtrees`:

```
resolve(subject, client):
  bindings ← role_binding where subject matches and client=client and not expired
  grants ← {}
  for b in bindings:
     node ← scope_node(b.scope_node_id)          # gives node.path
     perms ← permissions of b.role_id            # via role_permission
     for p in perms:
        grants[p.key].add(node.path)             # store the covering subtree root path
  return {
    permissions: keys(grants),                   # flat list for quick "has permission" checks
    scopes: grants                               # permission → [covering paths]
  }
```

> **Path deduplication & minimization (required).** `grants[p.key]` is a **set**, and before caching it MUST be reduced to a minimal covering set: if it contains both an ancestor path and a descendant path for the same permission, drop the descendant (the ancestor already covers it via `<@`). This keeps `scopes` compact, makes the point check (§4.2) cheaper, and prevents redundant covering paths when a subject is bound to the same role at both an ancestor and a descendant node (Doc 01 §4.5). Minimization: for each candidate path, keep it only if no *other* path in the set is a proper ancestor of it.
>
> Expired bindings are excluded by the `not expired` filter on `bindings` above; a binding whose `expires_at` has passed contributes nothing to grants (see the expiry staleness bound in Doc 01 §4.5 and §7 below).

### 4.2 Point check (for a specific action at a specific node)
```
can(subject, client, permissionKey, targetNodeId):
  g ← resolve(subject, client)          # from cache
  if permissionKey ∉ g.permissions: return false
  targetPath ← scope_node(targetNodeId).path
  return ∃ coveringPath ∈ g.scopes[permissionKey] : targetPath is within coveringPath
```

The point check is what `PermissionGuard` + `ScopeResolver` run per request (Doc 08 / kernel). It is O(number of covering paths for that permission), typically tiny.

## 5. Query narrowing (the practical payoff)

Beyond yes/no checks, operational modules need **list** endpoints filtered by scope: "show visitors at gates this guard covers." The resolver exposes the set of covered node paths for a permission so modules can add a filter:

```
allowedPaths ← resolve(subject).scopes["visitor.read"]
WHERE visitor.gate_path <@ ANY(allowedPaths)
```

This is why storing scope as a path (not just an id) matters — it turns authorization into a cheap SQL predicate.

## 6. Caching

Resolution is read-heavy and changes rarely. Cache the **full resolve** result in Redis:

```
Key:   perms:{clientId}:{subjectType}:{subjectId}
Value: { permissions: [...], scopes: { permKey: [paths...] }, v: <epoch> }
TTL:   e.g. 10 min (safety net; primary freshness is invalidation)
```

The `AuthGuard`/`PermissionGuard` reads this on each request. On cache miss, run `resolve()` against Postgres and populate.

## 7. Invalidation (correctness over TTL)

Any change that could alter a subject's grants must invalidate the relevant cache entries **immediately**:

| Change | Invalidate |
|---|---|
| role_binding created/updated/deleted/expired | that subject |
| role_permission changed | all subjects bound to that role |
| role deleted | all subjects bound to that role |
| scope_node moved/renamed (path change) | all subjects with bindings in that subtree (see §7.1 for ordering) |
| user locked/disabled | that subject (+ revoke sessions) |
| service_account revoked | that subject |
| client_application disabled **or re-enabled** | subjects of that client (disabling makes the app's permissions inert; re-enabling restores them — both change effective grants) |
| permission soft-deactivated / removed via manifest re-upload (Doc 02 §7) | all subjects bound to any role mapping that permission (cached grants may still reference a now-inert permission key) |
| role_binding `expires_at` reached | **no event fires** — time passing is not a hook. Bounded by grants-cache TTL (§6) or a periodic expiry sweep that invalidates affected subjects (Doc 01 §4.5) |

Mechanism: the IAM publishes a `perms.invalidated { clientId, subjectId? , roleId? }` event (Redis pub/sub or an outbox). Cache holders delete matching keys. For role-level invalidation, either fan out to affected subjects (look them up) or bump a per-role version that resolution checks.

**Recommended simple approach:** maintain a `version` counter per `(client, subject)`; store it in the cache value and in Redis; increment on any relevant change; treat mismatched versions as a miss. Avoids enumerating subjects on role changes.

### 7.1 Scope-node move — transactional ordering (the highest-risk concurrency case)

A `scope_node` move rewrites the `path` of the node **and its entire subtree** (Doc 07 §7) *and* must invalidate every subject with a binding in that subtree. If the path rewrite and the cache invalidation are not correctly ordered and isolated, a subject can be transiently over- or under-privileged: a resolve running mid-rewrite may cache a covering path that no longer exists, and coverage tests against the new tree then silently fail or succeed wrongly until TTL.

Mandatory rules:

1. **Atomic rewrite.** The subtree `path` update is a *single* SQL statement (Doc 07 §7's `subpath`-based bulk update) inside one transaction — never a row-by-row walk. The whole subtree moves or none of it does.
2. **Isolation.** Run the move transaction at **`REPEATABLE READ`** (or `SERIALIZABLE` if contending moves are possible). This prevents a concurrent binding insert from attaching to a half-rewritten path set. A binding insert that races a move on the same subtree should serialize behind it (retry on serialization failure).
3. **Invalidate *after* commit, never before.** Publish `perms.invalidated` for the affected subjects only **after** the move transaction commits. Invalidating before commit lets a reader repopulate the cache from the *old* tree during the transaction, re-poisoning it. Order: `BEGIN → rewrite subtree paths → COMMIT → publish invalidation`.
4. **Read-your-writes for the mover.** The admin who performed the move must not be served a stale nav/grants tree; their own next request should miss the cache (version bump covers this).
5. **Bounded staleness for everyone else.** Between commit and invalidation-propagation, other nodes may briefly serve stale grants. The grants TTL (§6) is the backstop; keep it modest (≤10 min). Because coverage is deny-relevant, prefer *under*-privileging on uncertainty (a stale cache that lost a path denies access — safe — rather than granting one it shouldn't).

Affected-subject lookup: `role_binding` rows whose `scope_node_id` is the moved node or any descendant (a `<@` query on the pre-move subtree, captured *before* the rewrite or derived from the moved subtree's node ids).

## 8. `PermissionGuard` contract (for consumers)

Exposed from `libs/auth-kit` (Doc 08):

```
@RequirePermission('gatepass.dc.approve')          // WHAT
// scope target resolved from the request (param/body/header), e.g. :gateId → scope_node
```

The guard:
1. Verifies the JWT (signature, exp) and that `sid` is not revoked.
2. Loads the subject's resolved grants (cache).
3. Confirms the permission is held.
4. Resolves the target scope node from the request and runs the coverage check.
5. Rejects with `403` (permission) or `403`+reason (scope) on failure; every denial is audited.

## 9. Deny-by-default

No binding ⇒ no access. There is no implicit inheritance across the *permission* dimension (holding `dc.approve` does not imply `dc.create`) — only across the *scope* dimension (ancestor covers descendant). This asymmetry is deliberate and must be preserved.

## 10. Platform-admin authorization

Platform admins are authorized against `iam.platform.*` permissions bound at a special platform scope root (outside any client tree). Their checks skip the tenant scope-coverage step for registry operations but are still permission-gated and fully audited.
