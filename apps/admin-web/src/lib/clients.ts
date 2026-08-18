/**
 * Pure functions behind the tenant-provisioning screens (Doc 09 §2.2,
 * Doc 06 §5).
 *
 * Two calculations, both worth testing without antd, and both about a mismatch
 * between what the API returns and what an operator needs to see.
 *
 * ## The enablement list is a join the API does not perform
 *
 * `GET /iam/clients/:id/applications` returns the `client_application` rows —
 * the applications this tenant has *ever* been given, enabled or not (Doc 02 §7
 * keeps a disabled row rather than deleting it). What Doc 09 §2.2 asks for is
 * "toggle which apps this client may use", which is a row per *registered*
 * application, most of which may have no `client_application` row at all.
 *
 * So the screen holds both lists and joins them, and the join decides which of
 * two calls a toggle makes: an application with no row is **enabled** with
 * `POST /applications`, and one with a row is **toggled** with
 * `PATCH /applications/:appId`. Getting that wrong is a 404 or a duplicate-key
 * 409 rather than a silent error, but the operator would see a switch that
 * simply refused to move.
 *
 * ## A slug is typed by every user of the tenant, forever
 *
 * `POST /auth/login` takes `{ email, password, client_slug }` (Doc 03 §3) and
 * `PATCH /iam/clients/:id` deliberately refuses to change `slug`
 * (`clients.dto.ts`): renaming it would lock out an entire organisation while
 * every row still looked correct. The create form therefore suggests one from
 * the name and says out loud that it is permanent — a suggestion an operator
 * accepts is better than a field they invent under time pressure, and it is the
 * only moment the value can be chosen.
 */

import type { ApplicationDTO, ClientApplicationDTO } from '@plantops/contracts';

// ── the enablement join ──────────────────────────────────────────────────────

/** One registered application, and where this tenant stands on it. */
export interface AppEnablement {
  application: ApplicationDTO;
  /**
   * The `client_application` row, or `null` when the tenant has never had this
   * application. `null` is what makes the toggle a `POST` rather than a `PATCH`.
   */
  row: ClientApplicationDTO | null;
  /** `false` for both "never enabled" and "enabled once, since switched off". */
  enabled: boolean;
  /**
   * True when the tenant has it enabled but the application itself is retired
   * globally (`is_active = false`, Doc 02 §7).
   *
   * The combination is legal and inert — the catalog is switched off for
   * everyone — and it is worth showing, because an admin looking for a menu
   * that will not appear needs to know the reason is not their toggle.
   */
  inertBecauseRetired: boolean;
}

/**
 * Every registered application, with this tenant's stance on it.
 *
 * Ordered: enabled first, then the applications still available, then anything
 * globally retired — so the list reads as "what this tenant runs" before "what
 * it could run". Within each group, by name, which is what the operator scans.
 */
export function mergeEnablements(
  catalog: readonly ApplicationDTO[],
  rows: readonly ClientApplicationDTO[],
): AppEnablement[] {
  const byApplicationId = new Map(rows.map((row) => [row.application_id, row]));

  const merged = catalog.map((application) => {
    const row = byApplicationId.get(application.id) ?? null;
    const enabled = row?.enabled === true;
    return {
      application,
      row,
      enabled,
      inertBecauseRetired: enabled && !application.is_active,
    };
  });

  return merged.sort((a, b) => rank(a) - rank(b) || compareName(a, b));
}

function rank(entry: AppEnablement): number {
  if (entry.enabled) return 0;
  return entry.application.is_active ? 1 : 2;
}

function compareName(a: AppEnablement, b: AppEnablement): number {
  return a.application.name.localeCompare(b.application.name);
}

/** How many of these are switched on — the count Doc 09 §2.2's list shows. */
export function enabledCount(entries: readonly AppEnablement[]): number {
  return entries.filter((entry) => entry.enabled).length;
}

// ── the slug ─────────────────────────────────────────────────────────────────

/**
 * The tenant slug `clients.dto.ts` would accept, derived from a display name.
 *
 * Lowercase alphanumeric segments joined by single hyphens, which is migration
 * 0003's `client_slug_format` check. Non-ASCII is dropped rather than
 * transliterated: this string is typed into a login form on whatever keyboard
 * the tenant's users have, and "acme-stål" would be a credential half of them
 * could not enter.
 *
 * Returns `''` when nothing survives — the caller shows an empty field rather
 * than a suggestion it invented, because a slug is permanent and a guess is a
 * bad thing to accept by default.
 */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    // A 64-character cut can land on a hyphen, which the pattern refuses.
    .replace(/-+$/, '');
}
