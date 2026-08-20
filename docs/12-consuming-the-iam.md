# 12 — Consuming the IAM from another product

> How a product that is **not** PlantOps — a different domain, a different repository, a different release cadence — uses this IAM as its identity and authorization authority. What already works, what has to be built, and the two decisions that must be taken deliberately rather than by default. Doc 02 §5 and Doc 04 are the authorities on tenancy and resolution; nothing here changes either.

---

## 1. What is already domain-neutral

The IAM was specified for manufacturing operations, but almost nothing in it is manufacturing-specific. Three facts, all verifiable in the code rather than asserted:

**Authorization reads no domain data.** `apps/iam-api/src/authz/resolver.service.ts` never reads `scope_node.kind`. Coverage is `ltree` containment on `path` alone, so a CRM's *Region → Branch → Team* resolves through the identical code path as *Group → Plant → Gate*. A tree is a tree.

**Permissions are namespaced per application.** `unique(application_id, key)` means `crm.deal.approve` and `gatepass.dc.approve` coexist with no collision, and each product owns its own catalogue.

**Registration is runtime data.** A new product uploads a manifest (Doc 02 §2) and is enabled per tenant through `client_application`. No migration, no IAM deploy, no code change — the promise Doc 02 §8 makes to PlantOps modules holds identically for anything else.

The one place the manufacturing origin shows is `scope_node.kind`, whose enum labels are `group | plant | department | gate`. It is a display label — see ADR 0002 for what it costs, what would change it, and why nothing is being done about it yet.

## 2. What a consuming product has to do

| Step | How |
|---|---|
| Register the product | Upload its manifest — permissions and nav tree (Doc 02 §2) |
| Enable it for a tenant | `client_application` toggle (Doc 02 §3) |
| Authenticate users | The IAM issues the tokens; the product never stores a password |
| Verify tokens | Fetch `GET /iam/.well-known/jwks.json`, verify RS256 by `kid` |
| Authorize a request | `POST /iam/permissions/check`, or resolve once and test coverage locally |
| Render its menu | `GET /iam/navigation?applicationId=` |

Verification is by **public key**. There is no shared secret to distribute, rotate, or leak, and a consuming product needs no credential to check a token's validity — only to call the IAM's own APIs.

## 3. What has to be built first

Two blockers, both about packaging rather than capability.

**`auth-kit` is NestJS-only.** It declares `@nestjs/common` and `@nestjs/core` as hard dependencies, so a Next.js route handler, an Express service or a Fastify one gets nothing from it — and it is the module that enforces `@RequirePermission`. Session 50 splits it into a framework-free core with thin adapters. The package boundary is the part that cannot be changed later without breaking every consumer, which is why it comes before publishing rather than after.

**The libs are not installable.** All five are `"private": true` at version `0.0.1`, and `web-kit` and `ui` set `main: ./src/index.ts` — they ship *source*, relying on the consumer's bundler and tsconfig paths. `contracts` and `iam-client` at least build to `dist`. Session 51 makes all five publishable.

Good news on the React side: `libs/web-kit` imports nothing from `next`. `PlantOpsProvider`, `RequireAuth`, `usePermission` and `useNavigation` are framework-agnostic React by design — the library's own header says redirects are callbacks precisely so no consumer is pinned to one router.

## 4. Monorepo or dependency?

Doc 00 §7 chose a monorepo, and gave the reason: *"Separate repos would turn every contract change into a publish-and-version dance."*

That reasoning is sound and still holds — **for PlantOps modules.** Gatepass and visitor management share this IAM's contracts, ship on its cadence, and change with it; they belong in `apps/*` as Doc 08 §1 says.

It does not extend to an unrelated product. A CRM that releases on its own schedule and shares no domain vocabulary gains nothing from atomic contract changes and loses real autonomy to a shared release train. For those, the publish-and-version dance is not overhead — it is the correct interface, and the versioning that Doc 00 §7 treats as a cost is what lets the two move independently.

**Rule of thumb:** shares the domain and the release cadence → `apps/*` in this workspace. Neither → a published dependency.

## 5. One instance, or several?

This needs deciding deliberately, because the default is easy to walk into.

Access tokens carry exactly `iss, sub, sty, cid, sid, iat, exp` (Doc 03 §2). **There is no `aud` claim.** A token issued by an instance is therefore valid at *every* application registered on that instance.

For products serving the same people that is a feature — one login across everything, genuine SSO, no work. For unrelated products with different user bases it means a token minted for one is accepted by the other, and a single outage takes down everything.

| | One instance | One per product |
|---|---|---|
| Users | Shared — sign in once | Separate |
| Tenant isolation | `client` + RLS, already enforced | Physical as well |
| Blast radius | Every product | One product |
| Upgrade schedule | Shared | Independent |
| Operational cost | One stack | N stacks |

**Same customers → one instance.** The `client` row already isolates data and `client_application` already gates features; nothing more is needed.

**Unrelated customer bases → separate instances.** Same image, different deployment — Phase 8 delivers exactly this and costs nothing extra per instance.

If you ever need one instance *with* per-application token scoping, that is an `aud` claim plus audience validation in `auth-kit`'s core. Small, but design it before there are three consumers rather than after — every issued token and every verifier changes.

## 6. The integration path

Session 52 ships the runnable version of this: a quickstart and a Next.js example held green by CI. The shape:

1. Write the product's manifest — its permissions and its nav tree.
2. Upload it (`POST /iam/applications/:id/manifest`), enable it for the tenant.
3. In the product's frontend, wrap the app in `PlantOpsProvider` from `@plantops/web-kit`.
4. In the product's backend, verify the token via JWKS and authorize with `@plantops/auth-kit/core`.
5. Render the menu from `/iam/navigation?applicationId=`.

Nothing in that list edits the IAM or runs a migration, which is the property worth protecting: the day integrating a new product needs a change to this repo is the day the registry has stopped being data.

## 7. Open decisions

1. **One instance or several** (§5) — and if one, whether `aud` is needed.
2. **`scope_node.kind`** — ADR 0002. Closed by the gatepass specification, not by this document.
3. **Which registry** — GitHub Packages is the obvious default given the repository already lives there; it needs an `.npmrc` and a token in every consuming repo's CI.
