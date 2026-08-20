/**
 * Probes the Doc 08 §2 module boundaries by trying to break them.
 *
 *   node tools/check-boundaries.mjs \
 *     --probe apps/admin-web/src:@plantops/db \
 *     --probe libs/ui/src:@plantops/iam-client
 *
 *   node tools/check-boundaries.mjs --config-for apps/admin-web/src/app/layout.tsx
 *
 * For each `--probe <directory>:<package>` it writes a throwaway module into
 * that directory, lints **only that file** with the workspace's own ESLint
 * configuration, prints what `@nx/enforce-module-boundaries` said, and deletes
 * the file again. `--config-for` prints the rule's resolved options for one
 * file, so a caller can inspect the allow-lists themselves rather than only
 * their effects. Output is JSON on stdout; exit code is 0 unless the tool
 * itself failed, because "the import was refused" is a *result*, not an error.
 *
 * This is `docs/fixtures/boundary-lint-check.md`'s manual procedure — add an
 * import, run lint, watch it fail, remove the import — with the human taken out.
 * Those boundaries are the structural half of this system's security (a browser
 * bundle *cannot* reach the schema, rather than merely does not), and a rule
 * whose configuration silently widened would go on passing while enforcing
 * nothing.
 *
 * ## Why a separate process
 *
 * `apps/iam-api-e2e/src/boundary-lint.e2e.ts` is what runs this, and it cannot
 * call the ESLint API in-process: flat config is loaded with a dynamic
 * `import()`, which Jest's CommonJS VM refuses without
 * `--experimental-vm-modules`. Turning that flag on for the whole battery to
 * satisfy one file would be a much larger change than a child process, and this
 * way the probe stays runnable by hand and from CI.
 *
 * ## Why it lints one file instead of running `nx lint`
 *
 * Same ESLint, same flat config resolved from the same directory, same rule,
 * same Nx project graph — but scoped to the file that matters. `nx lint` over
 * five whole projects answers the same question in about a minute and a half;
 * this takes a couple of seconds per probe.
 */

import { ESLint } from 'eslint';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Obvious, unique, and never a real module. */
const PROBE_FILE = '__boundary-probe.generated.ts';

const BOUNDARY_RULE = '@nx/enforce-module-boundaries';

function parseArgs(argv) {
  const probes = [];
  let configFor;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--probe') {
      const value = argv[++index] ?? '';
      const separator = value.indexOf(':');
      if (separator === -1) {
        throw new Error(`--probe expects <directory>:<package>, got "${value}"`);
      }
      probes.push({
        directory: value.slice(0, separator),
        imports: value.slice(separator + 1),
      });
    } else if (argv[index] === '--config-for') {
      configFor = argv[++index];
    }
  }

  if (probes.length === 0 && configFor === undefined) {
    throw new Error(
      'Usage: check-boundaries --probe <directory>:<package> [...] ' +
        '| --config-for <file>',
    );
  }
  return { probes, configFor };
}

/** Writes the probe module, lints it, removes it, returns the rule's messages. */
async function runProbe(eslint, probe) {
  const path = join(WORKSPACE_ROOT, probe.directory, PROBE_FILE);

  // A side-effect import, so nothing has to be exported for the rule to see the
  // edge, plus an export so the file is not dead code to any other rule.
  writeFileSync(
    path,
    `import '${probe.imports}';\nexport const boundaryProbe = true;\n`,
    'utf8',
  );

  try {
    const [result] = await eslint.lintFiles([path]);
    return {
      ...probe,
      errors: result.messages
        .filter((message) => message.ruleId === BOUNDARY_RULE)
        .map((message) => message.message),
    };
  } finally {
    rmSync(path, { force: true });
  }
}

async function main() {
  const { probes, configFor } = parseArgs(process.argv.slice(2));

  // One instance for every probe: it builds the Nx project graph once, and the
  // graph does not change while this runs.
  const eslint = new ESLint({ cwd: WORKSPACE_ROOT });

  const results = [];
  for (const probe of probes) {
    results.push(await runProbe(eslint, probe));
  }

  let depConstraints = null;
  if (configFor !== undefined) {
    const config = await eslint.calculateConfigForFile(
      join(WORKSPACE_ROOT, configFor),
    );
    const entry = config.rules?.[BOUNDARY_RULE];
    depConstraints = entry?.[1]?.depConstraints ?? null;
  }

  // Belt and braces for the `finally` above: a probe module left behind in
  // `libs/ui/src` breaks the next build, and it would not be obvious why.
  const leftBehind = probes
    .map((probe) => join(probe.directory, PROBE_FILE))
    .filter((path) => existsSync(join(WORKSPACE_ROOT, path)));

  console.log(JSON.stringify({ results, depConstraints, leftBehind }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
