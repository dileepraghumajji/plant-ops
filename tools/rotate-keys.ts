/**
 * Key-rotation tool (Doc 03 §1).
 *
 *   npm run keys:rotate -- status
 *   npm run keys:rotate -- publish
 *   npm run keys:rotate -- activate --kid <kid> --published-at <iso> --private-key-file <path>
 *   npm run keys:rotate -- retire   --kid <kid> --deactivated-at <iso>
 *
 * Rotation is three deploys, not one command, because Doc 03 §1 requires a wait
 * between them: a public key must reach every consumer's JWKS cache *before* it
 * signs anything, and the key it replaces must stay published until the last
 * token it signed has expired. A single command cannot span those waits, so
 * this one performs a step, prints the environment for the next deploy, and
 * tells you when the following step becomes safe.
 *
 * The ordering rules themselves live in `@plantops/config` (`key-rotation.ts`)
 * where they are unit-tested; this file is argument parsing, key generation and
 * output. It refuses out-of-order steps because that module does.
 *
 * ## What it prints, and what it does not
 *
 * It writes environment *fragments* to stdout and never touches `.env`,
 * because the real target is a secret store. The one thing it writes to disk is
 * the new private key, to a file you name, with `0600` — the alternative is a
 * private key in shell history and CI logs.
 *
 * Between `publish` and `activate` the new private key must be held somewhere
 * that is *not* `JWT_PRIVATE_KEY`: a key in that variable is a key that signs,
 * and signing before propagation is exactly the failure the ordering prevents.
 *
 * Lives in `tools/` rather than in the app for the reason `migrate.ts` gives:
 * `tools/` is outside the boundary graph, so it may import both `config` and
 * anything else it needs.
 */

import {
  RotationOrderError,
  planActivate,
  planPublish,
  planRetire,
  serializeRetiredPublicKeys,
  type GeneratedKeyPair,
  type KeyEnvState,
  type RotationPlan,
} from '@plantops/config';
import { JWT_MIN_RSA_KEY_BITS } from '@plantops/contracts';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

type Command = 'status' | 'publish' | 'activate' | 'retire';

const COMMANDS: readonly Command[] = ['status', 'publish', 'activate', 'retire'];

const USAGE = `Usage:
  rotate-keys status
  rotate-keys publish  [--kid <kid>] [--private-key-file <path>]
  rotate-keys activate --kid <kid> --published-at <iso8601>
                       --private-key-file <path> [--force]
  rotate-keys retire   --kid <kid> --deactivated-at <iso8601> [--force]

Steps run in that order, one deploy each (Doc 03 §1).`;

// ── argument handling ────────────────────────────────────────────────────────

type Flags = Record<string, string | true>;

function parseArgs(argv: readonly string[]): { command: Command; flags: Flags } {
  const [command, ...rest] = argv;
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`${USAGE}\n\nUnknown command: ${command ?? '<nothing>'}`);
  }

  const flags: Flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith('--')) throw new Error(`${USAGE}\n\nUnexpected: ${token}`);
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { command: command as Command, flags };
}

function requireFlag(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string') {
    throw new Error(`${USAGE}\n\nMissing required --${name}`);
  }
  return value;
}

function requireDate(flags: Flags, name: string): Date {
  const raw = requireFlag(flags, name);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--${name} is not a valid ISO-8601 timestamp: ${raw}`);
  }
  return date;
}

// ── environment ──────────────────────────────────────────────────────────────

/**
 * Reads the four key variables straight from `process.env`, not through
 * `loadEnv()`.
 *
 * Deliberate: a rotation is run *against* an environment, often a half-migrated
 * one, and `loadEnv()` would refuse to parse anything if an unrelated variable
 * — a database URL, the bootstrap secret — were absent from the operator's
 * shell. The four values this tool touches are validated here instead.
 */
function readKeyEnv(): KeyEnvState {
  const signingKeyId = process.env['JWT_SIGNING_KEY_ID'];
  const privateKey = process.env['JWT_PRIVATE_KEY'];
  const publicKey = process.env['JWT_PUBLIC_KEY'];
  if (!signingKeyId || !publicKey) {
    throw new Error(
      'JWT_SIGNING_KEY_ID and JWT_PUBLIC_KEY must be set to the environment ' +
        'being rotated. Export them (or point dotenv at the right .env) first.',
    );
  }

  return {
    signingKeyId,
    // The private key is only needed to be carried through unchanged; a step
    // that does not alter it does not require it to be present.
    privateKey: unescapeNewlines(privateKey ?? ''),
    publicKey: unescapeNewlines(publicKey),
    retiredPublicKeys: parseRetired(process.env['JWT_RETIRED_PUBLIC_KEYS']),
  };
}

function parseRetired(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JWT_RETIRED_PUBLIC_KEYS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('JWT_RETIRED_PUBLIC_KEYS must be a JSON object of kid → PEM');
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, string>).map(([kid, pem]) => [
      kid,
      unescapeNewlines(pem),
    ]),
  );
}

const unescapeNewlines = (value: string) => value.replace(/\\n/g, '\n').trim();

// ── key generation ───────────────────────────────────────────────────────────

/**
 * A `kid` that sorts by creation and cannot collide.
 *
 * The date prefix is for the operator reading a JWKS during an incident; the
 * random suffix is what actually guarantees uniqueness. A sequential `key-2`
 * would collide the moment two environments rotate independently.
 */
function generateKid(): string {
  const day = new Date().toISOString().slice(0, 10);
  return `k${day.replace(/-/g, '')}-${randomBytes(4).toString('hex')}`;
}

function generateKeyPair(kid: string): GeneratedKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: JWT_MIN_RSA_KEY_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { kid, privateKey, publicKey };
}

/** Writes a private key `0600`. Never to stdout — that is a log, and CI keeps logs. */
function writePrivateKey(path: string, pem: string): void {
  writeFileSync(path, pem, { encoding: 'utf8', mode: 0o600 });
}

function readPrivateKey(path: string): string {
  const pem = readFileSync(path, 'utf8').trim();
  if (!pem.includes('PRIVATE KEY')) {
    throw new Error(`${path} does not contain a PEM private key`);
  }
  return pem;
}

// ── output ───────────────────────────────────────────────────────────────────

const escapeNewlines = (pem: string) => pem.replace(/\r?\n/g, '\\n');

function printPlan(plan: RotationPlan, extra: Record<string, string> = {}): void {
  console.log(`\n${plan.summary}\n`);
  console.log('Set these in the secret store, then deploy:\n');

  console.log(`JWT_SIGNING_KEY_ID=${plan.next.signingKeyId}`);
  console.log(`JWT_PUBLIC_KEY="${escapeNewlines(plan.next.publicKey)}"`);
  console.log(
    `JWT_RETIRED_PUBLIC_KEYS=${serializeRetiredPublicKeys(plan.next.retiredPublicKeys)}`,
  );
  for (const [key, value] of Object.entries(extra)) {
    console.log(`${key}=${value}`);
  }

  if (plan.nextStep !== null && plan.nextStepEarliestAt !== null) {
    console.log(
      `\nNext step: \`${plan.nextStep}\`, not before ` +
        `${plan.nextStepEarliestAt.toISOString()}.`,
    );
  } else {
    console.log('\nRotation complete.');
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

function status(current: KeyEnvState): void {
  console.log(`signing kid : ${current.signingKeyId}`);
  const retained = Object.keys(current.retiredPublicKeys);
  console.log(
    `also in JWKS: ${retained.length > 0 ? retained.join(', ') : '(none)'}`,
  );
  console.log(
    '\nA kid listed above is either awaiting activation (published, not yet ' +
      'signing) or awaiting removal (retired, still verifying). JWKS cannot ' +
      'distinguish them — the deploy history can.',
  );
}

function publish(current: KeyEnvState, flags: Flags): void {
  const kid = typeof flags['kid'] === 'string' ? flags['kid'] : generateKid();
  const keyFile =
    typeof flags['private-key-file'] === 'string'
      ? flags['private-key-file']
      : `${kid}.private.pem`;

  const incoming = generateKeyPair(kid);
  const plan = planPublish({ current, incoming });

  writePrivateKey(keyFile, incoming.privateKey);

  printPlan(plan);
  console.log(
    `\nThe new private key is in ${keyFile} (mode 0600). It must NOT go into ` +
      'JWT_PRIVATE_KEY yet — a key in that variable is a key that signs, and ' +
      'signing before propagation is the failure this ordering prevents. Keep ' +
      'it out of band until the `activate` step.\n' +
      `\nThen run:\n  rotate-keys activate --kid ${kid} --published-at ` +
      `${new Date().toISOString()} --private-key-file ${keyFile}`,
  );
}

function activate(current: KeyEnvState, flags: Flags): void {
  const kid = requireFlag(flags, 'kid');
  const plan = planActivate({
    current,
    kid,
    privateKey: readPrivateKey(requireFlag(flags, 'private-key-file')),
    publishedAt: requireDate(flags, 'published-at'),
    force: flags['force'] === true,
  });

  printPlan(plan, { JWT_PRIVATE_KEY: '<contents of the private key file>' });
  console.log(
    `\nJWT_PRIVATE_KEY is not printed. Load it into the secret store from the ` +
      'key file directly, so it never enters a shell history or a build log.\n' +
      `\nRecord this moment — "${current.signingKeyId}" stops signing now, and ` +
      `retiring it needs that timestamp:\n  rotate-keys retire --kid ` +
      `${current.signingKeyId} --deactivated-at ${new Date().toISOString()}`,
  );
}

function retire(current: KeyEnvState, flags: Flags): void {
  const plan = planRetire({
    current,
    kid: requireFlag(flags, 'kid'),
    deactivatedAt: requireDate(flags, 'deactivated-at'),
    force: flags['force'] === true,
  });
  printPlan(plan);
}

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));

  loadDotenv();
  const current = readKeyEnv();

  if (command === 'status') status(current);
  else if (command === 'publish') publish(current, flags);
  else if (command === 'activate') activate(current, flags);
  else retire(current, flags);
}

try {
  main();
} catch (error) {
  if (error instanceof RotationOrderError) {
    // The ordering messages already explain the failure and the fix; a stack
    // through the planner would only bury them.
    console.error(`\nRefused: ${error.message}\n`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
}
