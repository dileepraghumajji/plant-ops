/**
 * Emits `apps/iam-api/openapi.json` (Doc 06, H6).
 *
 *   npm run openapi            # write the document
 *   npm run openapi -- --check # fail if the committed one is stale
 *
 * ## Why the document is committed rather than only built
 *
 * It is the artefact an integrating team is pointed at, and the one thing worth
 * seeing in a pull request is *that it changed*. A generated file that lives
 * only in CI output tells a reviewer nothing; the same file in the diff turns
 * "this rename is internal" into a visible claim about a published contract.
 *
 * `--check` is what makes that hold: it regenerates and compares, so a DTO
 * edited without re-emitting fails the build rather than leaving the published
 * document quietly describing the previous release.
 *
 * ## Why this needs no database
 *
 * `buildOpenApiDocument` reads decorator metadata off the controller classes,
 * not off a running application (see `openapi/openapi.ts`). Importing the
 * controllers is enough — nothing is instantiated, no provider is resolved, and
 * no environment is validated. A documentation build that needed Postgres,
 * Redis and a signing key would be a documentation build nobody runs.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApiDocument } from '../apps/iam-api/src/openapi/openapi';

/** Run from the workspace root — both the npm script and the Nx target do. */
const OUTPUT = join(process.cwd(), 'apps', 'iam-api', 'openapi.json');

function main(): void {
  const document = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

  if (!process.argv.includes('--check')) {
    writeFileSync(OUTPUT, document, 'utf-8');
    const routes = Object.values(buildOpenApiDocument().paths).reduce(
      (total, operations) => total + Object.keys(operations).length,
      0,
    );
    console.log(`Wrote ${OUTPUT} — ${routes} operations.`);
    return;
  }

  const committed = read(OUTPUT);
  if (committed === document) {
    console.log('openapi.json is up to date.');
    return;
  }

  console.error(
    `${OUTPUT} is stale.\n` +
      'A route, a DTO or a response schema changed without the document being ' +
      're-emitted, which means the published API description no longer matches ' +
      'the API. Run `npm run openapi` and commit the result.',
  );
  process.exit(1);
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

main();
