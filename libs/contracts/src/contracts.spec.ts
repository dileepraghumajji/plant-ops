/**
 * Type-level tests for the public contract (Doc 08 §7).
 *
 * The assertions below are compile-time: they fail `nx typecheck`, not the Jest
 * run (SWC strips types without checking them). They are collected into one
 * exported tuple so each entry must still compile while nothing is reported as
 * an unused local. The runtime test at the bottom covers the value-level
 * companions.
 */

import type {
  ApplicationManifest,
  CachedGrants,
  IamErrorResponse,
  IntrospectResponse,
  JwtClaimKey,
  JwtClaims,
  ManifestNavNode,
  NavNodeDTO,
  NavigationResponse,
  Paginated,
  ResolvedGrants,
  SubjectType,
} from './index.js';
import type {
  Equal,
  Expect,
  Extends,
  RequiredKeys,
} from './type-assertions.js';
import { IamErrorCode, JWT_CLAIM_KEYS, NavNodeKind } from './index.js';

export type ContractTypeAssertions = [
  // --- JWT claims: exactly the seven of Doc 03 §2, no more -----------------
  Expect<
    Equal<
      JwtClaims,
      {
        iss: string;
        sub: string;
        sty: SubjectType;
        cid: string;
        sid: string;  
        iat: number;
        exp: number;
      }
    >
  >,
  // Every claim is mandatory — a token missing `cid` or `sid` is not a token.
  Expect<Equal<RequiredKeys<JwtClaims>, keyof JwtClaims>>,
  // The runtime key list and the type cannot drift apart.
  Expect<Equal<JwtClaimKey, keyof JwtClaims>>,
  // Permissions and roles are deliberately *not* claims (Doc 03 §2).
  Expect<Equal<'permissions' extends keyof JwtClaims ? true : false, false>>,
  Expect<Equal<'roles' extends keyof JwtClaims ? true : false, false>>,
  Expect<Equal<SubjectType, 'user' | 'service'>>,
  // An inactive introspection result carries no identity fields.
  Expect<Extends<{ active: false }, IntrospectResponse>>,

  // --- Grants ---------------------------------------------------------------
  Expect<
    Equal<
      ResolvedGrants,
      { permissions: string[]; scopes: Record<string, string[]> }
    >
  >,
  // The cached form adds the version counter used for invalidation (Doc 04 §7).
  Expect<Equal<CachedGrants['v'], number>>,
  Expect<Extends<CachedGrants, ResolvedGrants>>,

  // --- Navigation -----------------------------------------------------------
  Expect<Equal<NavNodeDTO['kind'], 'module' | 'menu' | 'sub_menu'>>,
  // `children` is always present (possibly empty), so consumers need no guard.
  Expect<Equal<'children' extends RequiredKeys<NavNodeDTO> ? true : false, true>>,
  // The cross-application shell variant returns no single application.
  Expect<Extends<null, NavigationResponse['application']>>,

  // --- Errors ---------------------------------------------------------------
  Expect<
    Extends<
      { error: { code: 'SCOPE_DENIED'; message: string; requestId: string } },
      IamErrorResponse
    >
  >,

  // --- Manifest -------------------------------------------------------------
  Expect<Equal<ManifestNavNode['kind'], NavNodeDTO['kind']>>,
  Expect<
    Equal<
      RequiredKeys<ApplicationManifest>,
      'key' | 'name' | 'permissions' | 'nav'
    >
  >,

  // --- Pagination -----------------------------------------------------------
  Expect<
    Equal<
      Paginated<{ id: string }>,
      { data: { id: string }[]; page: number; limit: number; total: number }
    >
  >,

  // --- The assertion helper itself is exact, not merely assignable ----------
  Expect<Equal<Equal<{ a: string }, { a?: string }>, false>>,
];

describe('contracts', () => {
  it('exposes the runtime companions of the type-level contract', () => {
    expect(JWT_CLAIM_KEYS).toEqual([
      'iss',
      'sub',
      'sty',
      'cid',
      'sid',
      'iat',
      'exp',
    ]);
    expect(Object.values(NavNodeKind)).toEqual(['module', 'menu', 'sub_menu']);
    expect(IamErrorCode.SCOPE_DENIED).toBe('SCOPE_DENIED');
  });
});
