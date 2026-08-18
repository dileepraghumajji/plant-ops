'use client';

/**
 * "Fetch this when the screen opens, and tell me how it went."
 *
 * Every screen in every console does the same four things: call one endpoint,
 * show a skeleton while it is in flight, show the failure if it fails, and
 * offer a reload. Written per screen, it is four `useState`s and a race
 * condition — the classic one where a slow first request resolves after a fast
 * second and overwrites it.
 *
 * This is deliberately small. It is not a data-fetching library: no cache, no
 * deduplication, no background revalidation. Those matter when many components
 * request the same thing; an admin console's screens each own their data, and
 * the two things that genuinely are shared — grants and navigation — have their
 * own providers precisely so they are fetched once.
 */

import * as React from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  /** True while a request is in flight, including a reload with data present. */
  loading: boolean;
  /** Re-runs the request. Safe to pass straight to a retry button. */
  reload: () => void;
}

export interface UseAsyncOptions {
  /**
   * Hold off until this is true — for a request that needs something the screen
   * does not have yet (a session, a route parameter). While false the hook
   * reports `loading: false` with no data, which is the truth: nothing was
   * asked for.
   */
  enabled?: boolean;
}

/**
 * Runs `request` when `deps` change, and again on `reload()`.
 *
 * `request` is called with an `AbortSignal`; passing it on is optional but
 * turns an abandoned request into a cancelled one. Results from a superseded
 * call are dropped either way — the generation counter below is what makes the
 * race impossible rather than merely unlikely.
 */
export function useAsync<T>(
  request: (signal: AbortSignal) => Promise<T>,
  deps: React.DependencyList,
  options: UseAsyncOptions = {},
): AsyncState<T> {
  const { enabled = true } = options;

  const [data, setData] = React.useState<T | undefined>(undefined);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(enabled);
  const [nonce, setNonce] = React.useState(0);

  // The latest `request` without making it a dependency: a caller writing an
  // inline arrow — which is every caller — would otherwise re-fetch on every
  // render. `deps` is the caller's explicit statement of what the request
  // depends on, and it is the only thing that should trigger one.
  const requestRef = React.useRef(request);
  requestRef.current = request;

  React.useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let current = true;

    setLoading(true);
    requestRef
      .current(controller.signal)
      .then((value) => {
        if (!current) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!current || controller.signal.aborted) return;
        setError(cause);
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
      controller.abort();
    };
    // `deps` is the caller's dependency list by design, and `request` is read
    // through a ref so an inline arrow does not re-fetch on every render. The
    // spread is what the rule cannot verify statically, and is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  const reload = React.useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { data, error, loading, reload };
}
