/**
 * Pure functions behind the audit browsers (Doc 09 §2.3 and §3.6, Doc 06 §12,
 * Doc 10).
 *
 * ## The console offers no action catalog, and that is deliberate
 *
 * `AuditRecordDTO.action` is a plain string in the contract, and its header
 * explains why: an append-only table outlives the catalog that wrote it, so an
 * action retired in a later version is still in the trail and must still be
 * readable. A union would make the compiler refuse to describe history the
 * database is obliged to keep.
 *
 * The same argument applies to a dropdown. A hardcoded list here would be a
 * fourth copy of the writers' catalog, drifting from
 * `apps/iam-api/src/audit/audit-actions.ts` the first time an action was added —
 * and the drift would show as an action nobody could filter for. So
 * {@link actionOptions} suggests what is *on screen*, and the field stays free
 * text: the server validates against the real catalog and answers 400 with the
 * spelling it rejected (Doc 06 §12), which is a better teacher than a list the
 * console guessed at.
 *
 * ## Dates are wall-clock in, instants out
 *
 * The endpoint compares half-open — `from` inclusive, `to` exclusive — against
 * ISO-8601 instants *with an offset*. A `datetime-local` input has no zone, so
 * sending its value raw would shift a compliance window by the operator's UTC
 * offset: "everything on the 3rd" becoming five and a half hours of the 2nd for
 * a reader in Chennai.
 */

import type { AuditActorType, AuditQuery, AuditRecordDTO } from '@plantops/contracts';

export interface AuditFilters {
  actorId: string;
  actorType: AuditActorType | null;
  action: string;
  targetType: string;
  targetId: string;
  /** `datetime-local` values, or `''`. */
  fromLocal: string;
  toLocal: string;
}

export const NO_AUDIT_FILTERS: AuditFilters = {
  actorId: '',
  actorType: null,
  action: '',
  targetType: '',
  targetId: '',
  fromLocal: '',
  toLocal: '',
};

export function hasAuditFilters(filters: AuditFilters): boolean {
  return (
    filters.actorId.trim() !== '' ||
    filters.actorType !== null ||
    filters.action.trim() !== '' ||
    filters.targetType.trim() !== '' ||
    filters.targetId.trim() !== '' ||
    filters.fromLocal !== '' ||
    filters.toLocal !== ''
  );
}

/**
 * The filters as query parameters, dropping every one that is blank.
 *
 * Blank means absent rather than empty: `?action=` would be a filter matching
 * nothing, and a screen whose cleared field silently emptied the table is one an
 * operator stops trusting.
 *
 * An unparseable date is dropped too. The picker cannot produce one, and
 * refusing here would mean a screen that could get stuck with no way back to a
 * result — where dropping it shows the wider range the operator can see is
 * wider.
 */
export function toAuditQuery(filters: AuditFilters): AuditQuery {
  const text = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  const instant = (local: string): string | undefined => {
    if (local === '') return undefined;
    const parsed = new Date(local);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  };

  const query: AuditQuery = {};
  const actorId = text(filters.actorId);
  const action = text(filters.action);
  const targetType = text(filters.targetType);
  const targetId = text(filters.targetId);
  const from = instant(filters.fromLocal);
  const to = instant(filters.toLocal);

  if (actorId !== undefined) query.actor_id = actorId;
  if (filters.actorType !== null) query.actor_type = filters.actorType;
  if (action !== undefined) query.action = action;
  if (targetType !== undefined) query.target_type = targetType;
  if (targetId !== undefined) query.target_id = targetId;
  if (from !== undefined) query.from = from;
  if (to !== undefined) query.to = to;

  return query;
}

/**
 * `auth.login.success` → `auth`.
 *
 * The catalog is dotted `domain.thing.verb` (Doc 10 §4), and the first segment
 * is what an operator scans a column of actions by: everything about signing in,
 * everything about the registry, everything about grants. Used for colour, not
 * for filtering — the filter is the whole action, because two actions in one
 * domain are rarely the same question.
 */
export function actionDomain(action: string): string {
  const dot = action.indexOf('.');
  return dot === -1 ? action : action.slice(0, dot);
}

/**
 * Distinct actions in what has been loaded, sorted.
 *
 * Suggestions, not a catalog — see the header. A page of twenty-five rows is a
 * small sample of the trail, so the field accepts anything typed and the server
 * decides.
 */
export function actionOptions(records: readonly AuditRecordDTO[]): string[] {
  return [...new Set(records.map((record) => record.action))].sort();
}

/**
 * Who acted, for a column that has to stay readable when there was nobody.
 *
 * `actor_id` is null where there was no subject to name — `platform.bootstrap`
 * runs before any subject exists, and a failed login names an account that may
 * have matched nothing. Rendering an empty cell would read as missing data
 * rather than as the fact it is (Doc 10 §2).
 */
export function describeActor(record: AuditRecordDTO): {
  label: string;
  id: string | null;
} {
  const label =
    record.actor_type === 'platform'
      ? 'Platform'
      : record.actor_type === 'service_account'
        ? 'Service account'
        : 'User';

  return { label, id: record.actor_id };
}

/**
 * Whether this row records something outside every tenant.
 *
 * `client_id === null` is a platform-level act, and only a platform admin ever
 * sees one (Doc 10 §7). Worth marking in the platform browser, where the two
 * kinds sit in one table and "which tenant was this?" has no answer for some
 * rows.
 */
export function isPlatformLevel(record: AuditRecordDTO): boolean {
  return record.client_id === null;
}

/** True when the payload has anything in it worth opening the drawer for. */
export function hasPayload(record: AuditRecordDTO): boolean {
  return Object.keys(record.payload ?? {}).length > 0;
}
