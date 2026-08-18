/**
 * Wording shared by the two screens that can deactivate an application.
 *
 * The list toggles it from a row and the detail screen from a button, and the
 * two must not describe the same irreversible-looking action differently. The
 * reassurance is the substance: Doc 02 §7 retires an application with
 * `is_active = false` and there is no delete anywhere in the API, so an operator
 * expecting one needs to be told the data is kept — otherwise they go looking
 * for a delete that does not exist, or hesitate over a switch that is safe.
 */
export const DEACTIVATION_CONSEQUENCES =
  'It disappears from every tenant’s navigation and its permissions stop ' +
  'resolving. Nothing is deleted — its permissions, nav nodes and the roles ' +
  'that map them are all kept, and switching it back on restores them exactly.';
