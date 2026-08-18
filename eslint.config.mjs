import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          // Doc 08 §2 — boundary rules. Nx applies every matching constraint
          // (AND), so the untagged-project catch-all below does not weaken the
          // specific rules. libs/db is importable ONLY by iam-api: no other
          // sourceTag's allow-list names scope:db.
          depConstraints: [
            {
              sourceTag: 'app:iam-api',
              onlyDependOnLibsWithTags: [
                'scope:db',
                'scope:auth',
                'scope:contracts',
                'scope:client',
                'scope:config',
              ],
            },
            {
              sourceTag: 'app:admin-web',
              onlyDependOnLibsWithTags: [
                'scope:contracts',
                'scope:client',
                'scope:ui',
                'scope:web',
                'scope:config',
              ],
            },
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:lib'],
            },
            {
              sourceTag: 'scope:db',
              onlyDependOnLibsWithTags: ['scope:contracts'],
            },
            {
              sourceTag: 'scope:auth',
              onlyDependOnLibsWithTags: ['scope:contracts'],
            },
            {
              sourceTag: 'scope:client',
              onlyDependOnLibsWithTags: ['scope:contracts'],
            },
            {
              sourceTag: 'scope:ui',
              onlyDependOnLibsWithTags: ['scope:contracts'],
            },
            // `scope:web` — the browser-side runtime (`libs/web-kit`): the IAM
            // client wrapped in React providers, the token store, the grants
            // and permission hooks every console shares (Session 27).
            //
            // A documented extension of the Doc 08 §2 table, added because the
            // doc's `ui` row is "shared React components, tokens ← contracts"
            // and that boundary is worth keeping: presentation that cannot
            // reach an API stays reusable and testable without one. But the
            // *stateful* half — where tokens live, how a session ends, what the
            // subject may do — is equally shared by admin-web, gatepass-web and
            // visitor-web, and putting it in an app would mean the second
            // console copies it. So it is a lib of its own, allowed to compose
            // `client` + `ui` + `contracts` and nothing else. Notably absent:
            // `scope:db` and `scope:auth`, so no browser bundle can reach the
            // IAM's tables or its NestJS guards.
            {
              sourceTag: 'scope:web',
              onlyDependOnLibsWithTags: [
                'scope:contracts',
                'scope:client',
                'scope:ui',
              ],
            },
            {
              sourceTag: 'scope:config',
              onlyDependOnLibsWithTags: ['scope:contracts'],
            },
            {
              sourceTag: 'scope:contracts',
              onlyDependOnLibsWithTags: [],
            },
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
  {
    // ── RLS context provenance gate (Doc 07 §5, Invariant I0/I5) ──────────
    //
    // The tenant, subject and platform flag that RLS keys off must come only
    // from verified JWT claims. `libs/db/src/rls-context.ts` enforces that in
    // the type system — its `VerifiedClaims` brand is unforgeable, so a plain
    // `req.body` will not compile. This rule closes the other door: writing
    // the session variables directly in SQL, which no type can see.
    //
    // One interceptor doing `set_config('app.current_client_id', req.body...)`
    // silently repoints tenant isolation, and the database then enforces the
    // wrong tenant perfectly. The failure is invisible in tests that only ever
    // use one tenant, which is why this is a lint error and not a convention.
    files: ['**/*.ts', '**/*.tsx'],
    // Depth-independent globs on purpose: each project re-exports this config
    // from its own `eslint.config.mjs`, and flat-config `ignores` resolve
    // relative to *that* file. A workspace-root path like
    // `libs/db/src/migrations/**` silently matches nothing when linting is run
    // from inside `libs/db`, which is the whole project the rule protects.
    ignores: [
      // The one legitimate implementation of the setter.
      '**/rls-context.ts',
      // Migrations legitimately set the context to write their own seed data,
      // since FORCE'd policies apply to the migration role too (Doc 07 §5.1).
      '**/migrations/**',
      // Test plumbing and specs build fixtures across tenants deliberately.
      '**/testing/**',
      '**/*.spec.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Literal[value=/set_config\\s*\\(\\s*['\"]?app\\.(current_client_id|current_user_id|is_platform_admin)/]",
          message:
            'Do not set the RLS context directly. Use applyRlsContext() from @plantops/db, ' +
            'which accepts only verified JWT claims (Doc 07 §5 PROVENANCE).',
        },
        {
          selector:
            "TemplateElement[value.raw=/set_config\\s*\\(\\s*['\"]?app\\.(current_client_id|current_user_id|is_platform_admin)/]",
          message:
            'Do not set the RLS context directly. Use applyRlsContext() from @plantops/db, ' +
            'which accepts only verified JWT claims (Doc 07 §5 PROVENANCE).',
        },
      ],
    },
  },
];
