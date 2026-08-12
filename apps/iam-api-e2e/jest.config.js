const { readFileSync } = require('fs');
const { join } = require('path');

// The served app reads the workspace `.env` too; loading it here keeps the
// suite's PORT in step with the one `nx serve` binds.
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
  coverageDirectory: 'test-output/jest/coverage',
};
