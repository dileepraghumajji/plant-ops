const { readFileSync } = require('fs');
const { join } = require('path');

// The RLS-context integration spec needs a real Postgres and reads
// DATABASE_URL / DATABASE_DIRECT_URL. Loading the workspace `.env` here means
// `nx test @plantops/iam-api` picks up the same connection the migration CLI
// uses; without a `.env` that suite skips and the rest still runs.
require('dotenv').config({ path: join(__dirname, '..', '..', '.env') });

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

module.exports = {
  displayName: '@plantops/iam-api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Nest's DI reads `design:paramtypes`; the polyfill has to be loaded before
  // any decorated class is evaluated.
  setupFiles: ['reflect-metadata'],
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // The RLS suite rebuilds the `iam` schema of one shared database, and the
  // HTTP suites each bind a port. Serial execution keeps both deterministic.
  maxWorkers: 1,
  coverageDirectory: 'test-output/jest/coverage',
};
