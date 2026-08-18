/**
 * The WHERE dimension, as functions — coverage, query narrowing, and the
 * decision {@link PermissionGuard} enforces (Doc 04 §3–5, §9, Doc 08 §4).
 *
 * ## Why the algorithm lives in a library and not in the IAM
 *
 * Doc 08 §7 singles this out: *"`auth-kit`: unit tests for coverage/scope logic
 * (the highest-risk code — test the `covers()` prefix logic and deny-by-default
 * thoroughly)"*. The reason is that the IAM is not the only process that runs
 * it. `apps/gatepass-api` will answer "may this guard approve at this gate?"
 * from a `ResolvedGrants` it fetched over HTTP, with no database and no IAM code
 * in the request path — and if it re-implements coverage, the two disagree about
 * what lies beneath what, and the artefact of the disagreement is a subject
 * reaching a gate nobody granted them.
 *
 * So the prefix test, the point check and the `allowedPaths` projection are
 * here, as pure functions over the published {@link ResolvedGrants} shape, and
 * everything that needs a database sits behind {@link GrantsSource}.
 *
 * ## Coverage is label-wise, always
 *
 * `covers(N_b, N_t) ⇔ N_t.path <@ N_b.path` (Doc 04 §3). A character-wise
 * `startsWith` would report `n_ab.n_cd` as living under `n_a` — the class of bug
 * that grants access to a sibling subtree — so {@link pathIsWithin} compares on
 * the separator, exactly as ltree's `<@` and migration 0006's GiST index do.
 * `apps/iam-api`'s `scopes/path.util.ts` delegates to this function rather than
 * carrying a second copy.
 *
 * ## The asymmetry of Doc 04 §9 is visible in the code that implements it
 *
 * {@link coversPath} asks two questions in the order the spec asks them: the
 * permission dimension by **exact membership** (holding `dc.approve` says
 * nothing about `dc.create`), and only then the scope dimension, which
 * **inherits** (an ancestor covers its subtree). Merging them into one pass over
 * `scopes` would return the same booleans and would stop the asymmetry being
 * legible — which is how it gets simplified away later.
 *
 * ## Deny-by-default is the absence of a special case
 *
 * A subject with no bindings resolves to `{ permissions: [], scopes: {} }`, and
 * every function below answers `false` or `[]` for it without a branch that says
 * so. That is deliberate: a deny-by-default written as an explicit early return
 * is a deny-by-default somebody can delete.
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  JwtClaims,
  PermissionKey,
  ResolvedGrants,
  ScopePath,
} from '@plantops/contracts';
import type { PermissionRequirement } from './require-permission.decorator';

/**
 * The part of a token authorization actually reads: who, of what type, in which
 * tenant, on which session.
 *
 * Narrower than {@link JwtClaims} on purpose. `iss`, `iat` and `exp` are the
 * verifier's business and are finished with by the time this runs, and a port
 * that asked for them would oblige a host to carry them further than it needs
 * to — the IAM in particular hands its RLS layer exactly these four fields
 * (Doc 07 §5) and nothing else.
 */
export type SubjectClaims = Pick<JwtClaims, 'sub' | 'sty' | 'cid' | 'sid'>;

/** The ltree label separator. Spelled once. */
const SEPARATOR = '.';

/**
 * `path <@ prefix` — is `path` the prefix itself, or a descendant of it?
 *
 * The one definition of "beneath" in the workspace.
 */
export function pathIsWithin(path: ScopePath, prefix: ScopePath): boolean {
  return path === prefix || path.startsWith(`${prefix}${SEPARATOR}`);
}

/** Does the subject hold `permission` at all — the WHAT, on its own? */
export function holdsPermission(
  grants: ResolvedGrants,
  permission: PermissionKey,
): boolean {
  return grants.permissions.includes(permission);
}

/**
 * `can(subject, permissionKey, targetPath)` — Doc 04 §4.2's point check.
 *
 * O(covering paths for that permission), which the minimization Doc 04 §4.1
 * requires keeps small.
 */
export function coversPath(
  grants: ResolvedGrants,
  permission: PermissionKey,
  targetPath: ScopePath,
): boolean {
  if (!holdsPermission(grants, permission)) return false;

  const covering = grants.scopes[permission];
  return covering !== undefined && covering.some((path) => pathIsWithin(targetPath, path));
}

/**
 * The covered subtree roots for one permission — Doc 04 §5's query narrowing.
 *
 * ```sql
 * WHERE visitor.gate_path <@ ANY($1)
 * ```
 *
 * This is the practical payoff of storing scope as a path: a module filters a
 * list endpoint with one predicate instead of asking the IAM per row. The array
 * is already minimal (Doc 04 §4.1), so it is short even for a subject with many
 * bindings, and an empty one is the honest answer for a subject who may see
 * nothing — a module must treat `[]` as "no rows", never as "no filter".
 */
export function allowedPathsFor(
  grants: ResolvedGrants,
  permission: PermissionKey,
): ScopePath[] {
  return grants.scopes[permission] ?? [];
}

/** What the resolver concluded about one request. */
export const AuthorizationOutcome = {
  ALLOWED: 'allowed',
  /** The subject does not hold the permission anywhere. */
  PERMISSION_DENIED: 'permission_denied',
  /** They hold it, but not over the node the request named. */
  SCOPE_DENIED: 'scope_denied',
} as const;
export type AuthorizationOutcome =
  (typeof AuthorizationOutcome)[keyof typeof AuthorizationOutcome];

export interface AuthorizationDecision {
  outcome: AuthorizationOutcome;
  /**
   * What was asked for — carried through so the denial audit can name it.
   *
   * A list because a route may admit any one of several keys
   * (`require-permission.decorator.ts`), which on this surface is Doc 06 §12
   * and nothing else. Which keys are named depends on where the decision was
   * reached, and the difference is what makes the trail readable:
   *
   * - **`permission_denied`** — every key the route would have accepted, since
   *   the subject held none of them and all of them are the answer to "what
   *   would have let this through".
   * - **`scope_denied`** — only the keys the subject actually *holds*, because
   *   those are the ones the coverage test ran against; listing a key they
   *   never held would misreport a scope refusal as being about a permission
   *   that was never in play.
   * - **`allowed`** — the key that admitted, alone.
   */
  permissions: readonly PermissionKey[];
  /** The scope node the request named, where it named one. */
  scopeNodeId?: string;
}

/**
 * A subject's grants, and the path of the node a request named.
 *
 * Both come back from one call because they come from one connection: in the
 * IAM the grants may need a resolve against Postgres and the path always does,
 * and opening two connections for one authorization decision is two acquisitions
 * on the hot path (`docs/adr/0001-permission-guard-connection-strategy.md`).
 */
export interface AuthorizationSnapshot {
  grants: ResolvedGrants;
  /**
   * Present only when a `scopeNodeId` was asked for. `null` means no such node
   * is visible to this subject — which is deliberately the same answer for a
   * node that does not exist and a node belonging to another tenant, so that a
   * 403 cannot be used as a cross-tenant existence oracle (Doc 06 §2).
   */
  targetPath?: ScopePath | null;
}

/**
 * Where resolved grants come from.
 *
 * The IAM binds the resolution engine of Doc 04 §4 directly; a future module
 * binds a cached `iam-client` call to `/iam/permissions/resolve` (Doc 08 §4).
 * Neither shape is visible from here, which is the whole point of the port —
 * `auth-kit` may depend on `@plantops/contracts` and nothing else (Doc 08 §2),
 * so it cannot name a `DataSource` or an HTTP client even if it wanted to.
 */
export interface GrantsSource {
  /**
   * @param claims the verified claims of the request being authorized.
   * @param scopeNodeId when given, also resolve this node's path under the
   * subject's own tenant.
   */
  authorize(claims: SubjectClaims, scopeNodeId?: string): Promise<AuthorizationSnapshot>;
}

export const GRANTS_SOURCE = Symbol('auth-kit:GrantsSource');

/**
 * Turns a request-referenced node into a coverage answer, and hands modules the
 * `allowedPaths` they filter queries with (Doc 08 §4).
 *
 * Injectable so that a module's own services can ask the same questions the
 * guard asks — "which gates may this subject see?" is a query concern, not only
 * a routing one — and so the guard itself stays a thin adapter between Nest's
 * `ExecutionContext` and {@link ScopeResolver.decide}, which is where the rule
 * actually lives and where it can be unit-tested without a framework.
 */
@Injectable()
export class ScopeResolver {
  constructor(@Inject(GRANTS_SOURCE) private readonly source: GrantsSource) {}

  /** The subject's complete grant set (Doc 04 §4.1). */
  async grantsFor(claims: SubjectClaims): Promise<ResolvedGrants> {
    const { grants } = await this.source.authorize(claims);
    return grants;
  }

  /** Doc 04 §5's `allowedPaths`, for query narrowing. */
  async allowedPaths(
    claims: SubjectClaims,
    permission: PermissionKey,
  ): Promise<ScopePath[]> {
    return allowedPathsFor(await this.grantsFor(claims), permission);
  }

  /**
   * Doc 04 §4.2's point check, against a node named by id.
   *
   * A node this subject cannot see is `false`, never an error — the same answer
   * `POST /iam/permissions/check` gives, and for the same reason: a boolean
   * endpoint must not become a cross-tenant existence oracle (Doc 06 §2).
   */
  async covers(
    claims: SubjectClaims,
    permission: PermissionKey,
    scopeNodeId: string,
  ): Promise<boolean> {
    const snapshot = await this.source.authorize(claims, scopeNodeId);
    const targetPath = snapshot.targetPath ?? null;
    return targetPath !== null && coversPath(snapshot.grants, permission, targetPath);
  }

  /**
   * The whole authorization rule for one request, in the order Doc 04 §8 states
   * it: hold the permission, then cover the node.
   *
   * The order is not an optimisation — it decides which of the two denials the
   * caller (and the audit trail) gets. A subject who holds nothing gets
   * `PERMISSION_DENIED`; one who holds the permission but at the wrong place
   * gets `SCOPE_DENIED`, which is the difference between "you cannot do this"
   * and "not here" and is the only useful thing an operator can act on.
   *
   * ## A node the subject cannot see is not a coverage question
   *
   * When the source reports `targetPath: null` — no such node under this
   * subject's tenant — the decision is **allowed**, and the handler answers.
   * That looks like a hole and is the opposite of one.
   *
   * The source resolves the path under the same RLS context the request will
   * run under, derived from the same verified claims (Doc 07 §5). So a node
   * invisible here is invisible to the handler too: it will find nothing, and
   * answer the 404 or 409 that Doc 06 §2 fixes for a target that is absent or
   * belongs to another tenant. Refusing here instead would replace that
   * established answer with a 403 on every scoped route, which is a status code
   * moving under an authorization retrofit that is supposed to move none — and
   * it would buy nothing, because the two answers are equally uninformative
   * about whether the target exists elsewhere.
   *
   * What the guard *does* refuse is the case only it can see: a node the subject
   * can reach but does not **cover**. That is `SCOPE_DENIED`, and it is the
   * whole of the WHERE dimension at the routing layer.
   *
   * @param scopeNodeId already extracted from the request by the caller — the
   * guard reads it through `readScopeTarget`, a service may pass one it holds.
   */
  async decide(
    claims: SubjectClaims,
    requirement: PermissionRequirement,
    scopeNodeId?: string,
  ): Promise<AuthorizationDecision> {
    const scoped = requirement.scopeFrom !== undefined && scopeNodeId !== undefined;
    const snapshot = await this.source.authorize(
      claims,
      scoped ? scopeNodeId : undefined,
    );

    const at = (scoped ? { scopeNodeId } : {}) as { scopeNodeId?: string };

    // Held first, covered second — Doc 04 §9's asymmetry, over however many keys
    // the route admits. On the one-key routes this is `[key]` or `[]`, and every
    // branch below reads exactly as it did when the field was a single key.
    const held = requirement.permissions.filter((permission) =>
      holdsPermission(snapshot.grants, permission),
    );

    if (held.length === 0) {
      return {
        ...at,
        permissions: requirement.permissions,
        outcome: AuthorizationOutcome.PERMISSION_DENIED,
      };
    }

    // The route declared a target and the request did not supply one. Refused
    // unless the route said absence is legitimate — see `scopeOptional`.
    if (requirement.scopeFrom !== undefined && scopeNodeId === undefined) {
      return requirement.scopeOptional
        ? { ...at, permissions: [held[0]], outcome: AuthorizationOutcome.ALLOWED }
        : { ...at, permissions: held, outcome: AuthorizationOutcome.SCOPE_DENIED };
    }

    if (!scoped) {
      return { ...at, permissions: [held[0]], outcome: AuthorizationOutcome.ALLOWED };
    }

    // Invisible to this subject: not a coverage question — see above.
    const targetPath = snapshot.targetPath ?? null;
    if (targetPath === null) {
      return { ...at, permissions: [held[0]], outcome: AuthorizationOutcome.ALLOWED };
    }

    const covering = held.find((permission) =>
      coversPath(snapshot.grants, permission, targetPath),
    );

    return covering === undefined
      ? { ...at, permissions: held, outcome: AuthorizationOutcome.SCOPE_DENIED }
      : { ...at, permissions: [covering], outcome: AuthorizationOutcome.ALLOWED };
  }
}
