const { readFileSync } = require('fs');
const { join } = require('path');

// The API this suite drives is started by `src/support/global-setup.ts`, which
// reads the same workspace `.env` for its database and Redis URLs. Loading it
// here too is what lets `support/database.ts` open its own connections from
// inside a worker.
require('dotenv').config({ path: join(__dirname, '..', '..', '.env') });

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

// Plain `.js`, not `.cts`. The `@nx/jest:jest` executor passes this file to
// Jest by absolute path from the workspace root, and Jest hands a TypeScript
// config to ts-node — which resolves a tsconfig from the *working directory*,
// i.e. the root `tsconfig.json`, whose inherited `composite: true` then demands
// an explicit `rootDir` for a file outside its own program and fails with
// TS5011 before a single test runs. A `.js` config never enters that path.
// (`apps/iam-api` escapes it only because its inferred target runs Jest with
// the project directory as the working directory.)
module.exports = {
  displayName: '@plantops/iam-api-e2e',
  preset: '../../jest.preset.js',
  globalSetup: '<rootDir>/src/support/global-setup.ts',
  globalTeardown: '<rootDir>/src/support/global-teardown.ts',
  setupFiles: ['<rootDir>/src/support/test-setup.ts'],
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],

  // Session 38's battery files are `*.e2e.ts`, which the Nx preset's default
  // `testMatch` (spec/test only) does not pick up. Both patterns are listed so
  // the Session 6 boot smoke test (`iam-api.spec.ts`) keeps running too.
  testMatch: [
    '<rootDir>/src/**/*.e2e.ts',
    '<rootDir>/src/**/?(*.)+(spec|test).[jt]s?(x)',
  ],

  // **Serial, and not negotiable.** Every file in this battery seeds tenants in
  // one shared Postgres and drives one shared API process. Two workers would
  // interleave their fixtures' purges, and the failures would be
  // non-deterministic — the worst kind for a suite whose job is to be a
  // regression wall. Each file still uses its own slug prefix, so the
  // serialisation is belt-and-braces rather than the only thing keeping them
  // apart.
  maxWorkers: 1,

  // Seeding two tenants over HTTP costs a handful of argon2id hashes, and the
  // load smoke deliberately runs hundreds of requests. The default 5 s would
  // fail on the fixture rather than on anything under test.
  testTimeout: 180_000,

  coverageDirectory: 'test-output/jest/coverage',
};
