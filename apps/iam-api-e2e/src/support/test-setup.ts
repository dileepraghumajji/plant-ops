/**
 * Per-worker setup: point `axios` at the instance global setup started.
 *
 * Only the Session 6 boot smoke test (`iam-api/iam-api.spec.ts`) uses axios;
 * the Session 38 battery uses `support/api.ts`, which wraps `fetch` and needs
 * no global state. Both read the same base URL, so a worker that somehow
 * started without it fails here with a message rather than at the first request
 * with `ECONNREFUSED localhost:80`.
 */

import axios from 'axios';
import { existsSync, readFileSync } from 'node:fs';
import { RUNTIME_FILE, type ApiRuntime } from './api-process';

module.exports = async function () {
  let baseUrl = process.env['E2E_BASE_URL'];

  if (baseUrl === undefined && existsSync(RUNTIME_FILE)) {
    const runtime = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) as ApiRuntime;
    baseUrl = runtime.baseUrl;
    process.env['E2E_BASE_URL'] = runtime.baseUrl;
    process.env['E2E_API_LOG'] = runtime.logPath;
  }

  if (baseUrl === undefined) {
    throw new Error(
      'No API instance was published by global setup. Run the suite through ' +
        '`npx nx e2e @plantops/iam-api-e2e`, which starts one.',
    );
  }

  axios.defaults.baseURL = baseUrl;
};
