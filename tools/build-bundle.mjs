/**
 * Builds the offline installation bundle (roadmap Session 42, Doc 11 §5.3).
 *
 *   node tools/build-bundle.mjs                 # version from git
 *   node tools/build-bundle.mjs 1.4.0           # explicit version
 *
 * Produces `dist/bundle/plantops-<version>.tar.gz`: one file a client's IT
 * copies onto a server that has never had, and will never have, a route to the
 * internet. Everything the install needs is inside it — the six container
 * images, the compose file, the configuration template, the installer, and the
 * runbooks.
 *
 * ## What this does *not* do, on purpose
 *
 * It does not build the images. `docker build` needs the workspace, a network,
 * and about ten minutes; bundling needs neither the workspace nor the network,
 * and doing both in one command would make a failed bundle look like a failed
 * build. CI builds the four images and then calls this; a developer runs the
 * same two steps by hand. If an image is missing this says which, and how to
 * build it, and stops.
 *
 * ## Digests, and where pinning actually happens
 *
 * `postgres` and `redis` are pinned by digest in `deploy/docker-compose.yml`,
 * and this reads the digests *out of that file* rather than repeating them.
 * Two copies of a digest is one copy too many: the one that drifts is always
 * the one nobody is looking at.
 *
 * It then pulls those digests, retags them to their plain tags, and saves the
 * retagged images. That looks like it discards the pinning, and it is the
 * opposite: `docker load` cannot restore a digest reference — a digest is
 * established by a registry, and an air-gapped host has none — so a compose
 * file that referenced one would send the install looking for a registry that
 * is not there. The pin is *enforced here*, at build time, by pulling the exact
 * bytes; the tarball then fixes those bytes for good, and `MANIFEST.json`
 * records which digest each image came from so provenance survives the
 * conversion.
 *
 * Requires `docker` and `tar` on the machine that builds. Both are build-side
 * tools; the client's server needs only Docker.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = join(ROOT, 'deploy');
const OUT = join(ROOT, 'dist', 'bundle');

/** Our four, in the order they are interesting to a person reading the log. */
const PLANTOPS_IMAGES = ['iam-api', 'admin-web', 'proxy', 'migrate'];

/**
 * Files copied in beside the compose file, flat.
 *
 * Flat because the installer runs from wherever the operator unpacked it, and a
 * directory layout is one more thing to get wrong at 2 a.m. in a plant. The
 * runbooks are the exception: they are read, not executed.
 */
const BUNDLE_FILES = [
  [join(DEPLOY, 'docker-compose.prod.yml'), 'docker-compose.yml'],
  [join(DEPLOY, 'bootstrap.sh'), 'bootstrap.sh'],
  [join(DEPLOY, 'README.md'), 'README.md'],
  [join(ROOT, 'tools', 'bootstrap-install.mjs'), 'bootstrap-install.mjs'],
  [join(ROOT, 'tools', 'setup-db-roles.sql'), 'setup-db-roles.sql'],
];

const RUNBOOKS = [
  [join(ROOT, 'docs', '11-deployment-models.md'), 'deployment-models.md'],
  [join(ROOT, 'docs', 'ops-runbook.md'), 'ops-runbook.md'],
];

function run(command, args, { capture = true, cwd = ROOT } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf-8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function die(message) {
  console.error(`\nbuild-bundle failed.\n\n${message}\n`);
  process.exit(1);
}

/** `git describe` when there is no explicit argument, matching CI's rule. */
function resolveVersion(argument) {
  if (argument) return argument;
  try {
    return run('git', ['describe', '--tags', '--dirty']).trim();
  } catch {
    const sha = run('git', ['rev-parse', '--short=12', 'HEAD']).trim();
    return `0.0.0-${sha}`;
  }
}

/**
 * `{ 'postgres:17': 'sha256:…' }`, read from the development compose file.
 *
 * Deliberately strict: if the shape it expects is not there, that means the
 * pinning convention changed and a silent empty result would ship a bundle
 * built from whatever tags happened to be local.
 */
function pinnedBaseImages() {
  const compose = readFileSync(join(DEPLOY, 'docker-compose.yml'), 'utf-8');
  const pins = new Map();
  const pattern = /image:\s*([a-z0-9][a-z0-9._/-]*:[a-z0-9._-]+)@(sha256:[0-9a-f]{64})/g;
  for (const [, reference, digest] of compose.matchAll(pattern)) {
    pins.set(reference, digest);
  }
  if (pins.size < 2) {
    die(
      'could not find digest-pinned base images in deploy/docker-compose.yml.\n' +
        'Expected lines of the form `image: postgres:17@sha256:…`. If the pinning\n' +
        'convention has changed, this reader has to change with it — shipping a\n' +
        'bundle built from unpinned tags is exactly what it exists to prevent.',
    );
  }
  return pins;
}

function imageId(reference) {
  try {
    return run('docker', ['image', 'inspect', reference, '--format', '{{.Id}}']).trim();
  } catch {
    return undefined;
  }
}

function main() {
  const version = resolveVersion(process.argv[2]);
  console.log(`Building the PlantOps installation bundle for ${version}.\n`);

  // ── Our images ────────────────────────────────────────────────────────────
  const references = [];
  const missing = [];
  for (const name of PLANTOPS_IMAGES) {
    const reference = `plantops/${name}:${version}`;
    if (imageId(reference) === undefined) missing.push(reference);
    references.push(reference);
  }
  if (missing.length > 0) {
    die(
      `these images are not built:\n  ${missing.join('\n  ')}\n\n` +
        'Build them first — from the repository root, and in this order, because\n' +
        'the migration runner is built from the API image:\n\n' +
        `  docker build -f apps/iam-api/Dockerfile   --build-arg APP_VERSION=${version} -t plantops/iam-api:${version} .\n` +
        `  docker build -f apps/admin-web/Dockerfile --build-arg APP_VERSION=${version} -t plantops/admin-web:${version} .\n` +
        `  docker build -f deploy/proxy/Dockerfile   --build-arg APP_VERSION=${version} -t plantops/proxy:${version} .\n` +
        `  docker build -f deploy/migrate/Dockerfile --build-arg APP_VERSION=${version} \\\n` +
        `    --build-arg IAM_API_IMAGE=plantops/iam-api:${version} -t plantops/migrate:${version} .`,
    );
  }

  // Every one of ours must carry the version as a label. A bundle whose images
  // disagree with its own name is the failure this catches — and support would
  // otherwise meet it as "the customer says 1.4.0 but /health says 1.3.2".
  for (const reference of references) {
    const label = run('docker', [
      'image',
      'inspect',
      reference,
      '--format',
      '{{ index .Config.Labels "org.opencontainers.image.version" }}',
    ]).trim();
    if (label !== version) {
      die(
        `${reference} is labelled "${label}" rather than "${version}".\n` +
          'Rebuild it with --build-arg APP_VERSION=' +
          version +
          '.',
      );
    }
  }
  console.log(`Four PlantOps images present, all labelled ${version}.`);

  // ── Base images, pulled at their pinned digests ───────────────────────────
  const pins = pinnedBaseImages();
  const provenance = [];
  for (const [reference, digest] of pins) {
    const repository = reference.split(':')[0];
    console.log(`Pulling ${repository}@${digest.slice(0, 19)}…`);
    run('docker', ['pull', '--quiet', `${repository}@${digest}`]);
    // Retag to the plain reference the production compose file names. See the
    // header for why the digest cannot travel through `docker save`.
    run('docker', ['tag', `${repository}@${digest}`, reference]);
    references.push(reference);
    provenance.push({ reference, digest });
  }

  // ── Lay the bundle out ────────────────────────────────────────────────────
  const stage = join(OUT, `plantops-${version}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'images'), { recursive: true });
  mkdirSync(join(stage, 'runbooks'), { recursive: true });

  console.log('\nSaving images — this is the slow part.');
  const archive = join(stage, 'images', `plantops-${version}.tar`);
  run('docker', ['save', '--output', archive, ...references], { capture: false });
  const archiveBytes = statSync(archive).size;
  console.log(`  ${archive} — ${(archiveBytes / 1024 / 1024).toFixed(0)} MB`);

  for (const [source, name] of BUNDLE_FILES) {
    if (!existsSync(source)) die(`${source} is missing — the bundle cannot ship without it.`);
    copyFileSync(source, join(stage, name));
  }
  for (const [source, name] of RUNBOOKS) {
    copyFileSync(source, join(stage, 'runbooks', name));
  }

  // The template ships with the version already filled in. It is the one value
  // an operator could not possibly know and would otherwise have to copy out of
  // a filename — and getting it wrong means compose looks for an image tag that
  // was never loaded.
  const template = readFileSync(join(DEPLOY, '.env.template'), 'utf-8').replace(
    /^PLANTOPS_VERSION=.*$/m,
    `PLANTOPS_VERSION=${version}`,
  );
  if (!template.includes(`PLANTOPS_VERSION=${version}`)) {
    die('could not set PLANTOPS_VERSION in .env.template — has the line been renamed?');
  }
  writeFileSync(join(stage, '.env.template'), template);

  // ── Manifest ──────────────────────────────────────────────────────────────
  //
  // What is in this bundle, stated by the thing that built it. It is what an
  // upgrade compares against, what a support conversation starts from, and the
  // only place the base-image digests survive the trip through `docker save`.
  let commit = 'unknown';
  try {
    commit = run('git', ['rev-parse', 'HEAD']).trim();
  } catch {
    /* a bundle built outside a checkout is unusual but not an error */
  }

  const manifest = {
    product: 'PlantOps IAM',
    version,
    builtAt: new Date().toISOString(),
    sourceCommit: commit,
    images: references.map((reference) => ({
      reference,
      id: imageId(reference),
      pinnedDigest: provenance.find((entry) => entry.reference === reference)?.digest,
    })),
    archive: {
      path: `images/plantops-${version}.tar`,
      bytes: archiveBytes,
    },
  };
  writeFileSync(join(stage, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // ── One file ──────────────────────────────────────────────────────────────
  const tarball = join(OUT, `plantops-${version}.tar.gz`);
  rmSync(tarball, { force: true });
  console.log('\nCompressing…');
  // Run *in* the output directory with relative names on both sides. Absolute
  // paths here are the one thing that behaved differently between the `tar` on
  // a Linux runner and the `tar.exe` Windows resolves to, and neither the
  // archive nor its contents need them.
  run('tar', ['-czf', `plantops-${version}.tar.gz`, `plantops-${version}`], {
    capture: false,
    cwd: OUT,
  });

  const bytes = statSync(tarball).size;
  console.log(
    `\nBundle ready:\n  ${tarball}\n  ${(bytes / 1024 / 1024).toFixed(0)} MB\n\n` +
      'On the target server:\n' +
      `  tar -xzf plantops-${version}.tar.gz\n` +
      `  cd plantops-${version}\n` +
      '  cp .env.template .env && chmod 600 .env   # then fill it in\n' +
      '  ./bootstrap.sh\n',
  );
}

main();
