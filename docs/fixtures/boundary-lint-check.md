# Fixture note — module-boundary lint check (Session 1)

Doc 08 §2 requires that any project other than `iam-api` importing `libs/db`
fails `nx lint`. This was verified during Session 1 with a temporary import
and then removed, per the roadmap's acceptance criteria.

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
   > "scope:contracts", "scope:client", "scope:ui", "scope:config"

4. Remove the import; lint is green again.

## Deviation from Doc 08 §2 (recorded intentionally)

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
