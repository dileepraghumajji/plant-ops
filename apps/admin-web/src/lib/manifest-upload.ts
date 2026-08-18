/**
 * Pure functions behind the manifest upload screen (Doc 09 §2.1, Doc 02 §2).
 *
 * Three jobs, none of which needs React or a network:
 *
 * - **Reading the document.** A pasted or dropped file is a string, and the
 *   first thing that can be wrong with it is that it is not JSON. That failure
 *   deserves a better message than a 400 from a server that never saw valid
 *   JSON to complain about.
 * - **Naming what the diff refers to.** `ManifestDiff` carries keys and nothing
 *   else — deliberately, because it is also an audit payload that has to stay
 *   readable years after the document that produced it (`contracts/manifest.ts`).
 *   The screen, unlike the audit trail, is holding that document, so it can put
 *   the label back beside the key without the API having to send it twice.
 * - **Comparing two diffs.** "Confirm applies exactly the previewed diff" is
 *   this session's acceptance criterion, and the honest way to keep it is not to
 *   assume it: the upload returns its own diff, and if the catalog moved between
 *   the preview and the confirm the two differ and the operator is told.
 *
 * ## What is *not* here
 *
 * Any judgement about whether a manifest is valid. `manifest.dto.ts` decides
 * that — duplicate keys across the tree, a `requires` naming an undeclared
 * permission, nesting depth, every field's shape — and a second opinion in the
 * console would be a rule with two spellings, one of which is not the one that
 * runs. So this file checks exactly what it needs to *address* the upload: that
 * the text parses, and that it carries the `key` naming the application the
 * document belongs to. The rest of the complaints come back from the dry run,
 * addressed to real field paths, before any preview is shown.
 */

import type {
  ApplicationManifest,
  ManifestDiff,
  ManifestMappingChange,
  ManifestNavNode,
  ManifestPermission,
} from '@plantops/contracts';

// ── reading the document ─────────────────────────────────────────────────────

export type ManifestParseResult =
  | { ok: true; manifest: ApplicationManifest }
  /** `problem` is for the operator; there is no field to attach it to yet. */
  | { ok: false; problem: string };

/**
 * A pasted or uploaded manifest, or why it could not be read at all.
 *
 * "At all" is the bar: a document that parses and names an application goes to
 * the server, whatever else may be wrong with it. Rejecting more here would move
 * validation into the console and produce a file the console refuses and the CLI
 * accepts (`tools/upload-manifest.ts` draws the same line, for the same reason).
 */
export function parseManifestDocument(text: string): ManifestParseResult {
  if (text.trim() === '') {
    return { ok: false, problem: 'Paste or upload a manifest first.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problem: `This is not valid JSON. ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problem: 'A manifest is a JSON object (Doc 02 §2).' };
  }

  const manifest = parsed as Partial<ApplicationManifest>;
  if (typeof manifest.key !== 'string' || manifest.key.trim() === '') {
    return {
      ok: false,
      problem:
        'The manifest has no "key". It names the application the document ' +
        'belongs to, and without it there is nothing to upload to.',
    };
  }

  return { ok: true, manifest: manifest as ApplicationManifest };
}

// ── naming what the diff refers to ───────────────────────────────────────────

/** Every node of a manifest tree, flattened depth-first. */
export function flattenManifestNav(
  nav: readonly ManifestNavNode[] | undefined,
): ManifestNavNode[] {
  const flat: ManifestNavNode[] = [];
  const visit = (nodes: readonly ManifestNavNode[]): void => {
    for (const node of nodes) {
      flat.push(node);
      if (node.children !== undefined) visit(node.children);
    }
  };
  visit(nav ?? []);
  return flat;
}

/**
 * The document, addressed by the keys its diff speaks in.
 *
 * Deactivated keys are absent by definition — a key is deactivated *because* the
 * manifest stopped declaring it — so every lookup is optional and the screen
 * falls back to showing the bare key, which is all the catalog can tell it.
 */
export interface ManifestIndex {
  permissions: ReadonlyMap<string, ManifestPermission>;
  nav: ReadonlyMap<string, ManifestNavNode>;
}

export function indexManifest(manifest: ApplicationManifest): ManifestIndex {
  return {
    permissions: new Map(
      (manifest.permissions ?? []).map((permission) => [permission.key, permission]),
    ),
    nav: new Map(flattenManifestNav(manifest.nav).map((node) => [node.key, node])),
  };
}

// ── measuring and comparing ──────────────────────────────────────────────────

/**
 * How many rows a diff touches, by kind.
 *
 * A mapping change counts once per permission key rather than once per node: the
 * `menu_permission` rows are what actually move, and a node gaining four gates
 * is four rows however it is grouped in the response.
 */
export interface DiffTotals {
  created: number;
  updated: number;
  deactivated: number;
  mapped: number;
  unmapped: number;
  total: number;
}

export function diffTotals(diff: ManifestDiff): DiffTotals {
  const keys = (change: readonly ManifestMappingChange[]): number =>
    change.reduce((sum, entry) => sum + entry.permission_keys.length, 0);

  const created = diff.permissions.created.length + diff.nav.created.length;
  const updated =
    diff.permissions.updated.length +
    diff.nav.updated.length +
    // The application's own `name`/`description` is one row's worth of change,
    // however many of its fields moved.
    (diff.application.changed.length > 0 ? 1 : 0);
  const deactivated =
    diff.permissions.deactivated.length + diff.nav.deactivated.length;
  const mapped = keys(diff.menu_permissions.mapped);
  const unmapped = keys(diff.menu_permissions.unmapped);

  return {
    created,
    updated,
    deactivated,
    mapped,
    unmapped,
    total: created + updated + deactivated + mapped + unmapped,
  };
}

/** True when the diff says an upload would deactivate something (Doc 02 §7). */
export function hasDeactivations(diff: ManifestDiff): boolean {
  return (
    diff.permissions.deactivated.length > 0 ||
    diff.nav.deactivated.length > 0 ||
    diff.menu_permissions.unmapped.length > 0
  );
}

/**
 * Whether two diffs describe the same change, key for key.
 *
 * Compared structurally rather than by `JSON.stringify`, because a match here is
 * the evidence for the promise the screen made — "confirming applies what you
 * previewed" — and evidence that depends on two objects having been built with
 * their properties in the same order is not evidence.
 *
 * Order *within* each list is significant and deliberately so: both diffs come
 * out of `toManifestDiff` over catalogs read the same way, so a reordering means
 * the catalog itself moved between the two calls, which is exactly the thing
 * worth reporting.
 */
export function diffsMatch(a: ManifestDiff, b: ManifestDiff): boolean {
  return (
    a.application.key === b.application.key &&
    sameKeys(a.application.changed, b.application.changed) &&
    sameEntity(a.permissions, b.permissions) &&
    sameEntity(a.nav, b.nav) &&
    sameMappings(a.menu_permissions.mapped, b.menu_permissions.mapped) &&
    sameMappings(a.menu_permissions.unmapped, b.menu_permissions.unmapped)
  );
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function sameEntity(
  a: ManifestDiff['permissions'],
  b: ManifestDiff['permissions'],
): boolean {
  return (
    sameKeys(a.created, b.created) &&
    sameKeys(a.updated, b.updated) &&
    sameKeys(a.deactivated, b.deactivated)
  );
}

function sameMappings(
  a: readonly ManifestMappingChange[],
  b: readonly ManifestMappingChange[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (change, index) =>
        change.nav_key === b[index]?.nav_key &&
        sameKeys(change.permission_keys, b[index]?.permission_keys ?? []),
    )
  );
}
