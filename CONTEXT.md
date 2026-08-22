# PlantOps IAM

The identity and authorization authority for a family of manufacturing non-core operations applications (gatepass, visitor management, meeting-room booking, vehicle requisition, security patrol). It is built standalone and first, because every operational module depends on it.

This file is a **glossary and nothing else**. It fixes what the words mean so that code, specs and conversation use them the same way. What the system *does* is specified in `docs/00-12`, which remain the sole authority on behaviour; why a particular design was chosen is in `docs/adr/`.

**Boundary.** One glossary covers this whole repo today, including the operational modules that will land in it. A module bringing vocabulary of its own — gatepass's dockets and approvals — does not warrant a split; those terms simply join this file. The trigger for splitting into per-context glossaries is a module needing a word *this* file has already claimed for something else, the likeliest candidate being **scope**, if gatepass reads it as "job scope" rather than as a place. `docs/adr/0002-scope-node-kind.md` is open on how gatepass binds to scope nodes, so that decision and this one will probably arrive together.

## Language

### The access equation

Every authorization decision answers three orthogonal questions — `WHO × WHAT × WHERE`. The terms in this section are those three dimensions and the row that ties them together.

**Subject**:
The WHO — a single actor that can hold access, being either a User or a Service Account. Exactly one subject is named by any token and by any role binding.
_Avoid_: principal, identity, account. (`actor` is reserved for the audit trail's record of who did something.)

**User**:
A human identity belonging to exactly one client. The same email address in two clients is two unrelated people.
_Avoid_: person, employee, member, account.

**Service Account**:
A machine identity used for module-to-module calls, authenticating with an account key and secret rather than a password. May belong to a client or to the platform.
_Avoid_: API key, bot, machine user, system user, integration.

**Permission**:
The WHAT — one atomic, namespaced capability such as `gatepass.dc.approve`, owned by the application that registered it. Permissions are data, never enumerated in code.
_Avoid_: privilege, right, capability, ability, and especially **scope** (which here means WHERE, not an OAuth-style permission string).

**Role**:
A client-defined bundle of catalog permissions. The only dimension of the three that a client composes for itself.
_Avoid_: group, profile, persona, user type.

**Scope Node**:
The WHERE — one node of a client's own organizational tree, such as a plant, a department or a gate. Access is always held *at* a scope node, never in the abstract.
_Avoid_: location, site, area, org unit, and a bare "node" (ambiguous with Nav Node).

**Role Binding**:
One row tying a subject to one role at one scope node, optionally with an expiry. It is the only thing in the system that confers access; a user, role or scope node alone confers nothing.
_Avoid_: assignment, membership, allocation.

**Grant**:
Singular, *a grant* is one role binding seen from the outside — the access it confers rather than the row that records it. Plural, *resolved grants* is something else entirely (see below), so the number carries meaning here and is not a stylistic choice.
_Avoid_: using the plural for a set of bindings, which is the one reading that collapses the two senses.

### Resolution

**Coverage**:
The property that a role binding made at a scope node applies to that node and its entire subtree. A binding at a plant covers every department and gate beneath it.
_Avoid_: inheritance, cascade, propagation, bubbling.

**Scope Path**:
A scope node's position in its tree, expressed in labels derived from node identity rather than from display names — which is what lets a node be renamed without disturbing any access beneath it. Not a breadcrumb, and never shown to an operator as one.
_Avoid_: breadcrumb, ancestry, lineage, full name.

**Resolved Grants**:
A subject's complete computed answer: which permissions they hold, and the minimal set of scope paths covering each. Not "the grants, resolved" — it is a set of permissions and paths, never a collection of role bindings, and the bindings it was computed from are not recoverable from it. Derived rather than carried in a token, so a change to access takes effect on invalidation rather than at token expiry.
_Avoid_: effective permissions, ACL, entitlements, claims.

**Invalidation**:
The act of marking a subject's resolved grants stale so the next decision recomputes them. Any change to a binding, a role's permissions, an application's availability or the shape of the scope tree invalidates.
_Avoid_: cache bust, refresh, expiry (which belongs to a binding's expiry and to tokens).

### Tenancy and the registry

**Client**:
One tenant organization. "Tenant" is used as an adjective for isolation concerns (tenant context, tenant data), but the noun for the row, the column and the token claim is always *client*.
_Avoid_: customer, organization, company, account, and "tenant" as a standalone noun.

**Slug**:
A client's short lowercase handle, and half of what a user types to log in — a login is an email plus a slug, never an email alone.
_Avoid_: code, shortname, subdomain, identifier.

**Application**:
The IAM's *registration* of a module — the catalog row carrying its key, its permissions and its navigation. Created at runtime; adding one requires no deploy. An application is what the IAM knows about a module, not the running thing itself.
_Avoid_: service, product, system.

**Module**:
One operational product in the family the IAM serves — gatepass, visitor management, meeting-room booking. A module is the deployed thing; its Application row is how the IAM represents it, and the two are worth keeping apart when the distinction matters. Freely qualified as an *operational module* or a *consuming module*.
_Avoid_: nothing — this word is the product sense. The nav kind is a *module nav node*, and NestJS's `@Module` is framework plumbing outside this vocabulary.

**Manifest**:
The declarative document an application ships to register and later evolve its own permissions and navigation. Re-uploading one is an idempotent upsert keyed by natural key.
_Avoid_: schema, config, definition, spec.

**Catalog**:
The platform-owned rows shared by every client — applications, permissions and nav nodes. Catalog rows belong to no client, are readable by any authenticated subject, and are written only by a platform admin. Everything else is client data.
_Avoid_: master data, reference data, global config.

**Enablement**:
A client's per-application switch controlling whether an application is available to that client. Distinct from an application's own platform-wide *active* flag: the first is one tenant's decision, the second is the platform's.
_Avoid_: subscription, entitlement, licence, provisioning.

**Inert**:
The state of a mapping or grant that is preserved but currently confers nothing — typically because its application is disabled for the client, or its permission was deactivated by a manifest re-upload. Inert is not deleted; re-enabling restores it exactly.
_Avoid_: orphaned, stale, dangling, soft-deleted.

**Platform admin**:
The tier that registers applications and their catalogs, registers clients, and controls which applications each client may use. Authority is expressed as `iam.platform.*` permissions.
_Avoid_: super admin, root, owner, system admin.

**Client admin**:
The tier that, within one client, builds the scope tree, creates roles, maps permissions to them, manages users and makes bindings. Authority is expressed as `iam.client.*` permissions.
_Avoid_: tenant admin, org admin, customer admin.

**Bootstrap**:
Provisioning a client's very first administrator, which creates the user, the client's root scope node, its system admin role and the binding joining them as one act. The single point in the system where an operator sets somebody else's initial credential.
_Avoid_: onboarding, seeding, initialization, setup.

**Break-glass**:
Deliberate out-of-band recovery of a locked-out client administrator, run as a command on the host by someone who already has the database, and always audited. Not a permission, and not a routine path.
_Avoid_: emergency access, backdoor, override, admin reset.

### Navigation

**Nav Node**:
One entry in an application's menu tree, of one of three kinds — `module`, `menu` or `sub_menu`. Nav nodes are catalog data registered by manifest, not constants in the frontend.
_Avoid_: menu item, link, route (a route is a field on a nav node, not the node).

**Module nav node**:
The top kind of nav node — an application's root menu entry. Always qualified, never a bare "module", because the bare word belongs to the operational product.
_Avoid_: calling it simply a module.

**Resolved navigation**:
The pruned menu tree one subject actually sees, with leaves they hold no mapped permission for removed, and containers left empty removed with them. Distinct from the catalog tree, which is everything that exists.
_Avoid_: menu, sidebar, user menu.

**Public node**:
A leaf explicitly opted in to being visible without any permission mapping. An unmapped leaf that has *not* opted in is hidden, so visibility is never granted by omission.
_Avoid_: open, unrestricted, default-visible.

### Sessions and audit

**Session**:
One login's lifetime, identified by an id carried in every token issued for it, and the unit revocation acts on. Service-account tokens have an ephemeral session that cannot be revoked mid-token.
_Avoid_: login, connection, device.

**Force logout**:
Administrative revocation of a subject's sessions, taking effect on the next request rather than at token expiry. What locking or disabling a user does to any session they hold.
_Avoid_: kick, sign out, terminate, invalidate (which belongs to grants).

**Audit trail**:
The append-only record of every registration, mapping, binding, login and revocation. Readable through the API and writable through no endpoint at all.
_Avoid_: log, history, activity feed, event log.

**Actor**:
Who took an audited action, derived from session context rather than supplied by any caller. **Not a synonym for Subject, and not a function of subject type**: an actor is the *platform* when the subject holds platform authority, a *user* when a human subject is present, and a *service account* otherwise. So a human platform admin is recorded as the platform, not as a user — the actor answers "in what capacity", where the subject answers "who". Audit is the only place the word belongs.
_Avoid_: user, subject, author (within audit records), and reading an actor type back as a subject type.

**`service` vs `service_account`**:
The same machine identity under two names: a `service` as a subject type, a `service_account` as an actor type. Nothing converts one to the other, and nothing should start — the link is not a value mapping but a deliberate omission. A service account's identity is withheld from the user-identity slot of the request context, and the audit writer infers the actor from that absence.
_Avoid_: assuming one spelling works in both positions, or introducing a translation function between them.

**Action**:
The catalog name of an audited event, such as `role.updated` or `platform.break_glass`. Actions outlive the catalog that wrote them, so the trail may contain names no longer issued.
_Avoid_: event, operation, activity, verb.
