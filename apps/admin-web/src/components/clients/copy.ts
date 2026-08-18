/**
 * Wording shared by the two screens that can suspend a tenant.
 *
 * The list suspends from a row and the detail screen from a button, and the two
 * must not describe the same alarming-looking action differently. The substance
 * is the reassurance: Doc 01 §3.4 gives a tenant two states and neither is
 * `deleted`, so an operator expecting a delete needs to be told what suspension
 * actually is — otherwise they either go looking for a delete that cannot exist,
 * or hesitate over a button that is entirely reversible.
 *
 * The first sentence is the sharp one, and it is sharp on purpose: suspension is
 * enforced at session creation (migration 0012's `auth_begin_session` re-checks
 * `client.status`), so it takes effect for new logins immediately rather than
 * eventually.
 */
export const SUSPENSION_CONSEQUENCES =
  'Nobody in this tenant will be able to sign in, starting immediately. ' +
  'Nothing is deleted — their users, roles, organisation tree, grants and ' +
  'audit trail are all kept exactly as they are, and reactivating restores ' +
  'access with no further setup. Sessions already open continue until they ' +
  'expire or are revoked.';
