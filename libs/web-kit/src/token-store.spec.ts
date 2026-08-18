import { BrowserTokenStore, TOKEN_STORAGE_KEY } from './token-store';

const TOKENS = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 1_700_000_900_000,
};

describe('BrowserTokenStore', () => {
  let store: BrowserTokenStore;

  beforeEach(() => {
    localStorage.clear();
    store = new BrowserTokenStore();
  });

  afterEach(() => {
    store.dispose();
  });

  it('round-trips a token pair through localStorage', () => {
    store.write(TOKENS);
    expect(store.read()).toEqual(TOKENS);
    expect(new BrowserTokenStore().read()).toEqual(TOKENS);
  });

  it('reports no session before anything is written', () => {
    expect(store.read()).toBeNull();
    expect(store.readSession()).toBeNull();
  });

  it('clears on a null write — which is how a sign-out reaches storage', () => {
    store.write(TOKENS);
    store.write(null);

    expect(store.read()).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  /**
   * A refresh rotates the pair (Doc 03 §4) and knows nothing about the display
   * hint. Dropping it on every renewal would empty the header fifteen minutes
   * after every sign-in.
   */
  it('keeps the identity hint across a token rotation', () => {
    store.write(TOKENS);
    store.writeIdentity({ email: 'ops@acme.test', clientSlug: 'acme' });

    store.write({ ...TOKENS, accessToken: 'access-2', refreshToken: 'refresh-2' });

    expect(store.readSession()?.identity).toEqual({
      email: 'ops@acme.test',
      clientSlug: 'acme',
    });
    expect(store.read()?.accessToken).toBe('access-2');
  });

  it('ignores an identity write when there is no session to attach it to', () => {
    store.writeIdentity({ email: 'ops@acme.test', clientSlug: 'acme' });
    expect(store.readSession()).toBeNull();
  });

  it('notifies subscribers on every local change', () => {
    const seen: (string | null)[] = [];
    store.subscribe((session) => seen.push(session?.tokens.accessToken ?? null));

    store.write(TOKENS);
    store.write(null);

    expect(seen).toEqual(['access-1', null]);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();

    store.write(TOKENS);

    expect(listener).not.toHaveBeenCalled();
  });

  /**
   * The other tab signed out. Without this the remaining tab keeps rendering a
   * console whose every request now fails.
   */
  it('reacts to another tab writing the same key', () => {
    const listener = jest.fn();
    store.subscribe(listener);

    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ tokens: TOKENS }));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: TOKEN_STORAGE_KEY,
        storageArea: localStorage,
      }),
    );

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: expect.objectContaining({ accessToken: 'access-1' }) }),
    );
  });

  /**
   * React's development double-mount subscribes, unsubscribes and subscribes
   * again. A `storage` listener attached at construction and removed on the
   * first teardown would be gone for good, and cross-tab sign-out would stop
   * working in development only.
   */
  it('still hears other tabs after a subscribe/unsubscribe/subscribe cycle', () => {
    store.subscribe(() => undefined)();

    const listener = jest.fn();
    store.subscribe(listener);

    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ tokens: TOKENS }));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: TOKEN_STORAGE_KEY,
        storageArea: localStorage,
      }),
    );

    expect(listener).toHaveBeenCalled();
  });

  it('ignores another tab writing an unrelated key', () => {
    const listener = jest.fn();
    store.subscribe(listener);

    window.dispatchEvent(
      new StorageEvent('storage', { key: 'something.else', storageArea: localStorage }),
    );

    expect(listener).not.toHaveBeenCalled();
  });

  /**
   * A half-written or hand-edited entry is treated as "signed out". The user
   * signs in again; nothing is lost that was not already unusable — where a
   * throw here would blank the console on load with no way back.
   */
  it.each([
    ['not JSON', 'not json at all'],
    ['JSON that is not an object', '"a string"'],
    ['an object with no tokens', '{"identity":{"email":"a","clientSlug":"b"}}'],
    ['tokens with no access token', '{"tokens":{"refreshToken":"r"}}'],
  ])('treats %s as no session', (_name, raw) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, raw);
    expect(new BrowserTokenStore().read()).toBeNull();
  });

  it('keeps two consoles on one host apart when given different keys', () => {
    const gatepass = new BrowserTokenStore('plantops.gatepass.tokens');
    gatepass.write(TOKENS);

    expect(store.read()).toBeNull();
    expect(gatepass.read()).toEqual(TOKENS);
    gatepass.dispose();
  });
});
