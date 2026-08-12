/**
 * A deadline for a promise that has none of its own.
 *
 * Used on every call into an external dependency from the request path or a
 * readiness probe. The point is not tidiness: a `/ready` handler awaiting a
 * wedged Postgres never answers at all, and an orchestrator reads silence as
 * an unexplained probe timeout rather than as "this instance is not ready".
 * Answering 503 in two seconds is the useful behaviour.
 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not complete within ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  work: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
        // Never hold the event loop open on behalf of a race that has already
        // been decided by the other side.
        timer.unref?.();
      }),
    ]);
  } finally {
    // The losing timer must be cleared even when `work` wins, or a two-second
    // handle survives every request that beat it.
    if (timer !== undefined) clearTimeout(timer);
  }
}
