# Fixture note — module-boundary lint check (Sessions 1, 27, 38)

Doc 08 §2 requires that any project other than `iam-api` importing `libs/db`
fails `nx lint`. This was verified during Session 1 with a temporary import
and then removed, per the roadmap's acceptance criteria. Session 27 added the
frontend libraries and re-verified their boundaries the same way.

> **Since Session 38 this note is a description, not a procedure.** The probes
> below are automated in
> [`apps/iam-api-e2e/src/boundary-lint.e2e.ts`](../../apps/iam-api-e2e/src/boundary-lint.e2e.ts),
> which drives [`tools/check-boundaries.mjs`](../../tools/check-boundaries.mjs)
> — it writes the temporary import, lints it, asserts the refusal, and deletes
> the file, for every row here plus a *permitted* control (`iam-api` importing
> `libs/db`) that catches a harness which refuses everything. It also reads the
> rule's own `depConstraints` back and asserts that `scope:db` appears in
> exactly one allow-list, which is the failure a hand-run probe cannot see: a
> widened allow-list keeps every refusal above intact while opening the door for
> the project that was widened.
>
> Run it on its own with:
>
> ```sh
> npx nx e2e @plantops/iam-api-e2e --testPathPatterns=boundary-lint
> ```
>
> Or by hand, for one probe, without the test runner:
>
> ```sh
> node tools/check-boundaries.mjs --probe apps/admin-web/src:@plantops/db
> ```

## How to reproduce

1. Add to `apps/admin-web/src/app/page.tsx`:

   ```ts
   import '@plantops/db';
   ```

2. Run:

   ```sh
   npx nx lint @plantops/admin-web
   ```

3. Expected failure from `@nx/enforce-module-boundaries`:

   > A project tagged with "app:admin-web" can only depend on libs tagged with
   > "scope:contracts", "scope:client", "scope:ui", "scope:web", "scope:config"

4. Remove the import; lint is green again.

## Frontend boundaries (Session 27, verified 2026-08-18)

Two more constraints, probed the same way — temporary import, run lint, remove:

| Probe | Result |
|---|---|
| `import '@plantops/iam-client'` in `libs/ui/src/index.ts` | ✗ *A project tagged with "scope:ui" can only depend on libs tagged with "scope:contracts"* |
| `import '@plantops/db'` in `libs/web-kit/src/index.ts` | ✗ *A project tagged with "scope:web" can only depend on libs tagged with "scope:contracts", "scope:client", "scope:ui"* |
| `import '@plantops/db'` in `apps/iam-api-e2e/src` (Session 38) | ✗ *A project tagged with "app:iam-api-e2e" can only depend on libs tagged with "scope:contracts"* |

The first is the one worth keeping honest. `libs/ui` is presentation: it takes
data and callbacks and returns markup, which is what makes it testable without a
server and reusable by the gatepass and visitor consoles. The moment a component
in there can call the IAM directly, that stops being true — and the failure is
silent, because the component still works.

## `scope:web` — a documented extension of the Doc 08 §2 table

Doc 08's table has six libs and no home for the browser-side *runtime*: the IAM
client wrapped in React providers, the token store, the session state, the
grants and permission hooks. Doc 09 §1 puts that behind `admin-web`, which was
right when `admin-web` was the only console — and Doc 00 §9 says it will not be.
Gatepass and visitor management sign in against the same IAM with the same
tokens, the same silent refresh and the same `usePermission`, so leaving it in an
app means the second console copies it.

`libs/web-kit` (tag `scope:web`) is therefore allowed to compose
`scope:client` + `scope:ui` + `scope:contracts`, and nothing else. Notably
absent: `scope:db` and `scope:auth`, so no browser bundle can reach the IAM's
tables or its NestJS guards.

## `app:iam-api-e2e` — the hardening battery (Session 38)

`apps/iam-api-e2e` drives a *served* `iam-api` over HTTP and opens its own
Postgres connections with `pg` directly, so it needs no lib but `contracts`, and
its allow-list says exactly that. Without an entry of its own it would fall
under `type:app` → `type:lib` alone, which permits `scope:db`.

The reason to close that is specific rather than tidy-minded. The battery's
`rls-isolation.e2e.ts` exists to prove that the *database* refuses to leak, as a
non-owning role, with policies forced. A suite that could
`import { applyRlsContext } from '@plantops/db'` would inevitably use it — and
would then be asserting that the helper sets three session variables correctly,
which is already covered by `libs/db`'s own unit tests, instead of that the
policies keyed on those variables actually filter. It sets them by hand for that
reason, and the boundary is what keeps the shortcut unavailable.

## Deviation from Doc 08 §2 (recorded intentionally, Session 1)

Doc 08's tag table gives `admin-web` only `type:app`. Nx evaluates **all**
matching `depConstraints` conjunctively, and an allow-list on `type:app` broad
enough to let `iam-api` reach `scope:db` would also let `admin-web` reach it —
the doc itself walks through this ambiguity. Following the doc's own rationale
for the extra `app:iam-api` tag ("depConstraints match on tags, and cannot
express 'exactly one project' without one"), `admin-web` carries an extra
identifying tag `app:admin-web` whose allow-list omits `scope:db` (and
`scope:auth`, which is server-side NestJS code per the Doc 08 consumer table).
The doc's net rule — admin-web importing `libs/db` must fail lint — is what is
enforced and tested.

Tags live in each project's `package.json` under the `nx` key (the Nx 23
TS-solution equivalent of `project.json` tags — this workspace setup style has
no per-project `project.json`).
