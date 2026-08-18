/**
 * `/auth/*` — Doc 06 §3.
 *
 * The only endpoint module that touches state: a login, a refresh and a service
 * token all produce credentials, and dropping them into {@link TokenSession} is
 * the whole reason a consumer never has to think about the `Authorization`
 * header. Logout does the reverse on both sides of the wire — the server
 * revokes the session, the client forgets the tokens — and both happen even if
 * the call fails, because a caller who asked to be logged out is logged out.
 */

import type {
  AccessTokenResponse,
  LoginRequest,
  ServiceTokenRequest,
  SessionDTO,
  TokenPairResponse,
} from '@plantops/contracts';
import { AUTH_ROUTE_PREFIX } from '@plantops/contracts';

import type { TokenSession } from '../auth.js';
import type { Requester } from '../http.js';

/**
 * `POST /auth/login`, plus the device label.
 *
 * The label is what makes the session list of Doc 06 §3 actionable — "Gate-3
 * Terminal" rather than a uuid — and the endpoint has always accepted it. It is
 * absent from `LoginRequest` in `@plantops/contracts`, so it is added here
 * rather than silently dropped.
 */
export interface LoginInput extends LoginRequest {
  device_label?: string;
}

/** `POST /auth/password/reset-request` (Doc 06 §3). */
export interface PasswordResetRequestInput {
  email: string;
  client_slug: string;
}

/** `POST /auth/password/reset` (Doc 06 §3). */
export interface PasswordResetInput {
  token: string;
  new_password: string;
}

export interface AuthApi {
  /** Human login. Stores the pair; the client is authenticated when it returns. */
  login(input: LoginInput): Promise<TokenPairResponse>;
  /**
   * Renews explicitly. Shares the single in-flight exchange with the automatic
   * refresh, so calling it during a burst costs nothing extra.
   */
  refresh(): Promise<TokenPairResponse>;
  /** Service-account client-credentials exchange. No refresh token by design. */
  serviceToken(input: ServiceTokenRequest): Promise<AccessTokenResponse>;
  /** Revokes the current session server-side and forgets the tokens locally. */
  logout(): Promise<void>;
  /** The caller's own sessions — never anybody else's (Doc 03 §6). */
  sessions(): Promise<SessionDTO[]>;
  revokeSession(sessionId: string): Promise<void>;
  requestPasswordReset(input: PasswordResetRequestInput): Promise<void>;
  resetPassword(input: PasswordResetInput): Promise<void>;
}

export function authEndpoints(
  request: Requester,
  session: TokenSession,
  /** Fired whenever the subject behind the tokens may have changed. */
  onIdentityChange: () => void,
): AuthApi {
  return {
    async login(input) {
      const pair = await request<TokenPairResponse>({
        method: 'POST',
        path: `${AUTH_ROUTE_PREFIX}/login`,
        body: input,
        auth: 'none',
      });
      await session.adopt(pair);
      onIdentityChange();
      return pair;
    },

    async refresh() {
      const pair = await session.refresh();
      onIdentityChange();
      return pair;
    },

    async serviceToken(input) {
      const token = await request<AccessTokenResponse>({
        method: 'POST',
        path: `${AUTH_ROUTE_PREFIX}/token`,
        body: input,
        auth: 'none',
      });
      await session.adopt(token);
      onIdentityChange();
      return token;
    },

    async logout() {
      try {
        await request<void>({
          method: 'POST',
          path: `${AUTH_ROUTE_PREFIX}/logout`,
          body: {},
        });
      } finally {
        // Local state is cleared even when the revocation call failed. The
        // alternative — staying "logged in" because the network was down —
        // leaves a token in a store the user believes they have emptied.
        await session.clear();
        onIdentityChange();
      }
    },

    sessions() {
      return request<SessionDTO[]>({
        method: 'GET',
        path: `${AUTH_ROUTE_PREFIX}/sessions`,
      });
    },

    revokeSession(sessionId) {
      return request<void>({
        method: 'POST',
        path: `${AUTH_ROUTE_PREFIX}/sessions/${encodeURIComponent(sessionId)}/revoke`,
      });
    },

    requestPasswordReset(input) {
      return request<void>({
        method: 'POST',
        path: `${AUTH_ROUTE_PREFIX}/password/reset-request`,
        body: input,
        auth: 'none',
      });
    },

    resetPassword(input) {
      return request<void>({
        method: 'POST',
        path: `${AUTH_ROUTE_PREFIX}/password/reset`,
        body: input,
        auth: 'none',
      });
    },
  };
}
