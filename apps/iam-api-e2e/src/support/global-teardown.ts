/**
 * Stops the API instance `global-setup.ts` started.
 *
 * The pid comes from `globalThis` when the two ran in the same process, and
 * from the runtime file otherwise — an instance left alive would hold the
 * database pool and the Redis connection, and the *next* run's `freePort()`
 * would happily pick a different port and leave this one running forever.
 */

import { existsSync, readFileSync } from 'node:fs';
import { RUNTIME_FILE, stopApi, type ApiRuntime } from './api-process';

declare const globalThis: { __E2E_API_PID__?: number } & typeof global;

module.exports = async function () {
  let pid = globalThis.__E2E_API_PID__;

  if (pid === undefined && existsSync(RUNTIME_FILE)) {
    pid = (JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) as ApiRuntime).pid;
  }

  await stopApi(pid);
  console.log('\niam-api stopped.\n');
};
