/**
 * `@RequirePermission` — the WHAT, and optionally the WHERE, of a route
 * (Doc 04 §8, Doc 08 §4).
 *
 * ```ts
 * ⁣@RequirePermission('gatepass.dc.approve', { scopeFrom: 'params.gateId' })
 * ```
 *
 * That single line is the whole of Doc 08 §4's promise: a future operational
 * module writes **no** authorization logic, only a declaration of what this
 * route is, and {@link PermissionGuard} turns it into the Doc 04 §4.2 point
 * check against the subject's resolved grants.
 *
 * ## Two decorators, because "no permission" has to be said out loud
 *
 * {@link PermissionGuard} is registered app-wide and **denies a route that
 * declares nothing**. That is the same direction `AuthGuard` takes with
 * {@link Public}, and for the same reason stated there: an opt-in guard leaves
 * every new controller open until somebody remembers a decorator, and the
 * symptom of forgetting is a route that *works* — which no test catches,
 * because working is what tests assert. Here the symptom of forgetting is a
 * 403, which is loud, immediate, and visible in the first request anybody makes.
 *
 * So a route that genuinely has no permission gate says
 * {@link NoPermissionRequired} and gives its reason. There are few of them and
 * they are all the same shape: endpoints that answer a question **about the
 * bearer themselves** — their own sessions, their own grants, their own
 * navigation. A subject needs no permission to be told what they can do, and
 * inventing one would mean a subject with no grants could not discover that
 * they have no grants.
 *
 * A `@Public()` route needs neither decorator: there is no subject, so there
 * are no grants to check and the guard steps aside before it looks.
 *
 * ## `scopeFrom` names a place in the request, not a value
 *
 * The string is a dotted path read from the request object —
 * `params.gateId`, `body.scope_node_id`, `query.nodeId`,
 * `headers.x-scope-node-id` — and it resolves to the id of a **scope node**.
 * The guard turns that id into a path and runs the coverage test; it never
 * trusts a path arriving from the caller, because a path *is* the answer
 * (Doc 07 §5's provenance rule applied one layer up).
 *
 * Omit it where the request names no node. A platform route is the obvious case
 * — Doc 04 §10 has platform admins skip the tenant coverage step entirely — but
 * so is `POST /iam/roles`, which creates a row that belongs to the tenant rather
 * than to a place in it. Omitting the scope does not weaken the check: the
 * permission dimension still has to be held, and RLS still confines every row
 * the handler can reach to the caller's own tenant.
 */

import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@plantops/contracts';

/** Where {@link PermissionGuard} reads a route's requirement from. */
export const REQUIRE_PERMISSION_METADATA = 'auth-kit:require-permission';

/** Where it reads a route's deliberate opt-out from. */
export const NO_PERMISSION_METADATA = 'auth-kit:no-permission';

export interface RequirePermissionOptions {
  /**
   * Dotted path to the target **scope node id** in the request, e.g.
   * `params.id`, `body.scope_node_id`. Omitted where the route names no node.
   */
  scopeFrom?: string;
  /**
   * Treat an absent value at `scopeFrom` as "no node named" rather than as a
   * denial.
   *
   * Off by default, and the default is the safe one: a route that says it takes
   * a target and then receives none has nothing to run the coverage test
   * against, and letting it through would silently downgrade a scoped check to
   * an unscoped one. Turn it on only where absence is a legitimate shape of the
   * request — `POST /iam/scopes` creating a tenant's first root has no parent to
   * be covered by, and there is no other node it could name.
   */
  scopeOptional?: boolean;
}

/** What a route declares about itself. */
export interface PermissionRequirement extends RequirePermissionOptions {
  permission: PermissionKey;
}

/**
 * Gates a route on `permission`, optionally at the scope node the request
 * names.
 *
 * Applicable to a method or to a whole controller; the method wins where both
 * carry one, which is Nest's `getAllAndOverride` order and lets a controller
 * state the common case once.
 */
export const RequirePermission = (
  permission: PermissionKey,
  options: RequirePermissionOptions = {},
) =>
  SetMetadata<string, PermissionRequirement>(REQUIRE_PERMISSION_METADATA, {
    permission,
    ...options,
  });

/**
 * Opts a route out of permission gating, with the reason recorded at the call
 * site.
 *
 * The `reason` argument is not decoration. It is the only thing that separates
 * a considered exemption from a forgotten decorator when the next person reads
 * the file, and it is why this is not simply a bare marker.
 */
export const NoPermissionRequired = (reason: string) =>
  SetMetadata(NO_PERMISSION_METADATA, reason);

/**
 * Reads `path` out of `request`, one segment at a time.
 *
 * Traversal stops at anything that is not a plain object, and the well-known
 * prototype keys are refused outright: `scopeFrom` is authored in a controller
 * rather than sent by a caller, but a decorator string is still a string, and a
 * lookup that could walk into `__proto__` is one that would resolve to
 * something no request contains.
 *
 * Returns `undefined` for anything that is not a non-empty string, so a missing
 * parameter and a `null` body field are the same "no node named" — the caller
 * chose neither.
 */
export function readScopeTarget(request: unknown, path: string): string | undefined {
  const segments = path.split('.');
  let current: unknown = request;

  for (const segment of segments) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined;
    }
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === 'string' && current.trim() !== '' ? current : undefined;
}
