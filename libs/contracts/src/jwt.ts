/**
 * Identity contract — the access-token claim shape (Doc 03 §2) and the token
 * responses `/auth/*` returns (Doc 06 §3).
 */

/** WHO: a human `user` or a machine `service_account` (Doc 00 §2). */
export const SubjectType = {
  USER: 'user',
  SERVICE: 'service',
} as const;
export type SubjectType = (typeof SubjectType)[keyof typeof SubjectType];

/**
 * Access-token claims — exactly these seven, nothing more (Doc 03 §2).
 *
 * Permissions, roles and scope nodes are deliberately absent: they are resolved
 * from `/iam/permissions/resolve` and cached, so a grant change takes effect on
 * invalidation rather than on token expiry.
 *
 * Platform-admin status is *not* a claim either — it is derived from the
 * subject's binding at the platform scope root (Doc 04 §10).
 */
export interface JwtClaims {
  /** Issuer — always {@link IAM_ISSUER}. */
  iss: string;
  /** Subject: `user.id` or `service_account.id`. */
  sub: string;
  /** Subject type. */
  sty: SubjectType;
  /** Tenant — `client_id`. The *only* trustworthy source of tenant (Doc 07 §5). */
  cid: string;
  /** Session id, for revocation. Ephemeral for service tokens (Doc 03 §5). */
  sid: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

/**
 * The claim names an access token may carry, in Doc 03 §2 order. Used by the
 * token service's shape test — an extra claim is a spec violation, not a
 * harmless addition.
 */
export const JWT_CLAIM_KEYS = [
  'iss',
  'sub',
  'sty',
  'cid',
  'sid',
  'iat',
  'exp',
] as const satisfies readonly (keyof JwtClaims)[];

export type JwtClaimKey = (typeof JWT_CLAIM_KEYS)[number];

/** `POST /auth/login` body (Doc 06 §3). */
export interface LoginRequest {
  email: string;
  password: string;
  client_slug: string;
}

/** `POST /auth/refresh` body (Doc 06 §3). */
export interface RefreshRequest {
  refresh_token: string;
}

/** `POST /auth/token` body — client-credentials exchange (Doc 03 §5). */
export interface ServiceTokenRequest {
  account_key: string;
  account_secret: string;
}

/** Login / refresh response (Doc 06 §3). */
export interface TokenPairResponse {
  access_token: string;
  refresh_token: string;
  /** Access-token lifetime in seconds. */
  expires_in: number;
}

/** Service-account token response — no refresh token by design (Doc 03 §5). */
export interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * `POST /iam/introspect` response (Doc 06 §11). Inactive tokens carry no
 * identity fields — never leak subject data for a token that failed
 * verification.
 */
export type IntrospectResponse =
  | { active: false }
  | {
      active: true;
      sub: string;
      sty: SubjectType;
      cid: string;
      sid: string;
    };

/** One entry of `/iam/.well-known/jwks.json` (Doc 03 §1). */
export interface JwkDTO {
  kty: string;
  use?: string;
  alg?: string;
  kid: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface JwksResponse {
  keys: JwkDTO[];
}
