# PlantOps IAM — NestJS Hardening Sessions

> Review scope: `apps/iam-api` and `libs/auth-kit` as of **Session 17 (roles)**, against NestJS framework conventions and enterprise API practice.
> Numbered **H1–H6** so they do not collide with `implementation-roadmap.md`'s Sessions 18–39. Each is positioned relative to a roadmap session, because two of them are cheaper before a roadmap session than after.
> **The spec suite (docs 00–10) remains the sole authority.** Nothing here changes a documented behaviour, a route, an error code, or a schema.

---

## What the review did *not* find

Stated first, so the list below is read as a short list of real gaps rather than a general verdict.

The following were checked and are correct as built — several of them are done better here than in typical NestJS codebases, and **none should be "fixed"**:

- **`APP_*` provider registration over `main.ts` wiring.** Guards, pipe, interceptor and filter are all `APP_*` providers, so `Test.createTestingModule` boots the real pipeline. This is what makes `testing/app-harness.ts` able to prove pipeline properties at all.
- **Global-guard ordering as a declared security property.** `AuthGuard` before `RateLimitGuard` so the throttle can key on `sub`, with the trade-off argued in `app/app.module.ts`. Correct, and correctly documented as order-sensitive.
- **Deny-by-default authentication** with an explicit `@Public()` opt-out, and a single 401 shape for every rejection reason.
- **`AsyncLocalStorage` for the request transaction** instead of `Scope.REQUEST` providers. This is the right call: request-scoped providers would force the entire dependency subtree request-scoped and re-instantiate it per request. `entityManager()` throwing instead of falling back to the `DataSource` is the load-bearing detail.
- **The zod-over-`class-validator` decision**, including the `class … extends createZodDto(...)` constraint and stripping unknown keys.
- **`OnModuleInit` / `OnApplicationShutdown` lifecycle** on both `DatabaseService` and `RedisService`, with `enableShutdownHooks()` actually enabled in `main.ts`.
- **Single-writer audit boundary** (`AuditService`) with redaction and no executor parameter, plus the separate `recordDenial` path that commits on its own connection.
- **Custom `@Global()` `ConfigModule` over `@nestjs/config`**, with `ENV` as a symbol token — substitutable in tests without touching `process.env`.
- **`@nx/enforce-module-boundaries` + the `set_config` lint gate.** Structural enforcement of an invariant that no type can see.
- **Error envelope centralisation** in one `@Catch()` filter, including the `headersSent` guard and the refusal to echo `QueryFailedError` text.
- **Interim `assertPlatformAdmin` / `assertAdministrator` as functions rather than guards.** The stated reason (a guard runs before the RLS context exists) is correct. See H1 — the reason is correct, and it is also a blocker the roadmap has not accounted for.

---

## H1 — Settle the `PermissionGuard` data path *before* Session 21

**Status:** ✅ done — Option A chosen and recorded in `docs/adr/0001-permission-guard-connection-strategy.md`.
**Position:** before roadmap Session 21. This is the only item here with a sequencing constraint.
**Severity:** architectural blocker.

**The problem.** Four files (`common/platform-admin.ts`, `common/administrator.ts`, `roles/roles.controller.ts`, `roles/roles.service.ts`) state — correctly — that *"a Nest guard runs before `TenantContextInterceptor` opens the transaction, so at guard time there is no RLS context to read"*, and each promises that Session 23 replaces the check with `@RequirePermission(...)`.

That promise is not implementable as worded. Session 21 builds `ResolverService.resolve()` and a Redis grants cache; Session 23's `PermissionGuard` reads that cache and **falls back to Postgres on a miss**. Misses are not rare — every deploy, every version bump from Session 22's invalidation table, and every ≤10-minute TTL expiry produces one. If `ResolverService` is written against `entityManager()` — the convention every service in this codebase follows — the guard cannot call it, and Session 21's work has to be reworked inside Session 23.

**Why moving the transaction into a guard does not solve it.** A guard has no "after" phase. It cannot own a transaction's lifetime across the handler, so opening in a guard and committing in an interceptor splits ownership: a request rejected between the two leaks a `QueryRunner`, and the rollback path in `TenantContextInterceptor` no longer sees every failure. The interceptor must keep owning the transaction.

**Recommended resolution (Option A).** `ResolverService.resolve()` takes an explicit `EntityManager` parameter rather than reaching for `entityManager()`. Two callers, two connections:
- Request handlers pass `entityManager()` — resolution joins the caller's transaction as it does today.
- `PermissionGuard` opens its own runner, applies `applyRlsContext` from the verified claims, resolves, releases. This is precisely the `AuditService.recordDenial` pattern, already proven in this codebase for the same reason (work that must survive, or precede, the request transaction).

`recordDenial` is already written and already narrowed to the two `authz.*` actions — so the denial-audit half of Session 23 is done and consistent with this choice.

**Alternative (Option C), worth a paragraph of consideration.** Make cache-miss resolution a `SECURITY DEFINER` function, as migrations 0010 and 0012–0015 already do for `write_audit`, login and refresh. It needs no RLS context because it derives everything from its arguments, so the guard calls it on any connection. This is the most in-grain option, but `resolve()` carries ltree path minimisation and expiry filtering, and moving that into PL/pgSQL trades testability for connection-independence. Choose A unless the guard's latency budget rules it out.

**Files to Modify (this session):** `docs/implementation-roadmap.md` (Session 21 acceptance criteria: `resolve()` takes an explicit `EntityManager`; Session 23: guard opens its own context), `docs/04-authorization-scope-resolution.md` §8 if the contract needs the note.
**Files to Create:** an ADR under `docs/` recording the choice and the rejected options.
**Dependencies:** none — this is a decision, not code.
**Acceptance Criteria:**
- The chosen option is written down with the "a guard has no after phase" argument, so Session 23 does not relitigate it.
- Session 21's roadmap entry names the signature constraint explicitly.
- The four "Session 23 replaces this" comments are amended to say *how*, not just *when*.

**Definition of Done:** Session 21 can be started without an open question about which connection `resolve()` runs on.
**Suggested Commit Message:** `docs(authz): fix the PermissionGuard connection strategy ahead of Session 21`

---

## H2 — Replace `@Req()` + the duplicated `claimsOf()` with a `@Claims()` param decorator

**Status:** ✅ done — `common/claims.decorator.ts` + spec; five controllers converted. Two corrections to the review below: the count was **18** `@Req()` parameters across **five** controllers, not 20 across six; and `clients.controller.ts` / `applications.controller.ts` never extracted claims at all (both document why under "No handler takes claims"), so they only needed their prose updated from `@Req()` to `@Claims()`. `auth.controller.ts` kept no `@Req()` either — sessions record a client-supplied `device_label` and no IP or user-agent, so nothing there needed the raw request. The only surviving express import in a controller is `health.controller.ts`'s `Response`, for `/ready`'s status code and cache header.
**Position:** any time before Session 18. Cheapest now — every new controller adds another copy.
**Severity:** medium. Drift risk plus avoidable platform coupling.

**The problem.** Three things, one cause:

1. **20 `@Req() request: Request` parameters** across the controllers, with `import type { Request } from 'express'` in six of them. Controllers are the layer that should be platform-agnostic; a future move to Fastify, or any `ExecutionContext`-based testing, is gated on those imports.
2. **`function claimsOf(request)` is copy-pasted verbatim in four controllers** (`auth`, `roles`, `scopes`, `service-accounts`) — the same five-line fail-closed helper, four times. `iam/whoami.controller.ts` inlines a fifth variant.
3. That helper encodes a real invariant ("the guard has already refused anything without claims; reaching the throw is a wiring bug"). An invariant enforced by copy-paste is one that stops holding at the first controller whose author writes `verifiedClaimsOf(request)!` instead.

This is the same failure mode `auth.guard.ts` argues against for opt-in guards: *the symptom of forgetting is a route that works*.

**The fix.** One `createParamDecorator` in `common/`:

```ts
export const Claims = createParamDecorator(
  (_: unknown, context: ExecutionContext): VerifiedClaims => {
    const claims = verifiedClaimsOf(context.switchToHttp().getRequest());
    if (!claims) throw IamException.authRequired();
    return claims;
  },
);
```

Handlers become `create(@Claims() claims: VerifiedClaims, @Body() body: CreateRoleDto)`. The fail-closed check lives in one place, the `express` import leaves the controllers, and the signature states that the route requires a subject.

`auth.controller.ts` keeps `@Req()` where it genuinely needs the request itself (IP / user-agent for session records) — the decorator replaces the *claims* extraction only.

**Files to Create:** `apps/iam-api/src/common/claims.decorator.ts`, `apps/iam-api/src/common/claims.decorator.spec.ts`.
**Files to Modify:** `auth/auth.controller.ts`, `roles/roles.controller.ts`, `scopes/scopes.controller.ts`, `service-accounts/service-accounts.controller.ts`, `iam/whoami.controller.ts`, `clients/clients.controller.ts`, `registry/applications.controller.ts`.
**Dependencies:** none.
**Acceptance Criteria:**
- `grep -c "function claimsOf" apps/iam-api/src` returns 0.
- No `.controller.ts` imports from `'express'` except where the raw request is genuinely used, and each such use carries a one-line reason.
- A route reached with no claims still produces `AUTH_REQUIRED` (401), asserted through the harness against the assembled pipeline, not against the decorator in isolation.
- No route's behaviour, status code or envelope changes — the existing integration suites pass untouched.

**Definition of Done:** `nx test iam-api` green with no spec edits beyond the new decorator's own.
**Suggested Commit Message:** `refactor(iam-api): extract @Claims() param decorator and drop Express coupling from controllers`

---

## H3 — Make `ZodValidationPipe` fail closed for `@Body()`

**Status:** ✅ done. Decision on the ambiguous case: **`Object` and `undefined` metatypes are failures, not exemptions** — an interface and a `type` alias both erase to `Object`, so exempting it would leave the rule catching nothing. `String`/`Number`/`Boolean` stay allowed on a body (that is `@Body('key')` property extraction, unused today, and a primitive has no fields to mass-assign). Two notes from building it: `@Headers()` has no `Paramtype` of its own — it arrives as `custom`, like every `createParamDecorator` — and `const X = createZodDto(s)` paired with a merged `type X` declaration actually *works*, so the real hazard the file's header warns about is the bare `type` alias, not the `const`.
**Position:** any time. Do it with H2.
**Severity:** medium. A fail-open in the one place this codebase otherwise refuses to fail open.

**The problem.** `common/validation.pipe.ts`:

```ts
if (!hasSchema(metadata.metatype)) return value;
```

A parameter whose type carries no `zodSchema` is passed through **untouched**. That pass-through is required for `@Param('id') id: string` and `@Query() q: string`. But it applies equally to `@Body()`. A handler written as `@Body() body: SomeInterface`, or with a `const` `createZodDto` alias instead of a `class … extends` (the exact mistake the file's own header warns about), receives the raw parsed JSON: unvalidated, unstripped, and mass-assignable into the repository layer.

The file already documents the trap. It does not enforce it. Today every `@Body()` is a proper DTO class — 18 of 18 checked — so this is a latent gap, not a live bug; that is exactly when it is cheap to close.

**The fix.** Keep the pass-through for `param`/`query`/`custom`, and throw for `metadata.type === 'body'` when the metatype is a real class carrying no schema (skipping the `Object`/`undefined` metatype that an untyped body produces, or treating that as a failure too — decide and document which).

**Files to Modify:** `apps/iam-api/src/common/validation.pipe.ts`, `apps/iam-api/src/common/validation.pipe.spec.ts`.
**Dependencies:** none.
**Acceptance Criteria:**
- A test controller with `@Body() body: PlainInterface` mounted through `createHarness({ controllers: [...] })` fails at request time with a clear developer-facing error, not a silent 200.
- `@Param`, `@Query` and `@Headers` pass-through is unchanged, asserted.
- Every existing route still validates and strips exactly as before.
- The header comment states the new rule, replacing the paragraph that currently describes the pass-through as unconditional.

**Definition of Done:** The trap the file documents is now the one the pipe enforces.
**Suggested Commit Message:** `fix(iam-api): fail closed when a @Body() parameter carries no zod schema`

---

## H4 — `AuditService.recordMany` for the six per-row audit loops

**Status:** ✅ done — `recordMany(entries)` writes N records through one
`select iam.write_audit(…) from unnest($1::text[], $2::text[], $3::uuid[], $4::jsonb[])`.
Four corrections to the review below. The table's six sites were **ten**: the
manifest's per-row *update* passes (`applyPermissions` → `updatePermission`,
`applyNav` → `updateNavNode`) are the "every manifest row changed" case and are
the ones a large application actually pays for, and both are loops over a private
method rather than over `audit.record` directly — they now build their record and
return it, so the pass writes one statement. The manifest's nav-deactivation loop
was a third such site, and `clients/client-applications.service.ts` (`enable`) a
fourth, outside the review's list. The updates themselves stay one statement each:
they set different values, and batching *them* is a schema question, not this
one. And `unnest` over four parallel arrays rather than a generated `values` list
so the statement text is constant whatever N is — one plan-cache entry, and no
path by which an array length reaches the SQL.

**Position:** before Session 20 (bindings) — that session multiplies the affected paths.
**Severity:** medium. Transaction duration and lock hold time, not correctness.

**The problem.** Six sites write audit rows one round-trip at a time inside the request transaction:

| File | Line | Loop over |
|---|---|---|
| `roles/roles.service.ts` | 392 | every binding cascaded by a role delete |
| `auth/session.service.ts` | 328 | every session revoked in a bulk logout |
| `registry/manifest.service.ts` | 435 | every manifest row changed |
| `registry/nav.service.ts` | 179, 443 | every nav node created / mapping changed |
| `registry/permissions.service.ts` | 122 | every permission created |

Each iteration is a separate `select iam.write_audit(...)`. A role bound at 500 subjects means 500 sequential round-trips holding an open transaction — and `roles.service.ts` holds it while the `role` row is still present and lockable. A manifest upsert touching a large application is the same shape. The per-record granularity is right and specified (Doc 10 §4); the per-round-trip cost is incidental.

**The fix.** One `AuditService.recordMany(entries)` that writes N records in a single statement — `select iam.write_audit(a, t, i, p) from unnest($1::text[], $2::text[], $3::uuid[], $4::jsonb[]) as a(...)` or equivalent. Same redaction, same catalog-typed action, same ambient transaction, same guarantee. Only the round-trip count changes.

**Files to Modify:** `apps/iam-api/src/audit/audit.service.ts` (+ spec), then the six call sites above.
**Dependencies:** none.
**Acceptance Criteria:**
- `recordMany` produces byte-identical rows to N `record` calls, asserted against a real Postgres in `audit.integration.spec.ts`.
- Redaction applies per entry; an empty array is a no-op that issues no statement.
- Each converted call site's existing audit assertions pass unchanged — record count, action, target and payload per row.
- The role-delete path issues one audit statement regardless of binding count (assert via `FakeDatabaseService.queries`).

**Definition of Done:** No `for (…) await this.audit.record(…)` remains in `apps/iam-api/src`.
**Suggested Commit Message:** `perf(audit): batch multi-row audit writes into a single statement`

---

## H5 — HTTP hardening in `main.ts`

**Status:** ✅ done. Four notes from building it, each a correction to the sketch below.

1. **Body parsing had to move into `AppModule` as Nest middleware, not stay in `main.ts`.** The acceptance criterion "assert it goes through `HttpExceptionFilter`" is not satisfiable with `NestFactory`'s built-in parser: it runs as Express middleware *before* Nest's router, reports failure by calling `next(err)`, and Express answers with its default HTML page — no filter is on the stack. Middleware applied through `MiddlewareConsumer` is wrapped in `RouterProxy`, which awaits it and hands a rejection to the exceptions handler, so the parser lives in `common/body-parser.middleware.ts` and the app boots with `bodyParser: false`. The same change closes a second hole nobody had noticed: **malformed JSON** was escaping the envelope too.
2. **Oversized bodies are `400 VALIDATION_FAILED`, not 413.** Doc 06 §2's code table is closed and this file's own preamble forbids changing it, so there is no `PAYLOAD_TOO_LARGE` to return. The message carries the byte figure so a caller can still act.
3. **The manifest ceiling is derived, not chosen.** `manifest.dto.ts` caps a document at 200 permissions and 200 nav nodes with bounded strings, so the largest *schema-valid* manifest is computable — about 2.1 MB. The limit is 4 MB, above it deliberately, so an upload is never refused for size before it can be refused for its fields. Global limit 64 kB; both are configurable and both are in Doc 06 §1.
4. **Ten integration specs were booting the app differently from `main.ts`** — each hand-rolled `moduleRef.createNestApplication()`, which silently kept Nest's own parser and its 100 kB default. They now share `createTestApplication()` in `testing/app-harness.ts`, so there is one boot path and the header assertions are statements about production.

**Position:** any time before Session 39 (deployment). Small.
**Severity:** low-medium.

**The problem.** `main.ts` sets `trust proxy`, CORS and shutdown hooks, and nothing else. Three specific gaps, each a one-liner, and one of them is a real decision rather than boilerplate:

1. **No explicit JSON body limit.** Express defaults to 100 kB globally. That is simultaneously too generous for `/auth/login` (which runs argon2id and is the one expensive unauthenticated path) and possibly **too small for `POST /iam/applications/:id/manifest`**, which uploads a whole application's permission and nav catalogue. Leaving it implicit means the manifest ceiling is an undocumented Express default that will surface as a confusing 413 in Session 29's UI. Set it deliberately: a tight global limit with a larger explicit one on the manifest route.
2. **`x-powered-by: Express` is still sent** — `app.disable('x-powered-by')`.
3. **No `X-Content-Type-Options: nosniff`.** Full `helmet` is largely aimed at HTML responses and adds little to a JSON API, but `nosniff` is cheap and applies. Adding helmet wholesale is not recommended; adding the two headers that matter is.

**Files to Modify:** `apps/iam-api/src/main.ts`, `apps/iam-api/src/registry/applications.controller.ts` (per-route body limit), `libs/config/src/env.schema.ts` if the limits become configurable, `.env.example`, `docs/06-api-surface.md` (document the manifest payload ceiling).
**Dependencies:** none.
**Acceptance Criteria:**
- A body over the global limit returns the envelope's 400/413, not Express's HTML error page — assert it goes through `HttpExceptionFilter`.
- The manifest route accepts a payload representative of the largest real application, and the ceiling is written in Doc 06.
- No `x-powered-by` header on any response; `X-Content-Type-Options: nosniff` on all.
- CORS, `trust proxy` and shutdown behaviour unchanged.

**Definition of Done:** Header and limit assertions in the harness suite; the manifest ceiling is a documented number rather than an inherited default.
**Suggested Commit Message:** `fix(iam-api): explicit body limits and response hardening headers`

---

## H6 — OpenAPI document generated from the zod DTOs

**Status:** ✅ done — built early, at Session 17 rather than before Session 26. **One acceptance criterion could not be met and was not**: "every route in Doc 06 appears in the document" is false today, because Sessions 18–25 have not built the user, binding, resolution and audit-read surfaces. The document covers the 43 operations that exist, and `openapi.spec.ts` asserts it covers *exactly* the routes the application registers — which is the checkable form of the same claim, and which will pull the remaining routes in as those sessions land. Four further notes:

1. **`@nestjs/swagger` was not used.** `SwaggerModule.createDocument` takes an initialized application, so emitting the document would mean booting Nest with a `DataSource`, a Redis client, a signing key and a validated environment — for a documentation build. Reading the decorator metadata off the controller classes instead (`openapi/openapi.ts`, ~80 lines) makes the document a pure function of the code. The scanner's correctness is not assumed: the spec compares it with the real Express router stack, in both directions.
2. **Responses needed schemas that did not exist.** `@plantops/contracts` is TypeScript interfaces — erased, so nothing can convert them. Rather than hand-write response schemas or decorate the DTOs with a second vocabulary, `openapi/schemas.ts` mirrors each published interface in zod and `schemas.spec.ts` pins all 27 with `Expect<Equal<z.infer<…>, XDTO>>`. A contract change that is not mirrored fails `nx typecheck`. `Expect`/`Equal` are now exported from the contracts barrel.
3. **Route metadata is a central map, not decorators on handlers** (`openapi/route-responses.ts`), for the reason `validation.pipe.ts` rejected `class-validator`: a parallel description sitting in the controllers drifts silently. Completeness is a *type* — `ControllerResponses<T>` is exhaustive over the controller's method names, so a new route does not compile until it is described.
4. **Two runtime surprises worth recording.** `tsx` cannot run the generator at all: esbuild does not implement `emitDecoratorMetadata`, and `design:paramtypes` is precisely how a `@Body()` parameter is connected to its DTO — under `tsx` the document builds fine and simply has no request bodies. And `libs/*` are ESM while `apps/iam-api` is not, which webpack and Jest paper over and Node does not. Hence `tools/emit-openapi.cjs`, which registers `@swc-node/register` explicitly.

**Position:** immediately before roadmap Session 26 (`iam-client`). **Not now.**
**Severity:** low today; becomes medium the moment a second team integrates.

**The problem, honestly framed.** There is no machine-readable API description. Today that costs nothing: the only consumers are `admin-web` and `iam-client`, both inside this workspace, both typed through `@plantops/contracts`, and Doc 06 is a precise human-readable spec. Adding Swagger now would be ceremony.

It stops being ceremony at Doc 00 §9 — the six operational module teams integrate against this IAM from outside the workspace. They cannot import `@plantops/contracts`, and "read Doc 06" does not generate a client, drive contract tests, or fail CI when a response shape drifts.

**Why this is cheap here specifically.** `@nestjs/swagger` normally means `class-validator` decorators — a second validation vocabulary, which `validation.pipe.ts` explicitly and correctly rejected. That objection does not apply: zod v4 ships `z.toJSONSchema()`, so the schema already attached to every `createZodDto` class *is* the document source. `@nestjs/swagger` is needed only for route/parameter metadata, and the DTO schemas come from the code that already validates them — meaning the document cannot drift from the validator, which is the usual reason generated API docs go stale.

**Files to Create:** `apps/iam-api/src/openapi/openapi.ts` (document factory), a build target emitting `openapi.json`, a spec asserting every route appears.
**Files to Modify:** `common/validation.pipe.ts` (expose the schema for the generator), `main.ts` (serve the document outside production, or emit at build time only), each controller (route-level response metadata).
**Dependencies:** roadmap Sessions 1–25 complete.
**Acceptance Criteria:**
- Every route in Doc 06 appears in the document with its request and response schemas, and the two are checked against each other in CI.
- The error envelope of Doc 06 §2 is a documented response on every route; the `IamErrorCode` enum appears as a schema.
- Schemas derive from the live `zodSchema`, never hand-written — a DTO change that is not reflected fails the build.
- The document is not served in production unless a deployment opts in explicitly.

**Definition of Done:** `openapi.json` is a build artefact, and a deliberate breaking change to a DTO fails CI.
**Suggested Commit Message:** `feat(iam-api): generate the OpenAPI document from the existing zod DTO schemas`

---

## Sequencing

| # | Item | Do it | Blocks | Est. |
|---|---|---|---|---|
| H1 | PermissionGuard connection strategy | ✅ **done** (ADR 0001) | Sessions 21, 23 | 1–2 h (decision + ADR) |
| H2 | `@Claims()` param decorator | ✅ **done** | — | 2–3 h |
| H3 | Fail-closed body validation | ✅ **done** | — | 1–2 h |
| H4 | Batched audit writes | ✅ **done** | — | 3–4 h |
| H5 | Body limits + headers | ✅ **done** | Session 29 (manifest UI) | 1–2 h |
| H6 | OpenAPI from zod | ✅ **done** (early) | external module teams | 5–7 h |

H1 is the only one that costs more if deferred; the rest are ordinary cleanups whose cost is roughly flat. **H1, H2 and H3 together are under a day** and are the ones worth doing before Session 18 starts.
