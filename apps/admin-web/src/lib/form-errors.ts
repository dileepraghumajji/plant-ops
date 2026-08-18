/**
 * Putting a server refusal next to the field that caused it.
 *
 * Doc 06 §2 gives a `VALIDATION_FAILED` a `details` array of `{ field, message }`
 * and a `CONFLICT` a message naming what clashed. Rendering either as a toast
 * makes the operator read a sentence, dismiss it, and then hunt for the input it
 * was about — on the create-application form there are four, and on the
 * add-permissions form there is a row per permission. Attaching the message to
 * the input is the difference between "something was wrong" and "this key is
 * taken".
 *
 * Kept out of the components because the mapping — a dotted server path to
 * antd's array-shaped `NamePath`, a 409 to the field that owns the natural key
 * — is exactly the part worth testing, and testing it should not require
 * mounting a form.
 */

import { IamErrorCode } from '@plantops/contracts';
import { IamApiError } from '@plantops/iam-client';
import type { FormInstance } from 'antd';

/** One field and what the server said about it, in antd `setFields` shape. */
export interface FieldIssue {
  name: (string | number)[];
  errors: string[];
}

export interface FieldIssueOptions {
  /**
   * The form's top-level field names. A `details` entry for anything else is
   * dropped rather than attached to a field that does not exist — antd would
   * silently swallow it and the operator would see no message at all.
   */
  fields: readonly string[];
  /**
   * Which field a 409 belongs to.
   *
   * The server does not say, and it should not have to: `CONFLICT` covers a
   * duplicate key, a cross-application parent and a cross-tenant reference
   * alike (Doc 06 §2). But a given form usually has exactly one field that can
   * collide — `key` on both catalog forms — and the screen knows which.
   */
  conflictField?: string;
  /**
   * A path prefix to remove from every server-supplied field path.
   *
   * Several forms in this console edit **one** item but post it inside a bulk
   * body, because that is the shape the endpoint takes — the add-nav-node form
   * sends `{ nodes: [ … ] }`, and its complaints therefore come back addressed
   * to `nodes[0].route` while the form's own field is `route`. Without this the
   * paths match nothing, every detail is dropped, and the operator gets a
   * "check the highlighted fields" toast over a form with nothing highlighted.
   */
  stripPrefix?: readonly (string | number)[];
}

/**
 * Field-level issues from a thrown error, or an empty array when none of it
 * belongs to a field.
 *
 * An empty result is the caller's signal to show the failure at screen level
 * instead: a 403, a 500 or a transport fault is not about an input, and pinning
 * it to one would be a lie about what went wrong.
 */
export function formFieldIssues(
  error: unknown,
  options: FieldIssueOptions,
): FieldIssue[] {
  if (!(error instanceof IamApiError)) return [];

  if (error.code === IamErrorCode.VALIDATION_FAILED) {
    const known = new Set(options.fields);
    const prefix = options.stripPrefix ?? [];
    return error.details
      .map((detail) => ({
        name: stripPrefix(parseFieldPath(detail.field), prefix),
        errors: [detail.message],
      }))
      .filter((issue) => issue.name.length > 0 && known.has(String(issue.name[0])));
  }

  if (error.code === IamErrorCode.CONFLICT && options.conflictField !== undefined) {
    return [{ name: [options.conflictField], errors: [error.message] }];
  }

  return [];
}

/**
 * Marks the form's fields, and says whether anything was marked.
 *
 * `false` means the failure did not belong to a field and the caller still owes
 * the operator an explanation — a toast, or a panel where the content was.
 *
 * The cast is the one place in the console where a server-supplied field path
 * meets antd's typing. `FormInstance<T>['setFields']` narrows `name` to the
 * form's own literal key paths, which is exactly the guarantee a string that
 * arrived over the wire cannot offer. {@link formFieldIssues} has already
 * filtered the paths down to fields the caller declared, so the runtime
 * property antd needs holds; only the proof does not survive the network.
 */
export function applyFieldIssues<T>(
  form: FormInstance<T>,
  issues: readonly FieldIssue[],
): boolean {
  if (issues.length === 0) return false;
  form.setFields(issues as unknown as Parameters<FormInstance<T>['setFields']>[0]);
  return true;
}

/**
 * Drops `prefix` from the front of `path`, or leaves the path alone when it does
 * not start with it.
 *
 * Leaving it alone matters: a complaint about the array *itself* — zod's
 * `nodes: at least one node is required`, addressed to `nodes` — has no
 * per-field home, and blindly stripping would turn it into an empty path that
 * the caller then reports as a field it does not have.
 */
function stripPrefix(
  path: (string | number)[],
  prefix: readonly (string | number)[],
): (string | number)[] {
  if (prefix.length === 0 || path.length <= prefix.length) return path;
  const matches = prefix.every((segment, index) => path[index] === segment);
  return matches ? path.slice(prefix.length) : path;
}

/**
 * `permissions.0.key` → `['permissions', 0, 'key']`.
 *
 * Numeric segments become numbers because antd's `Form.List` indexes its
 * children by number, and `['permissions', '0', 'key']` addresses nothing.
 * Bracket notation is accepted too — zod's `path` is dotted, but the error
 * shape is a published contract and a consumer should not break if a future
 * validator spells an index `[0]`.
 */
function parseFieldPath(field: string): (string | number)[] {
  return field
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment !== '')
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}
