/**
 * Applies the release's bundled application manifests (roadmap Session 43,
 * Doc 11 §6.3, Doc 02 §2).
 *
 *   npm run manifest:apply                          every manifest in deploy/manifests
 *   npm run manifest:apply -- --dry-run             report what would change
 *   npm run manifest:apply -- --dir ./some/other    a different set
 *   npm run manifest:apply -- --api-url https://iam.staging.internal
 *
 * ## What changed, and why
 *
 * This replaces `tools/seed-iam-manifest.ts`, which did exactly this for one
 * file. The reason it is now plural is Doc 11 §6.3: on a single-tenant
 * installation nobody is going to open a platform console and upload a
 * manifest, so **the release** has to be the thing that registers applications
 * — at install, and again on every upgrade. A client whose permission catalog
 * has drifted from the product is one whose every support ticket afterwards is
 * guesswork; re-applying on upgrade quietly re-converges it.
 *
 * `deploy/manifests/` is that set. It ships inside the images (see
 * `apps/iam-api/Dockerfile`), so a stack always carries the catalog its own
 * version was tested with.
 *
 * ## It is still the ordinary endpoint, and that is the point
 *
 * Nothing here touches the database. Every manifest goes through
 * `POST /iam/applications/:id/manifest` — the same call the console makes, with
 * the same validation, the same platform-admin check, the same audit record and
 * the same single transaction (Doc 02 §14: "there is no privileged bypass
 * path"). The IAM's own catalog included: Session 23's dogfooding property is
 * that the console's menu is built by the code path every other application
 * uses, and an installer that wrote rows directly would quietly retire it.
 *
 * ## Convergence, not synchronisation
 *
 * The endpoint is an upsert keyed by `(application, key)` (Doc 02 §2), and keys
 * absent from the manifest are **deactivated, never deleted** (Doc 02 §7). So
 * re-applying is safe in both directions: a permission someone added by hand
 * goes inactive rather than vanishing — grants that referenced it are still
 * auditable — and anything they edited is set back to what the release says.
 *
 * ## Idempotence
 *
 * A second run reports "no changes" and writes no audit record, because the
 * endpoint computes a diff and does nothing when the diff is empty. That is
 * what makes running this on every upgrade free rather than noisy.
 */

import type { ApplicationManifest, ManifestUpsertResponse } from '@plantops/contracts';
import { config as loadDotenv } from 'dotenv';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Two candidates, because this file runs from two places.
 *
 * In the workspace it sits in `tools/` and the manifests are in
 * `deploy/manifests/`. In the migration-runner image both are copied flat into
 * one directory, because an image has no repository layout to preserve. Looking
 * for the sibling directory first and the sibling *file set* second means the
 * same script works in both without an argument nobody would remember to pass.
 */
function defaultManifestDir(): string {
  const candidates = [join(HERE, '..', 'deploy', 'manifests'), join(HERE, 'manifests'), HERE];
  for (const candidate of candidates) {
    if (existsSync(candidate) && manifestFilesIn(candidate).length > 0) return candidate;
  }
  return candidates[0] as string;
}

/** `*.manifest.json`, sorted, so a run is reproducible and reads in order. */
function manifestFilesIn(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.manifest.json'))
    .sort();
}

/**
 * The IAM's own key, which is the one application this tool must never create.
 *
 * Migration 0017 registers it, along with the very permissions that authorize
 * this upload. If it is missing, creating the row here would produce an
 * application with no catalog and a caller who still cannot upload one — a
 * worse place to debug from than a message naming the migration.
 */
const IAM_APPLICATION_KEY = 'iam';

const USAGE = `Usage:
  apply-manifests [options]

Applies every *.manifest.json in the manifest directory through
POST /iam/applications/:id/manifest, in filename order.

Options:
  --dir <path>           where the manifests are (default: deploy/manifests)
  --api-url <url>        the IAM to apply to (default: $IAM_API_URL, or
                         http://localhost:$PORT, or http://localhost:3000)
  --account-key <key>    platform service account (default: ${PLATFORM_SERVICE_ACCOUNT_KEY})
  --dry-run              report the diff each manifest would apply, apply none

The account secret is read from PLATFORM_BOOTSTRAP_SECRET (or
IAM_ACCOUNT_SECRET), never from an argument.`;

interface Options extends ApiTarget {
  dir: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) throw new Error(`${USAGE}\n\nUnexpected: ${token}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[token.slice(2)] = true;
    } else {
      flags[token.slice(2)] = next;
      i += 1;
    }
  }

  const unknown = Object.keys(flags).filter(
    (name) => !['dir', 'api-url', 'account-key', 'dry-run'].includes(name),
  );
  if (unknown.length > 0) {
    throw new Error(`${USAGE}\n\nUnknown option(s): ${unknown.join(', ')}`);
  }

  return {
    dir: typeof flags['dir'] === 'string' ? resolve(flags['dir']) : defaultManifestDir(),
    apiUrl: stripTrailingSlash(
      typeof flags['api-url'] === 'string' ? flags['api-url'] : defaultApiUrl(),
    ),
    accountKey:
      typeof flags['account-key'] === 'string'
        ? flags['account-key']
        : PLATFORM_SERVICE_ACCOUNT_KEY,
    accountSecret: accountSecretFromEnv(),
    dryRun: flags['dry-run'] === true,
  };
}

/** One line an operator can read, per manifest. */
function summarise(result: ManifestUpsertResponse): string {
  const { permissions, nav, menu_permissions: mappings } = result.diff;
  return (
    `permissions +${permissions.created.length} ~${permissions.updated.length} ` +
    `-${permissions.deactivated.length}; ` +
    `nav +${nav.created.length} ~${nav.updated.length} -${nav.deactivated.length}; ` +
    `menu permissions +${mappings.mapped.length} -${mappings.unmapped.length}`
  );
}

async function applyOne(
  options: Options,
  token: string,
  file: string,
): Promise<boolean> {
  const manifest = JSON.parse(
    readFileSync(join(options.dir, file), 'utf8'),
  ) as ApplicationManifest;

  const application = await findApplication(options, token, manifest.key);

  if (application === null) {
    if (manifest.key === IAM_APPLICATION_KEY) {
      throw new Error(
        `No application is registered with the key "${IAM_APPLICATION_KEY}". Run ` +
          'the migrations first — migration 0017 registers it along with the ' +
          'permissions that authorize this upload.',
      );
    }
    // Every other application in the release set is created here. On a
    // single-tenant install this is the whole of "register the app", and it is
    // the step Doc 11 §6.3 exists to take away from a human.
    const created = await call<{ id: string; key: string }>(
      options,
      token,
      'POST',
      '/iam/applications',
      { key: manifest.key, name: manifest.name },
    );
    console.log(`  registered application "${manifest.key}" (${created.id})`);
    return applyTo(options, token, created.id, manifest, file);
  }

  return applyTo(options, token, application.id, manifest, file);
}

async function applyTo(
  options: Options,
  token: string,
  applicationId: string,
  manifest: ApplicationManifest,
  file: string,
): Promise<boolean> {
  const query = options.dryRun ? '?dryRun=true' : '';
  const result = await call<ManifestUpsertResponse>(
    options,
    token,
    'POST',
    `/iam/applications/${applicationId}/manifest${query}`,
    manifest,
  );

  if (!result.changed) {
    console.log(`  ${file}: no changes`);
    return false;
  }
  console.log(`  ${file}: ${options.dryRun ? 'would apply' : 'applied'} — ${summarise(result)}`);
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const files = manifestFilesIn(options.dir);

  if (files.length === 0) {
    throw new Error(
      `No *.manifest.json files in ${options.dir}.\n` +
        'A release with no manifests would silently leave a catalog unmanaged, ' +
        'so this is an error rather than a no-op.',
    );
  }

  console.log(
    `applying ${files.length} manifest(s) from ${options.dir} → ${options.apiUrl} ` +
      `as ${options.accountKey}${options.dryRun ? ' (dry run)' : ''}`,
  );

  const token = await authenticate(options);

  let changed = 0;
  for (const file of files) {
    if (await applyOne(options, token, file)) changed += 1;
  }

  console.log(
    changed === 0
      ? 'Catalog already matches the release — nothing to do.'
      : `${changed} of ${files.length} manifest(s) ${options.dryRun ? 'would change' : 'changed'}.`,
  );
}

loadDotenv();

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
