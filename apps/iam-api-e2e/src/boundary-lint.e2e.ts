/**
 * **The module boundaries, enforced rather than documented** (Doc 08 §2).
 *
 * Doc 08 §2's rules are the structural half of this system's security: the
 * reason a future `gatepass-web` bundle cannot reach the IAM's tables is not
 * that nobody would, it is that `@nx/enforce-module-boundaries` refuses it. That
 * guarantee is worth exactly as much as the configuration behind it, and
 * configuration is the thing nobody notices going wrong — an allow-list widened
 * to unblock an import, a tag dropped in a refactor, and the rule goes on
 * passing while enforcing nothing.
 *
 * `docs/fixtures/boundary-lint-check.md` has recorded, since Session 1, that the
 * rules were verified by hand: add an import, run `nx lint`, watch it fail,
 * remove the import. This file is that procedure with the human taken out. It
 * drives `tools/check-boundaries.mjs`, which writes a throwaway module into a
 * real project, lints it, and deletes it — see that file for why the probing
 * happens in a child process and why it lints one file instead of a project.
 *
 * ## The last probe is the one that must pass
 *
 * Four "this is refused" assertions pass just as well against a rule that
 * refuses everything, or against an ESLint that failed to load the config at
 * all. `iam-api` importing `libs/db` is the import Doc 08 §2 *permits*, and it
 * is what tells the four refusals apart from a broken harness.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './support/api-process';

interface Probe {
  /** Workspace-relative directory the probe module is written into. */
  directory: string;
  /** The package it tries to import. */
  imports: string;
  /** Whether Doc 08 §2 permits it. */
  permitted: boolean;
  /** What the boundary is for, in one line. */
  because: string;
}

const PROBES: Probe[] = [
  {
    directory: 'apps/admin-web/src',
    imports: '@plantops/db',
    permitted: false,
    because:
      'Doc 08 §2’s headline rule: a browser bundle must not be able to reach ' +
      'the IAM’s tables, its entities, or its RLS helpers.',
  },
  {
    directory: 'libs/ui/src',
    imports: '@plantops/iam-client',
    permitted: false,
    because:
      '`libs/ui` is presentation — data in, markup out — which is what makes ' +
      'it testable without a server and reusable by the gatepass and visitor ' +
      'consoles. A component that can call the IAM itself breaks that, and the ' +
      'component still works, so nothing else would catch it.',
  },
  {
    directory: 'libs/web-kit/src',
    imports: '@plantops/db',
    permitted: false,
    because:
      '`scope:web` composes `client` + `ui` + `contracts` and nothing else, so ' +
      'no browser runtime can reach the schema or the NestJS guards.',
  },
  {
    directory: 'apps/iam-api-e2e/src',
    imports: '@plantops/db',
    permitted: false,
    because:
      'Added with this battery (Session 38). An isolation suite that could ' +
      'import `applyRlsContext` would end up asserting that the helper works ' +
      'rather than that the policies do — see `support/database.ts`.',
  },
  {
    directory: 'apps/iam-api/src',
    imports: '@plantops/db',
    permitted: true,
    because:
      'The one project Doc 08 §2 allows near the schema. This probe is the ' +
      'control: without it, four refusals prove nothing about the rule.',
  },
];

interface ProbeResult {
  directory: string;
  imports: string;
  errors: string[];
}

interface Report {
  results: ProbeResult[];
  depConstraints:
    | { sourceTag: string; onlyDependOnLibsWithTags: string[] }[]
    | null;
  leftBehind: string[];
}

function checkBoundaries(args: readonly string[]): Promise<Report> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(WORKSPACE_ROOT, 'tools', 'check-boundaries.mjs'), ...args],
      { cwd: WORKSPACE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`check-boundaries exited ${code}:\n${stderr}`));
        return;
      }
      // The last JSON line, not the first: `findLast` would say this more
      // directly, but the workspace's `lib` target predates it.
      const jsonLines = stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith('{'));
      const line = jsonLines[jsonLines.length - 1];
      if (line === undefined) {
        reject(new Error(`check-boundaries produced no report:\n${stdout}${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as Report);
    });
  });
}

describe('module boundaries (Doc 08 §2)', () => {
  let report: Report;

  beforeAll(async () => {
    // Every probe in one invocation: the Nx project graph costs more to build
    // than all five lints put together.
    report = await checkBoundaries([
      ...PROBES.flatMap((probe) => [
        '--probe',
        `${probe.directory}:${probe.imports}`,
      ]),
      '--config-for',
      'apps/admin-web/src/app/layout.tsx',
    ]);
  }, 180_000);

  const resultFor = (probe: Probe): ProbeResult => {
    const result = report.results.find(
      (entry) => entry.directory === probe.directory && entry.imports === probe.imports,
    );
    if (result === undefined) {
      throw new Error(`No probe result for ${probe.directory} → ${probe.imports}.`);
    }
    return result;
  };

  it.each(PROBES.filter((probe) => !probe.permitted))(
    'refuses $directory importing $imports',
    (probe) => {
      const { errors } = resultFor(probe);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join('\n')).toMatch(/can only depend on libs tagged with/);
    },
  );

  it.each(PROBES.filter((probe) => probe.permitted))(
    'permits $directory importing $imports',
    (probe) => {
      expect(resultFor(probe).errors).toEqual([]);
    },
  );

  it('leaves no probe module behind', () => {
    expect(report.leftBehind).toEqual([]);
  });

  /**
   * The other half of Doc 08 §2, and the one a widened allow-list would quietly
   * undo: the rule's own configuration. An entry that gained `scope:db` would
   * still make every probe above fail — for the *other* projects — while opening
   * the door for the one that was widened.
   */
  it('names no allow-list that would let a browser bundle reach the schema', () => {
    expect(report.depConstraints).not.toBeNull();

    const allowedNearTheSchema = (report.depConstraints ?? [])
      .filter((constraint) => constraint.onlyDependOnLibsWithTags.includes('scope:db'))
      .map((constraint) => constraint.sourceTag);

    // `iam-api`, and only `iam-api`. `type:app` → `type:lib` and the untagged
    // catch-all are broad by construction, and Nx evaluates every matching
    // constraint conjunctively, so neither can widen anything on its own.
    expect(allowedNearTheSchema).toEqual(['app:iam-api']);
  });
});
