/**
 * Manifest upload tool (Doc 02 §2, Doc 08 §1 — "scripts (seed, manifest upload,
 * key rotation)").
 *
 *   npm run manifest:upload -- ./gatepass.manifest.json
 *   npm run manifest:upload -- ./gatepass.manifest.json --create
 *   npm run manifest:upload -- ./iam.manifest.json --api-url https://iam.staging.internal
 *
 * ## Why a tool at all, when the endpoint is one POST
 *
 * Doc 02 §2 makes the manifest the unit of registration precisely so the catalog
 * is "declarative and repeatable across environments". Repeatable means the same
 * file lands in dev, staging and production by the same command — not by three
 * curl invocations that differ in a token, a base URL, and whether the
 * application row exists yet. The three steps this performs (exchange
 * credentials, find or create the application, upsert) are the whole of what
 * "register this app here" means, and they are the same three every time.
 *
 * ## It speaks HTTP, not SQL
 *
 * Nothing here touches the database. A seeding script with its own connection
 * would bypass the validation, the platform-admin check and the audit record
 * that the endpoint applies — so the row it wrote would be one no API could have
 * produced, in a catalog whose trail has a gap where the change was. Talking to
 * the running API means an upload against staging is the same operation an
 * operator performs in the console (Doc 09 §2.1), with the same result.
 *
 * That is also why the target is a URL rather than an environment name: the tool
 * has no idea which database `https://iam.staging.internal` is in front of, and
 * does not need one.
 *
 * ## Credentials
 *
 * The platform bootstrap service account, by default — the identity migration
 * 0011 seeds, and (before Session 15) the only platform subject there is. Its
 * secret comes from `PLATFORM_BOOTSTRAP_SECRET` in the environment, never from
 * an argument: a secret in `argv` is a secret in the shell history and in every
 * process listing on the box.
 *
 * Since Session 23 these routes are gated on `iam.platform.*`, so any service
 * account holding those permissions works — hence `--account-key`. The
 * bootstrap account holds them from migration 0017.
 *
 * The HTTP half — the error shape, the token exchange, the application lookup —
 * lives in `tools/iam-api-client.ts`, shared with `seed-iam-manifest.ts`, which
 * is this tool with its arguments already known.
 */

import type {
  ApplicationDTO,
  ApplicationManifest,
  ManifestDiff,
  ManifestUpsertResponse,
} from '@plantops/contracts';
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import {
  type ApiTarget,
  accountSecretFromEnv,
  authenticate,
  call,
  defaultApiUrl,
  findApplication,
  PLATFORM_SERVICE_ACCOUNT_KEY,
  stripTrailingSlash,
} from './iam-api-client.js';

const USAGE = `Usage:
  upload-manifest <file.json> [options]

Options:
  --api-url <url>        the IAM to upload to (default: $IAM_API_URL, or
                         http://localhost:$PORT, or http://localhost:3000)
  --account-key <key>    platform service account (default: ${PLATFORM_SERVICE_ACCOUNT_KEY})
  --create               register the application if its key is not known yet

The account secret is read from PLATFORM_BOOTSTRAP_SECRET (or
IAM_ACCOUNT_SECRET), never from an argument.`;

type Flags = Record<string, string | true>;

interface Options extends ApiTarget {
  file: string;
  create: boolean;
}

// ── arguments and environment ────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): Options {
  const [file, ...rest] = argv;
  if (file === undefined || file.startsWith('--')) {
    throw new Error(`${USAGE}\n\nMissing the manifest file.`);
  }

  const flags: Flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith('--')) throw new Error(`${USAGE}\n\nUnexpected: ${token}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[token.slice(2)] = true;
    } else {
      flags[token.slice(2)] = next;
      i += 1;
    }
  }

  return {
    file,
    apiUrl: stripTrailingSlash(
      typeof flags['api-url'] === 'string' ? flags['api-url'] : defaultApiUrl(),
    ),
    accountKey:
      typeof flags['account-key'] === 'string'
        ? flags['account-key']
        : PLATFORM_SERVICE_ACCOUNT_KEY,
    accountSecret: accountSecretFromEnv(),
    create: flags['create'] === true,
  };
}

/**
 * Reads the manifest and checks only what this tool itself needs.
 *
 * `key` and `name`, because they are what finds (or creates) the application
 * before the upload. Everything else is the server's to validate, and
 * duplicating `manifest.dto.ts` here would produce a second, quietly diverging
 * definition of what a valid manifest is — the exact failure the shared zod
 * schemas in `apps/iam-api/src/registry/dto` exist to prevent. A file this tool
 * accepts and the API rejects is fine; the reverse would not be.
 */
function readManifest(path: string): ApplicationManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${path} is not readable JSON: ${error instanceof Error ? error.message : error}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a manifest object`);
  }

  const manifest = parsed as Partial<ApplicationManifest>;
  if (typeof manifest.key !== 'string' || typeof manifest.name !== 'string') {
    throw new Error(`${path} must have a string "key" and "name" (Doc 02 §2)`);
  }

  return manifest as ApplicationManifest;
}

// ── output ───────────────────────────────────────────────────────────────────

function printDiff(diff: ManifestDiff): void {
  const section = (label: string, keys: readonly string[]): void => {
    if (keys.length > 0) console.log(`  ${label.padEnd(24)} ${keys.join(', ')}`);
  };

  section('application changed', diff.application.changed);
  section('permissions created', diff.permissions.created);
  section('permissions updated', diff.permissions.updated);
  section('permissions retired', diff.permissions.deactivated);
  section('nav created', diff.nav.created);
  section('nav updated', diff.nav.updated);
  section('nav retired', diff.nav.deactivated);

  for (const change of diff.menu_permissions.mapped) {
    console.log(`  ${'mapped'.padEnd(24)} ${change.nav_key} ← ${change.permission_keys.join(', ')}`);
  }
  for (const change of diff.menu_permissions.unmapped) {
    console.log(
      `  ${'unmapped'.padEnd(24)} ${change.nav_key} ✗ ${change.permission_keys.join(', ')}`,
    );
  }
}

// ── the three steps ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = readManifest(options.file);

  console.log(
    `manifest "${manifest.key}" → ${options.apiUrl} as ${options.accountKey}`,
  );

  const token = await authenticate(options);

  let application = await findApplication(options, token, manifest.key);
  if (application === null) {
    if (!options.create) {
      throw new Error(
        `No application is registered with the key "${manifest.key}". Pass ` +
          '--create to register it as part of this upload.',
      );
    }
    application = await call<ApplicationDTO>(options, token, 'POST', '/iam/applications', {
      key: manifest.key,
      name: manifest.name,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
    });
    console.log(`created application ${application.id}`);
  }

  const result = await call<ManifestUpsertResponse>(
    options,
    token,
    'POST',
    `/iam/applications/${application.id}/manifest`,
    manifest,
  );

  if (!result.changed) {
    console.log('No changes — the catalog already matches this manifest.');
    return;
  }

  console.log('Upserted:');
  printDiff(result.diff);
}

loadDotenv();

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
