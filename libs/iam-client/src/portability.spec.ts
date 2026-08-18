/**
 * Two claims this package makes that no other test can check, because both are
 * about what the code does *not* contain.
 *
 * The first is Doc 08 §2's boundary: `iam-client` may depend on
 * `@plantops/contracts` and nothing else. Nx's `enforce-module-boundaries` lint
 * rule enforces it for workspace projects, but says nothing about a stray
 * `axios` or `jsonwebtoken` creeping into the dependency list.
 *
 * The second is the acceptance criterion that the same build runs in Node and in
 * a browser. Nothing in a Node-only test suite fails when `node:crypto` is
 * imported at the top of a file — the bundle simply breaks for `admin-web`
 * later, at a point far from the change that caused it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_ROOT = join(__dirname);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });

/** Every `from '…'` in the file, import and re-export alike. */
const specifiersIn = (path: string): string[] =>
  [...readFileSync(path, 'utf-8').matchAll(/from\s+'([^']+)'/g)].map(
    (match) => match[1],
  );

describe('package boundaries', () => {
  const files = sourceFiles(SOURCE_ROOT);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports nothing but @plantops/contracts and its own modules', () => {
    const foreign = files.flatMap((path) =>
      specifiersIn(path)
        .filter(
          (specifier) =>
            !specifier.startsWith('.') && specifier !== '@plantops/contracts',
        )
        .map((specifier) => `${path}: ${specifier}`),
    );

    expect(foreign).toEqual([]);
  });

  it('uses no Node built-in, so the same build runs in a browser', () => {
    const builtins = files.flatMap((path) =>
      specifiersIn(path)
        .filter(
          (specifier) =>
            specifier.startsWith('node:') ||
            ['fs', 'path', 'crypto', 'http', 'https', 'url', 'buffer'].includes(
              specifier,
            ),
        )
        .map((specifier) => `${path}: ${specifier}`),
    );

    expect(builtins).toEqual([]);
  });
});
