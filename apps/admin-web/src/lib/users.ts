/**
 * Pure functions behind the user screens (Doc 09 §3.3, Doc 06 §8, Doc 03 §8).
 *
 * Two things worth deciding away from the components, because both are rules
 * about consequences rather than about rendering.
 *
 * ## The account state machine
 *
 * Doc 03 §8 gives a user three states, and moving between them is not symmetric.
 * `locked` is a *reversible* stop — the failed-attempt policy sets it, an
 * administrator clears it — while `disabled` is a decision: it revokes every
 * session the person holds and empties their grants (Doc 04 §7). A screen that
 * offered "Lock" and "Disable" as two similar buttons with two similar
 * confirmations would be lying about which one is the door and which is the
 * wall, so the copy is written here, next to the transition it belongs to, and
 * the same words are used wherever the action appears.
 *
 * There is no delete. Offboarding is `disabled`, so that the person's access
 * history — every binding they held and every audit row naming them — survives
 * them (Doc 01 §3.6).
 *
 * ## Bindings are listed, including the lapsed ones
 *
 * `UserBindingDTO.expired` exists because resolution ignores an expired binding
 * (Doc 04 §4) while the row stays in the table, and "why did this stop working
 * on Friday" is a question only the row can answer. So the panel sorts them last
 * rather than dropping them, and says how many are live.
 */

import { UserStatus, type UserBindingDTO, type UserDTO } from '@plantops/contracts';

// ── the state machine ────────────────────────────────────────────────────────

/** A transition offered on the user detail screen. */
export interface StatusAction {
  /** The status this moves the account to. */
  to: UserStatus;
  label: string;
  /** Confirmation title. */
  title: string;
  /** What it does, and what it does not. Worth writing (Doc 09 §4). */
  consequences: string;
  /** Rendered in the danger tone, and confirmed before it runs. */
  danger: boolean;
}

const LOCK: StatusAction = {
  to: UserStatus.LOCKED,
  label: 'Lock',
  title: 'Lock this account?',
  consequences:
    'They will not be able to sign in, and a sign-in attempt tells them the ' +
    'account is locked rather than that the password was wrong. Nothing else ' +
    'changes: their grants, their sessions and their history stay exactly as ' +
    'they are, and unlocking restores sign-in immediately.',
  danger: false,
};

const UNLOCK: StatusAction = {
  to: UserStatus.ACTIVE,
  label: 'Unlock',
  title: 'Unlock this account?',
  consequences:
    'Sign-in works again straight away, with the password they already had. ' +
    'If they have forgotten it, send a password reset as well.',
  danger: false,
};

const DISABLE: StatusAction = {
  to: UserStatus.DISABLED,
  label: 'Disable',
  title: 'Disable this account?',
  consequences:
    'Every session they hold is revoked immediately and their permissions ' +
    'resolve to nothing — they are signed out wherever they are signed in. ' +
    'Nothing is deleted: their grants, their history and every audit record ' +
    'naming them are kept, which is why this is how someone is offboarded ' +
    'rather than removed.',
  danger: true,
};

const REACTIVATE: StatusAction = {
  to: UserStatus.ACTIVE,
  label: 'Reactivate',
  title: 'Reactivate this account?',
  consequences:
    'They can sign in again, and every grant they held before takes effect ' +
    'again exactly as it was. They will need to sign in fresh — the sessions ' +
    'revoked when the account was disabled do not come back.',
  danger: false,
};

/**
 * The transitions offered for an account in this state.
 *
 * A locked account is not offered "Disable" directly and a disabled one is not
 * offered "Lock": both would be a second stop on an account that is already
 * stopped, and neither is a thing an administrator means. Going from locked to
 * disabled is unlock-then-disable, which is two decisions and reads as two.
 */
export function statusActions(status: UserStatus): StatusAction[] {
  switch (status) {
    case UserStatus.ACTIVE:
      return [LOCK, DISABLE];
    case UserStatus.LOCKED:
      return [UNLOCK];
    case UserStatus.DISABLED:
      return [REACTIVATE];
    default:
      return [];
  }
}

/** Whether an account in this state can sign in at all right now (Doc 03 §8). */
export function canSignIn(user: Pick<UserDTO, 'status'>): boolean {
  return user.status === UserStatus.ACTIVE;
}

// ── the status filter (Doc 09 §3.3) ──────────────────────────────────────────

export interface StatusTab {
  /** `undefined` is "everyone" — no `?status=` at all. */
  status: UserStatus | undefined;
  key: string;
  label: string;
  /** One line on what this view is for. `locked` is the named screen. */
  description: string;
}

/**
 * The four views of the user list.
 *
 * "Locked" is Doc 09 §3.3's "Account Locked Users" screen, and it is a tab
 * rather than a separate route because it is the same list with one filter — a
 * second screen would be a second implementation of search, paging and the row
 * actions, kept in step by hand.
 */
export const STATUS_TABS: readonly StatusTab[] = [
  {
    status: undefined,
    key: 'all',
    label: 'All',
    description: 'Everyone in your organisation, whatever state their account is in.',
  },
  {
    status: UserStatus.ACTIVE,
    key: UserStatus.ACTIVE,
    label: 'Active',
    description: 'Accounts that can sign in right now.',
  },
  {
    status: UserStatus.LOCKED,
    key: UserStatus.LOCKED,
    label: 'Locked',
    description:
      'Accounts stopped by too many failed sign-ins, or by an administrator. Unlocking restores sign-in immediately — nothing was taken away.',
  },
  {
    status: UserStatus.DISABLED,
    key: UserStatus.DISABLED,
    label: 'Disabled',
    description:
      'Offboarded accounts. Their sessions were revoked and their permissions resolve to nothing, but every grant and audit record is kept.',
  },
];

export function tabFor(key: string): StatusTab {
  return STATUS_TABS.find((tab) => tab.key === key) ?? STATUS_TABS[0];
}

// ── the bindings panel ───────────────────────────────────────────────────────

/**
 * Bindings in the order the panel shows them: live first, then lapsed; within
 * each, by role name and then by scope node name.
 *
 * Live-first because that is what the reader is checking. Lapsed-not-dropped
 * because an expired grant is the answer to "why did this stop working", and
 * `expires_at` alone cannot be read at a glance.
 */
export function sortBindings(
  bindings: readonly UserBindingDTO[],
): UserBindingDTO[] {
  return [...bindings].sort(
    (a, b) =>
      Number(a.expired) - Number(b.expired) ||
      a.role_name.localeCompare(b.role_name) ||
      a.scope_node_name.localeCompare(b.scope_node_name),
  );
}

export interface BindingSummary {
  /** Grants that resolve today. */
  live: number;
  /** Grants held but lapsed — listed, and granting nothing (Doc 04 §4). */
  expired: number;
  /** Grants with an `expires_at` still in the future. */
  expiring: number;
}

export function summarizeBindings(
  bindings: readonly UserBindingDTO[],
): BindingSummary {
  let live = 0;
  let expired = 0;
  let expiring = 0;

  for (const binding of bindings) {
    if (binding.expired) {
      expired += 1;
      continue;
    }
    live += 1;
    if (binding.expires_at !== null) expiring += 1;
  }

  return { live, expired, expiring };
}
