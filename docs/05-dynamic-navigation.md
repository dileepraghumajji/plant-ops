# 05 — Dynamic Navigation

> Navigation is generated from data, never hardcoded. Defines how `nav_node` + `menu_permission` produce a per-user, per-application, scope-aware menu tree, and the resolution endpoint the frontend consumes.

---

## 1. Principle

The frontend menu a user sees is **computed from their permissions**, not shipped as a static config. Add a menu in the admin UI, map a permission to it, and it appears for exactly the users who hold that permission — with no deploy. This is the visible proof that the registry is working.

## 2. Inputs

- **nav_node** (Doc 01 §3.3) — the module/menu/sub-menu tree per application.
- **menu_permission** (Doc 01 §4.4) — which permission(s) gate each node.
- The subject's **resolved grants** (Doc 04) — which permissions they hold.

## 3. Visibility rules

For a given user and application:

1. A **leaf** node (a menu/sub-menu with a route) is visible iff the user holds **at least one** permission mapped to it via `menu_permission` (OR semantics). A leaf with **no** mapped permission is **hidden by default** (deny-by-default, Invariant I3): an unmapped menu is a configuration gap, not a public grant. To intentionally expose a leaf to any user who can see the app, set an explicit `is_public = true` flag on the `nav_node` — only then is an unmapped leaf visible. This inverts the previous "unmapped = public" rule, which was a silent-access footgun. Use `is_public` sparingly (e.g. an app landing page).
2. A **container** node (module/menu with children, no route) is visible iff **at least one descendant leaf is visible**. Empty containers are pruned.
3. A node belonging to an application **not enabled** for the user's client is never returned.
4. Ordering follows `sort_order`; inactive nodes (`is_active=false`) are excluded.

> Note: navigation visibility is **permission-based**, not scope-based. Scope (WHERE) filters *data within* a screen, not whether the menu item appears. A guard who has `visitor.checkin` at any gate sees the Visitor menu; the screen then shows only their gate's data (Doc 04 §5). This separation keeps nav simple and data correct.

## 4. Resolution endpoint

```
GET /iam/navigation?applicationId=<id>
   (subject + client come from the JWT)
→ 200 {
     application: { id, key, name },
     tree: [
       { id, kind, key, label, route, icon, children: [ ... ] }
     ]
   }
```

Optionally support `GET /iam/navigation` (no app id) to return the **cross-application** menu — top-level a node per enabled application, each expandable — for a unified shell.

## 5. Resolution algorithm

```
navigation(subject, client, applicationId):
  if not client_application(client, applicationId).enabled: return empty
  grants ← resolve(subject, client).permissions        # from cache (Doc 04)
  nodes  ← nav_node where application=applicationId and is_active
  gates  ← menu_permission for those nodes             # node → [permission]

  visible(node):
     if node has children:
        vchildren ← [visible(c) for c in children if visible(c)]
        return node with children=vchildren  if vchildren non-empty else PRUNE
     else:  # leaf
        req ← gates[node]                    # required permissions (OR)
        if (req ∩ grants) non-empty: return node
        if req empty and node.is_public: return node   # explicit public opt-in only
        PRUNE                                 # unmapped + not public ⇒ hidden

  return [visible(root) for root in top-level nodes, pruned, sorted]
```

## 6. Caching

The nav tree for `(subject, application)` is derivable from the cached grants plus the (rarely-changing) nav catalog. Options:

- Cache the **computed tree** per `(subject, application)` with the same version/invalidation scheme as grants (Doc 04 §7). Invalidate when either the subject's grants change **or** the application's nav catalog / menu_permission changes.
- Or compute on demand from cached grants (cheap for typical catalog sizes). Prefer this unless profiling says otherwise — one less cache to invalidate.

Catalog-change invalidation: when a platform admin edits `nav_node` or `menu_permission` for an application, bump an `app_nav_version[applicationId]` and treat cached trees for that app as stale.

## 7. Frontend contract

- On entering an application, the Next.js app calls `/iam/navigation?applicationId=…` and renders the returned tree directly — it does not maintain its own menu constants.
- Route guards on the client mirror the server: if a user deep-links to a route whose menu they cannot see, the client should still call the underlying API, which enforces the real permission (client-side hiding is UX, not security).
- `icon` is a string key the frontend maps to its icon set.

## 8. Relationship to the reference system

The reference screenshot had Application → Module → Menu → Sub-Menu as separate configured entities and a Permissions list, but navigation there was (typically) static or role-listed. The change here is the explicit **menu_permission** join plus **permission-driven pruning at resolve time**, so the menu is a pure function of the user's grants and the catalog — nothing hardcoded, nothing per-release.
