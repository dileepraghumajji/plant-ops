
const { readFileSync } = require('fs');
const { join } = require('path');

// The integration specs need a real Postgres and read DATABASE_DIRECT_URL.
// Loading the workspace `.env` here means `nx test @plantops/db` picks up the
// same connection the migration CLI uses; without a `.env` they simply skip.
require('dotenv').config({ path: join(__dirname, '..', '..', '.env') });

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

module.exports = {
  displayName: '@plantops/db',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Entity decorators emit `design:type` metadata — the polyfill must be in
  // place before any spec imports an entity module.
  setupFiles: ['reflect-metadata'],
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // The integration suites each drop and rebuild the `iam` schema of one
  // shared database. Parallel workers would interleave those rebuilds; serial
  // execution costs nothing here, since the unit specs are pure metadata.
  maxWorkers: 1,
  coverageDirectory: 'test-output/jest/coverage',
};
