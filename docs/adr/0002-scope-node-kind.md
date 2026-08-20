# ADR 0002 — What `scope_node.kind` is for, and what would change it

> **Status:** open — recorded 2026-08-20. **This ADR does not decide; it records a fork and names the fact that resolves it.**
> **Decides for:** nothing yet. Blocks nothing. Must be closed before the gatepass module specifies how it binds to scope nodes.
> **Supersedes nothing.** Changes no documented behaviour, route, error code or schema — the spec suite (docs 00–11) remains the sole authority. Doc 01 §3.5 and Doc 11 §10 carry the affected statements.

ADRs live in `docs/adr/` and are numbered independently of the spec docs. A spec doc says what the system does; an ADR says why one of several correct-looking ways of building it was chosen. This one is unusual: it is written *before* the decision, because the decision depends on a fact about the first operational module that nobody has established yet, and because the cost of deciding wrongly is asymmetric.

---

## 1. Context

`scope_node.kind` is a Postgres enum with four labels — `group`, `plant`, `department`, `gate` — declared in migration 0001 and mirrored as a closed union in `libs/contracts/src/scopes.ts`. Every node must declare one at creation, and it is **immutable afterwards**: `PATCH /iam/scopes/:id` accepts `name` and `parent_id` only.

### 1.1 What reads it

Very little, and nothing that matters for access:

| Consumer | Use |
|---|---|
| `libs/ui/src/data/scope-tree.ts`, `scope-tree-select.tsx` | Renders a tag and an icon |
| `apps/admin-web/src/components/scopes/scope-tree-editor.tsx` | Pre-selects a default kind for a new child, left editable |
| `apps/iam-api/src/scopes/scopes.service.ts` | Stores it, returns it, validates it against the enum |

**`apps/iam-api/src/authz/resolver.service.ts` never reads it.** Coverage is decided by `ltree` containment on `path` alone. A binding at a node covers everything beneath it whatever the kinds involved are, and a mis-kinded node resolves access exactly correctly.

Nor does anything constrain tree *shape* by kind. `libs/contracts/src/scopes.ts` says so directly:

> "the tree's *shape* is not constrained by kind: nothing stops a gate under a group, and nothing should, since tenants organise themselves differently. The kind is what a UI renders an icon from and what an operator reasons about; coverage is decided by the path alone."

### 1.2 Why it nonetheless earns its place

The scope tree is where an administrator grants WHO × WHAT × WHERE (Doc 09 §3.4), and a mistake there silently grants access to the wrong physical place. A four-hundred-node tree reading `B2`, `North`, `G3`, `Line 4` is unreadable without knowing what each node *is*. Doc 09 calls the tree "the WHERE dimension made visible"; `kind` is most of what makes it visible.

So the concept is justified. What is not obviously justified is the *implementation*.

### 1.3 The tension

`kind` is a display label implemented as the least flexible construct available:

- **Values are permanent.** Postgres has no `ALTER TYPE ... DROP VALUE`. Every label added is added forever, including the ones named wrong.
- **Adding one is a migration**, in a system whose stated principle (Doc 02 §8) is that adding a client, app, menu, role or permission is "always an API call, never a migration." For a SaaS deployment that is a release; for a self-hosted client on their own upgrade schedule (Doc 11 §5.4) it is a release they have to *apply*.
- **The vocabulary is global.** Every tenant shares one list. A tenant that is not a manufacturer still sees `plant` and `gate` in their kind picker.
- **`ALTER TYPE ... ADD VALUE` interacts badly with transactional migrations.** On Postgres 16 the statement may run inside a transaction, but the new value cannot be *used* in that same transaction — so "add `branch`, then seed a `branch` node" cannot be one migration.

None of this is costly today, because every tenant is a manufacturer and the four labels fit.

---

## 2. The fork

Everything above is settled fact. What is not settled is a single question about the first operational module:

> **Will any operational module key behaviour off `kind`?**

The natural example is gatepass. "A pass is issued **at a gate**" is a plausible thing for that module to say, and Doc 00 §5 already mentions shared gate-terminal devices. If gatepass validates that its target node is `kind = 'gate'`, then `kind` has stopped being a label and become part of the domain model.

### Branch A — no module reads `kind`

It stays cosmetic. Then:

- The enum is a tolerable shortcut. A new domain costs one migration with two or three labels, and the accumulated vocabulary is untidy rather than harmful.
- A mis-kinded node is a wrong icon. Nothing else.
- Hierarchy rules would buy tidiness only, and are not worth their machinery (§3).
- **Action: do nothing.** Revisit only if a tenant's vocabulary genuinely does not fit.

### Branch B — a module reads `kind`

It is domain data wearing a UI label's clothes. Then:

- A mis-kinded node becomes a **functional bug**: a gate that gatepass refuses to operate at, discovered by an operator at a terminal rather than by a test.
- The global enum becomes a real constraint, because two tenants in different industries now need different *semantic* vocabularies, not just different icons.
- Optional per-tenant structure becomes worth its cost, because the mistake it prevents now has consequences.
- **Action: tenant-defined kinds, decided before gatepass ships bindings to production** — retrofitting after a tenant has a populated tree means migrating live scope data.

**The asymmetry is why this is written now.** Branch A costs nothing to be wrong about for a while. Branch B costs a data migration of the one table whose integrity everything else rests on.

---

## 3. Options considered

### Option 1 — keep the global enum, add labels per domain

Cheapest per step, and correct if Branch A holds. Rejected as a *long-term* answer only under Branch B, where it compounds: labels are permanent, so a wrong guess about another industry's vocabulary can never be removed.

### Option 2 — tenant-defined kinds (a per-client lookup table)

The right shape if Branch B holds. Real costs, and they are more than a table:

- `ScopeNodeKind` stops being a TypeScript union and becomes `string`; exhaustiveness checking is lost everywhere it is used.
- `ScopeKindTag`'s fixed icon and colour map has no fixed domain any more. Either clients pick icons — a new screen — or everything renders generically, which erodes the legibility that justified `kind` existing at all (§1.2).
- Validation moves from a static enum to a database lookup.
- The client console gains a "manage node types" screen.

Estimated at a session and a half, not a session.

### Option 3 — client-defined hierarchy rules, enforced

**Rejected as a default; defensible as opt-in.**

Enforcing a declared hierarchy — "gates only under plants" — by default is wrong, and the codebase already argues why: a single-site tenant goes Group → Gate with no plant layer, and `scope-tree-editor.tsx` notes that "an organisation with a department straight under a group is modelling itself honestly." A model that rejects a legitimate org chart gets discovered during onboarding, at the worst possible moment.

The objection dies, however, if enforcement is **opt-in per client**: a tenant that chooses rules is applying its own policy, not being refused by ours. The reconciliation problem is also softer than it first looks — enforce on new nodes, report existing violations, never retroactively invalidate a tree.

What makes it *worth* building is Branch B. Under Branch A it prevents a wrong icon; under Branch B it prevents a functional defect in a 400-node tree maintained by several administrators over years.

### Option 4 — a soft "typical parent" hint

Cheap middle ground, and it is what the UI already does with hardcoded values: pre-select the likely kind when adding a child, leave it editable, enforce nothing. Carrying that hint on a tenant-defined kind row gets most of Option 3's benefit for almost none of its cost, and never rejects a structure.

**Recommended companion to Option 2 under either branch.**

---

## 4. Consequences to record now

### 4.1 The licensing meter must not key off `kind`

Doc 11 §10 proposes `max_scope_nodes` of kind `plant` as the entitlement meter, and Session 48 would implement it. **That is unsafe if kinds ever become tenant-defined**, because the meter would then count a field the customer controls — a tenant could rename or avoid the metered kind.

Doc 11 §10 has been corrected accordingly. Session 48 must meter on either total `scope_node` count or a platform-set flag the tenant cannot edit. This holds under **both** branches, because the decision on kinds may be taken after Session 48 ships.

### 4.2 Nothing is blocked

`kind` is stored, immutable, and read only by presentation code. Both branches remain fully open with no work done today, which is the reason for doing none.

---

## 5. What closes this ADR

The gatepass specification, at the point it states how a pass binds to a scope node.

- If it binds by **coverage alone** — a subject holds `gatepass.dc.approve` at a node covering the target — Branch A holds. Mark this ADR *accepted: keep the enum*, and revisit only on a tenant vocabulary mismatch.
- If it binds by **kind** — "the target node must be a gate" — Branch B holds. Mark this ADR *accepted: tenant-defined kinds*, and schedule Option 2 plus Option 4 **before** gatepass ships to a tenant with a populated tree.

Whoever writes that spec should close this file in the same session.
