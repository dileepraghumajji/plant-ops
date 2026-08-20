/**
 * Brings up the one API instance the whole battery drives.
 *
 * The instance's coordinates travel to the workers two ways, because Jest
 * offers no single reliable one: `process.env` (which workers inherit, and
 * which `test-setup.ts` reads) and a JSON file (which survives a worker that
 * was started before this ran, and which is also what makes a failed run
 * debuggable afterwards — the log path is in it).
 *
 * See `api-process.ts` for why the suite starts the app itself rather than
 * waiting on `nx serve`.
 */

import { writeFileSync } from 'node:fs';
import { RUNTIME_FILE, startApi } from './api-process';

declare const globalThis: { __E2E_API_PID__?: number } & typeof global;

module.exports = async function () {
  const { runtime } = await startApi();

  writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2));
  process.env['E2E_BASE_URL'] = runtime.baseUrl;
  process.env['E2E_API_LOG'] = runtime.logPath;

  // Teardown runs in this same process, so the handle can simply be parked.
  globalThis.__E2E_API_PID__ = runtime.pid;

  console.log(`\niam-api under test: ${runtime.baseUrl} (log: ${runtime.logPath})\n`);
};
