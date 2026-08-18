'use client';

/**
 * The one provider a PlantOps console mounts to become an IAM client.
 *
 * It owns the `IamClient`, the browser token store, and the answer to "is
 * someone signed in". Everything else in this library — grants, permissions,
 * navigation — reads from it.
 *
 * ## Why the client and the session state live in one component
 *
 * They are one thing wearing two hats. `IamClient` already performs the token
 * lifecycle: it renews an access token before it lapses, it retries a `401`
 * after a single shared refresh, and it drops the pair when a refresh is
 * refused (`libs/iam-client/src/auth.ts`). React needs to *know* when that
 * happens, and splitting the client into one provider and the session state
 * into another means wiring a callback from the first into the second and
 * hoping neither remounts. Instead the store is observable, both providers'
 * jobs happen here, and the two can never disagree.
 *
 * ## Three ways a session ends, all handled the same way
 *
 * The user signs out; a refresh is refused because the token was revoked,
 * expired or replayed (Doc 03 §4.1); or another tab does either. All three end
 * as a `null` write to the token store, and the store's subscription is what
 * flips this provider to `unauthenticated` — so the console reacts identically
 * whether the reason was local, remote or in a different tab.
 *
 * ## Silent refresh
 *
 * `IamClient` renews on demand: the renewal happens when a request asks for a
 * token. A console that has been sitting on a dashboard for twenty minutes
 * makes no requests, so its access token lapses and the *next* click pays for a
 * refresh — or fails, if the refresh token has expired meanwhile. The keepalive
 * below asks for the token on a timer and when the tab regains focus, which
 * turns that into a renewal nobody sees. It is not a second refresh mechanism:
 * it calls the same single-flight `accessToken()` every request calls.
 */

import {
  IamClient,
  type FetchLike,
  type LoginInput,
  type SessionEndReason,
} from '@plantops/iam-client';
import * as React from 'react';

import { readTokenClaims, type UnverifiedClaims } from './claims';
import {
  BrowserTokenStore,
  TOKEN_STORAGE_KEY,
  type IdentityHint,
  type StoredSession,
} from './token-store';

/** How often the keepalive asks for a token. Well inside the 15-minute TTL. */
const KEEPALIVE_INTERVAL_MS = 60_000;

export type AuthStatus = 'initializing' | 'authenticated' | 'unauthenticated';

/** Who is signed in, as far as the browser can tell. Display only — see `claims.ts`. */
export interface AuthSubject {
  /** `sub` — the user or service-account id. */
  id: string;
  /** `sty` — human or machine. */
  type: 'user' | 'service';
  /** `cid` — the tenant. */
  clientId: string;
  /** `sid` — the session, which is what `POST /auth/sessions/:id/revoke` kills. */
  sessionId: string;
  /** Epoch milliseconds the access token lapses at. */
  expiresAt: number;
  /** What the person typed at the login screen, kept so the header can say it. */
  email: string | null;
  clientSlug: string | null;
}

export interface AuthContextValue {
  status: AuthStatus;
  subject: AuthSubject | null;
  /** Why the last session ended — `'refresh_failed'` is worth telling the user. */
  endedReason: SessionEndReason | null;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * The tenant of the last successful sign-in, for pre-filling the login form.
   *
   * Survives sign-out on purpose: the client slug is not a secret, and asking
   * someone to retype their organisation's name every morning is the kind of
   * friction that gets a console described as annoying.
   */
  lastClientSlug: string | null;
}

const IamClientContext = React.createContext<IamClient | null>(null);
const AuthContext = React.createContext<AuthContextValue | null>(null);

/** The typed IAM client. Throws outside an {@link IamProvider}. */
export function useIam(): IamClient {
  const client = React.useContext(IamClientContext);
  if (client === null) {
    throw new Error('useIam() requires an <IamProvider> above it in the tree.');
  }
  return client;
}

/** Session state and the sign-in/sign-out actions. */
export function useAuth(): AuthContextValue {
  const auth = React.useContext(AuthContext);
  if (auth === null) {
    throw new Error('useAuth() requires an <IamProvider> above it in the tree.');
  }
  return auth;
}

export interface IamProviderProps {
  /** The API origin, without the `/iam` or `/auth` prefix. */
  baseUrl: string;
  children: React.ReactNode;
  /** `localStorage` slot for the token pair. */
  storageKey?: string;
  /** Remembers the tenant across sign-outs, for the login form. */
  clientSlugStorageKey?: string;
  /** Abort a request that has taken this long. */
  timeoutMs?: number;
  /**
   * Overrides the runtime's `fetch` — for a test, or for instrumentation.
   *
   * The escape hatch that keeps this provider testable without a network: a
   * spec supplies a function and asserts on what the console actually sent.
   */
  fetch?: FetchLike;
}

/** Where the remembered tenant lives. Not a credential; see `lastClientSlug`. */
const CLIENT_SLUG_STORAGE_KEY = 'plantops.last-client-slug';

function readLocal(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable; the field simply will not pre-fill */
  }
}

function subjectFrom(session: StoredSession | null): AuthSubject | null {
  const claims: UnverifiedClaims | null = readTokenClaims(
    session?.tokens.accessToken ?? null,
  );
  if (claims === null) return null;

  return {
    id: claims.sub,
    type: claims.sty,
    clientId: claims.cid,
    sessionId: claims.sid,
    expiresAt: claims.exp * 1000,
    email: session?.identity?.email ?? null,
    clientSlug: session?.identity?.clientSlug ?? null,
  };
}

export function IamProvider({
  baseUrl,
  children,
  storageKey = TOKEN_STORAGE_KEY,
  clientSlugStorageKey = CLIENT_SLUG_STORAGE_KEY,
  timeoutMs,
  fetch,
}: IamProviderProps): React.ReactElement {
  // Why the session ended, reported by the client.
  //
  // Routed through a ref because the client is constructed once, before the
  // setter it needs exists, and because the ordering matters: `TokenSession`
  // clears the store *first* and calls this *second* (`auth.ts`'s `forget`), so
  // the store subscription below has already run by the time the reason
  // arrives. Both writes land in one React batch and the reason wins, which is
  // what makes "your session expired" distinguishable from "you signed out".
  const reportSessionEnd = React.useRef<(reason: SessionEndReason) => void>(() => {
    /* replaced below, before any request can fail */
  });

  const [{ client, store }] = React.useState(() => {
    const tokenStore = new BrowserTokenStore(storageKey);
    return {
      store: tokenStore,
      client: new IamClient({
        baseUrl,
        tokenStore,
        timeoutMs,
        fetch,
        onSessionEnded: (reason) => reportSessionEnd.current(reason),
      }),
    };
  });

  const [status, setStatus] = React.useState<AuthStatus>('initializing');
  const [subject, setSubject] = React.useState<AuthSubject | null>(null);
  const [endedReason, setEndedReason] = React.useState<SessionEndReason | null>(null);
  const [lastClientSlug, setLastClientSlug] = React.useState<string | null>(null);

  reportSessionEnd.current = setEndedReason;

  React.useEffect(() => {
    const apply = (session: StoredSession | null): void => {
      const next = subjectFrom(session);
      setSubject(next);
      setStatus(next === null ? 'unauthenticated' : 'authenticated');
      // Only cleared on the way *in*. On the way out the reason is the client's
      // to report, and overwriting it here with `null` would erase it.
      if (next !== null) setEndedReason(null);
    };

    // The first read is what turns `initializing` into a real answer. It runs
    // in an effect rather than during render because `localStorage` does not
    // exist on the server, and rendering "signed in" on the client while the
    // server rendered "signed out" would discard the tree.
    apply(store.readSession());

    // Unsubscribing also detaches the store's `storage` listener when this is
    // the last subscriber, so there is nothing further to tear down — and
    // nothing that React's development double-mount can tear down permanently.
    return store.subscribe(apply);
  }, [store]);

  React.useEffect(() => {
    setLastClientSlug(readLocal(clientSlugStorageKey));
  }, [clientSlugStorageKey]);

  // The keepalive. `accessToken()` renews when the token is within its leeway
  // and is otherwise free, so this costs one function call a minute.
  React.useEffect(() => {
    if (status !== 'authenticated') return;

    const touch = (): void => {
      void client.session.accessToken();
    };
    const timer = setInterval(touch, KEEPALIVE_INTERVAL_MS);
    const onVisible = (): void => {
      if (globalThis.document?.visibilityState === 'visible') touch();
    };
    globalThis.addEventListener?.('visibilitychange', onVisible);
    globalThis.addEventListener?.('online', touch);

    return () => {
      clearInterval(timer);
      globalThis.removeEventListener?.('visibilitychange', onVisible);
      globalThis.removeEventListener?.('online', touch);
    };
  }, [client, status]);

  const login = React.useCallback<AuthContextValue['login']>(
    async (input) => {
      await client.auth.login(input);
      // Written after the login lands, so a failed attempt does not overwrite
      // the tenant that worked yesterday.
      store.writeIdentity({
        email: input.email,
        clientSlug: input.client_slug,
      } satisfies IdentityHint);
      writeLocal(clientSlugStorageKey, input.client_slug);
      setLastClientSlug(input.client_slug);
    },
    [client, store, clientSlugStorageKey],
  );

  const logout = React.useCallback(async () => {
    // `IamClient.auth.logout()` revokes server-side and clears locally even if
    // the revocation call fails — and clearing calls `onSessionEnded('logout')`,
    // so the reason and the status both arrive without further help here.
    await client.auth.logout();
  }, [client]);

  const auth = React.useMemo<AuthContextValue>(
    () => ({ status, subject, endedReason, login, logout, lastClientSlug }),
    [status, subject, endedReason, login, logout, lastClientSlug],
  );

  return (
    <IamClientContext.Provider value={client}>
      <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
    </IamClientContext.Provider>
  );
}
