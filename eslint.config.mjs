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
];
