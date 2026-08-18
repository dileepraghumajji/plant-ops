'use client';

/**
 * Where a browser keeps its tokens, and how the tabs agree about them.
 *
 * `@plantops/iam-client` deliberately names no storage mechanism — its
 * `TokenStore` is a two-method port and its default keeps tokens in memory,
 * which is right for a service process and useless for a console, where a page
 * reload would sign the user out. This is the browser half of that port.
 *
 * ## Why `localStorage`, and what that costs
 *
 * The console and the API are separate origins (Doc 08 §6 — Vercel and
 * Railway), so a cookie would have to be `SameSite=None; Secure` on a shared
 * parent domain, and the IAM would need CSRF defences for every mutating route
 * because the browser would then attach it automatically. The IAM is a bearer-
 * token API by design (Doc 03): nothing it exposes is authorised by ambient
 * credentials, so there is no CSRF surface to defend — and putting the token
 * back into a cookie would create one.
 *
 * The honest cost is XSS: script running on this origin can read the tokens.
 * That is mitigated rather than eliminated — short access tokens (15 min,
 * `ACCESS_TOKEN_TTL_SECONDS`), rotating refresh tokens with reuse detection
 * (Doc 03 §4), and revocation that takes effect within seconds (Doc 03 §6) —
 * and the residual risk is accepted knowingly here rather than by default. A
 * deployment that disagrees implements this interface differently; nothing else
 * changes.
 *
 * ## Cross-tab
 *
 * Two tabs share one origin and therefore one store. Without the `storage`
 * listener, signing out in one tab leaves the other showing a console whose
 * every request now fails, and signing *in* in one tab leaves the other on the
 * login screen. The listener makes both immediate. It fires only in the *other*
 * tabs — the writing tab never hears its own event — so a local change notifies
 * through {@link BrowserTokenStore.write} instead.
 */

import type { StoredTokens, TokenStore } from '@plantops/iam-client';

/** Default slot. Namespaced so two PlantOps consoles on one host can differ. */
export const TOKEN_STORAGE_KEY = 'plantops.tokens';

/**
 * Display-only facts about the signed-in person, kept beside the tokens.
 *
 * The access token carries `sub`/`cid`/`sid` and nothing human-readable
 * (Doc 03 §2 — exactly seven claims), so after a reload the console knows *who*
 * in the sense of a uuid and cannot put a name in the header. These two strings
 * come from what the user typed at the login screen and exist purely so the
 * header can say something true. Nothing is authorised from them.
 */
export interface IdentityHint {
  email: string;
  clientSlug: string;
}

export interface StoredSession {
  tokens: StoredTokens;
  identity: IdentityHint | null;
}

export type TokenStoreListener = (session: StoredSession | null) => void;

function safeParse(raw: string | null): StoredSession | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { tokens, identity } = parsed as Partial<StoredSession>;
    if (
      typeof tokens !== 'object' ||
      tokens === null ||
      typeof tokens.accessToken !== 'string'
    ) {
      return null;
    }
    return {
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: typeof tokens.refreshToken === 'string' ? tokens.refreshToken : null,
        expiresAt: typeof tokens.expiresAt === 'number' ? tokens.expiresAt : null,
      },
      identity:
        identity != null &&
        typeof identity.email === 'string' &&
        typeof identity.clientSlug === 'string'
          ? { email: identity.email, clientSlug: identity.clientSlug }
          : null,
    };
  } catch {
    // A hand-edited or half-written entry is treated as "signed out" rather
    // than crashing the shell. The user signs in again; nothing is lost that
    // was not already unusable.
    return null;
  }
}

/**
 * A `TokenStore` backed by `localStorage`, with change notification.
 *
 * Safe to construct during server rendering: every method tolerates the absence
 * of `window`, answering "no session", which is the correct answer on a server
 * that has no user.
 */
export class BrowserTokenStore implements TokenStore {
  private readonly listeners = new Set<TokenStoreListener>();
  private readonly onStorage: (event: StorageEvent) => void;

  constructor(private readonly storageKey: string = TOKEN_STORAGE_KEY) {
    this.onStorage = (event) => {
      if (event.storageArea !== this.storage()) return;
      if (event.key !== null && event.key !== this.storageKey) return;
      this.emit(this.readSession());
    };
  }

  /**
   * Notified on every change, in this tab and in others.
   *
   * The `storage` listener is attached with the first subscriber and detached
   * with the last, rather than in the constructor. That is what makes the store
   * survive React's development double-mount: a listener attached at
   * construction and removed on unmount is gone for good after the first
   * remount — cross-tab sign-out then silently stops working, in development
   * only, which is the worst place for it to hide.
   */
  subscribe(listener: TokenStoreListener): () => void {
    if (this.listeners.size === 0) {
      globalThis.addEventListener?.('storage', this.onStorage);
    }
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        globalThis.removeEventListener?.('storage', this.onStorage);
      }
    };
  }

  /** Drops every subscriber and the window listener with them. */
  dispose(): void {
    this.listeners.clear();
    globalThis.removeEventListener?.('storage', this.onStorage);
  }

  read(): StoredTokens | null {
    return this.readSession()?.tokens ?? null;
  }

  write(tokens: StoredTokens | null): void {
    if (tokens === null) {
      this.clear();
      return;
    }
    // A refresh rotates the tokens and knows nothing about the identity hint,
    // so the hint is carried across rather than dropped on every renewal.
    this.writeSession({ tokens, identity: this.readSession()?.identity ?? null });
  }

  readSession(): StoredSession | null {
    try {
      return safeParse(this.storage()?.getItem(this.storageKey) ?? null);
    } catch {
      return null;
    }
  }

  /** Records who signed in, for the header. Never used to authorise anything. */
  writeIdentity(identity: IdentityHint | null): void {
    const current = this.readSession();
    if (current === null) return;
    this.writeSession({ ...current, identity });
  }

  clear(): void {
    try {
      this.storage()?.removeItem(this.storageKey);
    } catch {
      /* storage unavailable — nothing was written to remove */
    }
    this.emit(null);
  }

  private writeSession(session: StoredSession): void {
    try {
      this.storage()?.setItem(this.storageKey, JSON.stringify(session));
    } catch {
      // Quota, private mode, or a policy that blocks storage. The session still
      // works for this page's lifetime through the client's in-memory copy; it
      // simply will not survive a reload.
    }
    this.emit(session);
  }

  private storage(): Storage | null {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private emit(session: StoredSession | null): void {
    for (const listener of this.listeners) listener(session);
  }
}
