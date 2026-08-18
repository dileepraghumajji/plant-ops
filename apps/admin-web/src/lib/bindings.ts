/**
 * Pure functions behind the access-assignment screen (Doc 09 §3.4, Doc 06 §9,
 * Doc 01 §4.5).
 *
 * A binding is the only object in this system that grants anything: subject ×
 * role × scope node, optionally until a date. Everything the resolution engine
 * answers is a fold over these rows (Doc 04 §4), which is why the screen that
 * writes them is the one Doc 09 calls "the key screen" — and why the two
 * conversions below are worth having away from the components.
 *
 * ## One picker, two kinds of subject
 *
 * `role_binding` carries a subject XOR — exactly one of `user_id` and
 * `service_account_id` is set (Doc 01 §4.5) — and the request body splits them
 * the same way. A form control cannot hold a XOR, so the picker holds a single
 * string `"user:<id>"` or `"service:<id>"` and {@link toCreateRequest} splits it
 * again on the way out. Doing that here rather than in the component means the
 * one place a subject could be sent under the wrong key is a tested function.
 *
 * People and machine identities are offered in *one* list on purpose. Doc 01
 * §4.5 makes them equally bindable, and two separate pickers would suggest they
 * are two features — which is exactly the mistake that leads to a service
 * account being given a role through some other route.
 */

import type {
  CreateRoleBindingRequest,
  RoleBindingDTO,
  RoleBindingsQuery,
  ServiceAccountDTO,
  UserDTO,
} from '@plantops/contracts';
import { SubjectType, UserStatus } from '@plantops/contracts';

// ── the subject picker ───────────────────────────────────────────────────────

/** `"user:<uuid>"` or `"service:<uuid>"` — one string a `<Select>` can hold. */
export type SubjectKey = string;

export interface SubjectOption {
  value: SubjectKey;
  /** What the operator reads and searches on. */
  label: string;
  type: SubjectType;
  id: string;
  /** Secondary line — an address, or "machine identity". */
  detail: string;
  /**
   * True when binding to this subject would grant nothing today: a disabled
   * user resolves to nothing (Doc 04 §7), and a revoked service account cannot
   * exchange a token at all. The grant is still legal and still recorded — it
   * takes effect if the subject is reactivated — so the option is offered and
   * marked rather than withheld.
   */
  inert: boolean;
}

export function subjectKey(type: SubjectType, id: string): SubjectKey {
  return `${type}:${id}`;
}

/** The two halves again, or `null` when the string is not one of ours. */
export function parseSubjectKey(
  key: SubjectKey,
): { type: SubjectType; id: string } | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;

  const type = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (id === '') return null;
  if (type !== SubjectType.USER && type !== SubjectType.SERVICE) return null;

  return { type, id };
}

/**
 * Everyone bindable, in one list: people first, then machine identities.
 *
 * People first because that is who most grants are for, and grouped rather than
 * interleaved so an operator scanning for a name is not reading past integration
 * accounts. Within each group, by the name they are searched by.
 */
export function subjectOptions(
  users: readonly UserDTO[],
  serviceAccounts: readonly ServiceAccountDTO[],
): SubjectOption[] {
  const people = users
    .map<SubjectOption>((user) => ({
      value: subjectKey(SubjectType.USER, user.id),
      label: user.full_name,
      type: SubjectType.USER,
      id: user.id,
      detail: user.email,
      inert: user.status !== UserStatus.ACTIVE,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const machines = serviceAccounts
    .map<SubjectOption>((account) => ({
      value: subjectKey(SubjectType.SERVICE, account.id),
      label: account.name,
      type: SubjectType.SERVICE,
      id: account.id,
      detail: account.account_key,
      inert: account.status !== 'active',
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...people, ...machines];
}

// ── the grant ────────────────────────────────────────────────────────────────

export interface AssignmentDraft {
  subject: SubjectKey | null;
  roleId: string | null;
  scopeNodeId: string | null;
  /** A `datetime-local` value, or `''` for a grant that does not expire. */
  expiresAtLocal: string;
}

export type AssignmentResult =
  | { ok: true; request: CreateRoleBindingRequest }
  /** `field` is what to mark; `problem` is what to say. */
  | { ok: false; field: keyof AssignmentDraft; problem: string };

/**
 * The draft as the request body, or the first thing missing from it.
 *
 * **Scope is checked like the other two, not as an optional extra.** Doc 09 §3.4
 * requires that there be no grant without choosing where, and the reason is that
 * a scope node is not a qualifier on a grant — it *is* half of what the grant
 * means. A form that defaulted it to the org root would silently make every
 * grant tenant-wide.
 *
 * `expires_at` is converted from the browser's local wall-clock to an instant.
 * A `datetime-local` input has no zone, and the server takes ISO-8601: sending
 * the raw value would mean "5 pm" landing at 5 pm UTC for an operator in
 * Chennai, which is five and a half hours early on a grant that ends someone's
 * access.
 */
export function toCreateRequest(draft: AssignmentDraft): AssignmentResult {
  if (draft.subject === null) {
    return { ok: false, field: 'subject', problem: 'Choose who this is for.' };
  }
  const subject = parseSubjectKey(draft.subject);
  if (subject === null) {
    return { ok: false, field: 'subject', problem: 'Choose who this is for.' };
  }

  if (draft.roleId === null) {
    return { ok: false, field: 'roleId', problem: 'Choose what they may do.' };
  }

  if (draft.scopeNodeId === null) {
    return {
      ok: false,
      field: 'scopeNodeId',
      problem:
        'Choose where this applies. A grant covers the node you pick and ' +
        'everything beneath it, so there is no such thing as a grant without a ' +
        'place.',
    };
  }

  let expiresAt: string | undefined;
  if (draft.expiresAtLocal !== '') {
    const instant = new Date(draft.expiresAtLocal);
    if (Number.isNaN(instant.getTime())) {
      return { ok: false, field: 'expiresAtLocal', problem: 'That is not a date.' };
    }
    if (instant.getTime() <= Date.now()) {
      return {
        ok: false,
        field: 'expiresAtLocal',
        problem:
          'An expiry has to be in the future. A grant that has already lapsed ' +
          'grants nothing and would only be a row to explain later.',
      };
    }
    expiresAt = instant.toISOString();
  }

  return {
    ok: true,
    request: {
      ...(subject.type === SubjectType.USER
        ? { user_id: subject.id }
        : { service_account_id: subject.id }),
      role_id: draft.roleId,
      scope_node_id: draft.scopeNodeId,
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    },
  };
}

// ── the list ─────────────────────────────────────────────────────────────────

export interface BindingFilters {
  subject: SubjectKey | null;
  roleId: string | null;
  scopeNodeId: string | null;
}

export const NO_FILTERS: BindingFilters = {
  subject: null,
  roleId: null,
  scopeNodeId: null,
};

/**
 * The filters as query parameters (Doc 06 §9's "filter by user, role, scope").
 *
 * `scope_node_id` matches the node a binding is **anchored to**, not the subtree
 * it covers — "what was granted here", not "who can act here". The second
 * question is `POST /iam/permissions/check`, and the screen says so rather than
 * letting the filter be read as an answer to it.
 */
export function toBindingsQuery(filters: BindingFilters): RoleBindingsQuery {
  const subject = filters.subject === null ? null : parseSubjectKey(filters.subject);

  return {
    ...(subject === null
      ? {}
      : subject.type === SubjectType.USER
        ? { user_id: subject.id }
        : { service_account_id: subject.id }),
    ...(filters.roleId === null ? {} : { role_id: filters.roleId }),
    ...(filters.scopeNodeId === null ? {} : { scope_node_id: filters.scopeNodeId }),
  };
}

export function hasFilters(filters: BindingFilters): boolean {
  return (
    filters.subject !== null || filters.roleId !== null || filters.scopeNodeId !== null
  );
}

/**
 * What deleting this grant takes away, in one sentence.
 *
 * Written here so the table and any future confirmation say the same thing, and
 * because the sentence has to name all three parts: an operator confirming
 * "remove access" without being told *which* access, *for whom* and *where* is
 * confirming a row number.
 */
export function unbindConsequences(binding: RoleBindingDTO): string {
  const where = `“${binding.scope_node_name}” and everything beneath it`;
  const lapsed = binding.expired
    ? ' This grant has already lapsed, so nothing changes for them today — the row goes.'
    : ' They lose it within a few seconds, everywhere it reached.';

  return (
    `${binding.subject_name} will no longer hold “${binding.role_name}” at ${where}.` +
    lapsed
  );
}
