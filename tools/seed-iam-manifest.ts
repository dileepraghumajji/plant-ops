/**
 * Seeds the IAM's own catalog through the IAM's own API (Doc 02 §2, §14).
 *
 *   npm run manifest:seed-iam
 *   npm run manifest:seed-iam -- --api-url https://iam.staging.internal
 *
 * ## What this is for, given that migration 0017 exists
 *
 * The permissions the IAM gates itself with are seeded by migration 0017,
 * because the call that would otherwise create them is gated on one of them —
 * the circle that migration's header sets out. What a migration must **not** do
 * is keep going: navigation, menu-permission mappings and every later edit to
 * this catalog belong to `POST /iam/applications/:id/manifest`, the same
 * endpoint every other application uses, so that the IAM's own registry entry is
 * built by the code paths it asks everyone else to trust (Doc 02 §14 — "no
 * privileged bypass path"; Doc 09 §1 — "the admin console is itself an
 * application in the registry, dogfooding the nav system").
 *
 * So: run the migrations, start the API, run this. Afterwards the admin console
 * has a menu, and that menu was produced by the same upsert-and-diff a customer
 * application gets.
 *
 * ## It is the ordinary upload with the arguments already known
 *
 * The file is `tools/iam-manifest.json` rather than an argument, and the
 * application is never created — 0017 has already registered `iam`, and a
 * `--create` here would mean the seed could quietly register a *second* IAM
 * under a mistyped key. Everything else is `tools/upload-manifest.ts`, which is
 * why both call the same client (`tools/iam-api-client.ts`).
 *
 * Idempotent, because the endpoint is: running it twice prints "no changes".
 */

import type { ApplicationManifest, ManifestUpsertResponse } from '@plantops/contracts';
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accountSecretFromEnv,
  authenticate,
  call,
  defaultApiUrl,
  findApplication,
  PLATFORM_SERVICE_ACCOUNT_KEY,
  stripTrailingSlash,
  type ApiTarget,
} from './iam-api-client.js';

/** The document this tool exists to upload. Beside the script, on purpose. */
const MANIFEST_FILE = join(dirname(fileURLToPath(import.meta.url)), 'iam-manifest.json');

const USAGE = `Usage:
  seed-iam-manifest [--api-url <url>] [--account-key <key>]

Uploads tools/iam-manifest.json — the IAM's own permission and navigation
catalog — through POST /iam/applications/:id/manifest.

Run the migrations first: the "iam" application and its permissions are seeded
by migration 0017, without which the platform account cannot authorize this
call. The account secret is read from PLATFORM_BOOTSTRAP_SECRET (or
IAM_ACCOUNT_SECRET), never from an argument.`;

function parseArgs(argv: readonly string[]): ApiTarget {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    const next = argv[i + 1];
    if (!token.startsWith('--') || next === undefined || next.startsWith('--')) {
      throw new Error(`${USAGE}\n\nUnexpected: ${token}`);
    }
    flags[token.slice(2)] = next;
    i += 1;
  }

  return {
    apiUrl: stripTrailingSlash(flags['api-url'] ?? defaultApiUrl()),
    accountKey: flags['account-key'] ?? PLATFORM_SERVICE_ACCOUNT_KEY,
    accountSecret: accountSecretFromEnv(),
  };
}

async function main(): Promise<void> {
  const target = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(
    readFileSync(MANIFEST_FILE, 'utf8'),
  ) as ApplicationManifest;

  console.log(`seeding "${manifest.key}" → ${target.apiUrl} as ${target.accountKey}`);

  const token = await authenticate(target);
  const application = await findApplication(target, token, manifest.key);

  // Deliberately not created here. If it is missing, the migration that seeds
  // the permissions this very call is authorized by has not run — and creating
  // the row would produce an application with no catalog and a caller who still
  // cannot upload one, which is a worse place to debug from than this message.
  if (application === null) {
    throw new Error(
      `No application is registered with the key "${manifest.key}". Run the ` +
        'migrations first (npm run migration:run) — migration 0017 registers it ' +
        'along with the permissions that authorize this upload.',
    );
  }

  const result = await call<ManifestUpsertResponse>(
    target,
    token,
    'POST',
    `/iam/applications/${application.id}/manifest`,
    manifest,
  );

  if (!result.changed) {
    console.log('No changes — the catalog already matches the manifest.');
    return;
  }

  const { permissions, nav, menu_permissions: mappings } = result.diff;
  console.log(
    `Upserted: permissions +${permissions.created.length} ~${permissions.updated.length} ` +
      `-${permissions.deactivated.length}; nav +${nav.created.length} ` +
      `~${nav.updated.length} -${nav.deactivated.length}; ` +
      `menu permissions +${mappings.mapped.length} -${mappings.unmapped.length}`,
  );
}

loadDotenv();

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
