/**
 * The token lifecycle: where credentials are kept, and when they are renewed.
 *
 * Separated from the `/auth/*` endpoint methods in `endpoints/auth.ts` on
 * purpose. Those are HTTP; this is state — and it is the state two very
 * different consumers need to control. A future operational module holds one
 * service-account token in memory for the process's lifetime; `admin-web` holds
 * a human's pair somewhere that survives a page reload, and would rather that
 * somewhere were its own decision than this library's (Doc 09 §1). So the store
 * is a two-method port, {@link MemoryTokenStore} is the default, and nothing
 * here ever names `localStorage`, a cookie, or a file.
 *
 * ## Single-flight refresh
 *
 * The property that matters, and the reason this is a class rather than a
 * closure over a variable. A screen that loads six panels issues six requests
 * with the same expired access token and gets six `401`s within a few
 * milliseconds of each other. Six refreshes would follow — and because
 * `POST /auth/refresh` **rotates** (Doc 03 §4), five of them would present a
 * token the first has already consumed, which the server is right to treat as
 * replay. One in-flight refresh is therefore not an optimisation but a
 * correctness requirement: {@link TokenSession.refresh} hands every concurrent
 * caller the same promise, and the reuse-detection grace window of Doc 03 §4.1
 * covers only what this cannot.
 */

import type { AccessTokenResponse, TokenPairResponse } from '@plantops/contracts';

/** What a store holds. Access token, its renewal, and when it lapses. */
export interface StoredTokens {
  accessToken: string;
  /** `null` for a service account: `POST /auth/token` issues no refresh token. */
  refreshToken: string | null;
  /**
   * Epoch milliseconds, derived from `expires_in` when the pair was issued, or
   * `null` when the tokens were adopted from elsewhere without one. `null`
   * disables proactive renewal — the token is then used until a `401` says
   * otherwise, which is correct, just one round trip slower.
   */
  expiresAt: number | null;
}

/**
 * Where tokens live between calls.
 *
 * Both methods may be async so that a store can be a keychain, an encrypted
 * file, or an `IndexedDB` handle. `write(null)` clears.
 */
export interface TokenStore {
  read(): StoredTokens | null | Promise<StoredTokens | null>;
  write(tokens: StoredTokens | null): void | Promise<void>;
}

/** The default: tokens last as long as the client object does. */
export class MemoryTokenStore implements TokenStore {
  private tokens: StoredTokens | null = null;

  read(): StoredTokens | null {
    return this.tokens;
  }

  write(tokens: StoredTokens | null): void {
    this.tokens = tokens;
  }
}

/** Why {@link TokenSessionOptions.onSessionEnded} fired. */
export type SessionEndReason = 'logout' | 'refresh_failed';

export interface TokenSessionOptions {
  store?: TokenStore;
  /** Injectable clock, so the expiry tests need no timers. */
  now?: () => number;
  /**
   * Renew this many seconds before the access token actually lapses.
   *
   * Zero would mean every renewal costs a wasted round trip — the request that
   * discovers the `401`. Thirty seconds is comfortably more than a slow request
   * plus the 60-second clock skew the server already tolerates
   * (`CLOCK_SKEW_LEEWAY_SECONDS`), and comfortably less than the 900-second
   * access-token lifetime, so it neither renews constantly nor cuts it fine.
   */
  refreshLeewaySeconds?: number;
  /**
   * Fired when the session is over: the caller logged out, or a refresh failed
   * and the stored tokens were dropped. `admin-web` sends the user to the login
   * screen from here (Doc 09 §1).
   */
  onSessionEnded?: (reason: SessionEndReason) => void;
}

const DEFAULT_REFRESH_LEEWAY_SECONDS = 30;

export class TokenSession {
  private readonly store: TokenStore;
  private readonly now: () => number;
  private readonly leewayMs: number;
  private readonly onSessionEnded:
    | ((reason: SessionEndReason) => void)
    | undefined;

  /** The one in-flight refresh every concurrent caller shares. */
  private pending: Promise<TokenPairResponse> | null = null;

  constructor(
    /** `POST /auth/refresh`, injected because it goes back through the transport. */
    private readonly exchangeRefreshToken: (
      refreshToken: string,
    ) => Promise<TokenPairResponse>,
    options: TokenSessionOptions = {},
  ) {
    this.store = options.store ?? new MemoryTokenStore();
    this.now = options.now ?? (() => Date.now());
    this.leewayMs =
      (options.refreshLeewaySeconds ?? DEFAULT_REFRESH_LEEWAY_SECONDS) * 1000;
    this.onSessionEnded = options.onSessionEnded;
  }

  /** What is stored right now, without renewing anything. */
  async tokens(): Promise<StoredTokens | null> {
    return (await this.store.read()) ?? null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.tokens()) !== null;
  }

  /**
   * The token to send, renewed first if it is about to lapse.
   *
   * A failed proactive renewal answers `null` rather than the token it could
   * not replace: the stored pair is gone by then, and sending a token this
   * object no longer holds would produce a `401` whose retry has nothing left
   * to refresh with.
   */
  async accessToken(): Promise<string | null> {
    const current = await this.tokens();
    if (current === null) return null;

    if (current.refreshToken !== null && this.expiringSoon(current)) {
      try {
        return (await this.refresh()).access_token;
      } catch {
        return null;
      }
    }

    return current.accessToken;
  }

  /**
   * The transport's `401` hook.
   *
   * Two things happen here that a plain "refresh on 401" would get wrong. The
   * first is the check that the stored token is still the one that failed: when
   * six requests race, five of them arrive after the refresh has already landed
   * and simply need retrying with what is now stored — no second refresh, and
   * no rotation of a token nobody has used yet. The second is that failure is
   * `false`, not an exception: the caller's original `401` is the honest answer
   * to their request, and replacing it with a refresh error would report the
   * wrong failed call.
   */
  async reauthorize(usedToken: string | null): Promise<boolean> {
    const current = await this.tokens();
    if (current === null) return false;
    if (usedToken !== null && current.accessToken !== usedToken) return true;
    if (current.refreshToken === null) return false;

    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Renews the pair, sharing one exchange with every concurrent caller.
   *
   * A failed refresh clears the store: the refresh token is either expired,
   * revoked, or has been replayed, and all three mean this session is over
   * (Doc 03 §4.1). Keeping it would guarantee that every later call spends a
   * round trip rediscovering the same thing.
   */
  async refresh(): Promise<TokenPairResponse> {
    if (this.pending !== null) return this.pending;

    this.pending = this.runRefresh().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async runRefresh(): Promise<TokenPairResponse> {
    const current = await this.tokens();
    if (current === null || current.refreshToken === null) {
      throw new Error('No refresh token: nothing to renew.');
    }

    try {
      const pair = await this.exchangeRefreshToken(current.refreshToken);
      await this.adopt(pair);
      return pair;
    } catch (error) {
      await this.forget('refresh_failed');
      throw error;
    }
  }

  /** Takes the tokens a login, refresh or service-token exchange returned. */
  async adopt(tokens: TokenPairResponse | AccessTokenResponse): Promise<void> {
    await this.store.write({
      accessToken: tokens.access_token,
      refreshToken: 'refresh_token' in tokens ? tokens.refresh_token : null,
      expiresAt:
        typeof tokens.expires_in === 'number'
          ? this.now() + tokens.expires_in * 1000
          : null,
    });
  }

  /** Adopts tokens from somewhere else — a server-rendered page, another tab. */
  async restore(tokens: StoredTokens | null): Promise<void> {
    await this.store.write(tokens);
  }

  /** Drops the tokens locally. The server-side revocation is `POST /auth/logout`. */
  async clear(): Promise<void> {
    await this.forget('logout');
  }

  private async forget(reason: SessionEndReason): Promise<void> {
    await this.store.write(null);
    this.onSessionEnded?.(reason);
  }

  private expiringSoon(tokens: StoredTokens): boolean {
    return tokens.expiresAt !== null && tokens.expiresAt - this.leewayMs <= this.now();
  }
}
