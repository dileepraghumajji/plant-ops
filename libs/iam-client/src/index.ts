/**
 * `@plantops/iam-client` — the typed way to call the PlantOps IAM (Doc 08 §2).
 *
 * `admin-web` consumes it today; every future operational module consumes it
 * instead of writing its own HTTP against `/iam/*`. It depends on
 * `@plantops/contracts` and nothing else — not on Nest, not on a fetch library,
 * not on the IAM's database layer — so the same build runs in a Node service and
 * in a browser.
 *
 * ```ts
 * const iam = new IamClient({ baseUrl: 'https://iam.plantops.example' });
 * await iam.auth.login({ email, password, client_slug: 'acme' });
 * const menu = await iam.navigation.tree();
 * const grants = await iam.grants();          // cached resolve
 * ```
 *
 * Three things it does that a hand-written `fetch` wrapper would not:
 *
 * - **Token lifecycle.** Login stores the pair, every request carries it, an
 *   expiring one is renewed before it is used, and a `401` is retried once after
 *   a *single* refresh no matter how many calls raced into it (`auth.ts`).
 * - **Typed both ways.** Requests take the request interfaces of
 *   `@plantops/contracts` and responses come back as its DTOs, so a change to
 *   the contract breaks the consumer at compile time rather than at runtime.
 * - **The error model.** Every failure is an {@link IamApiError} carrying the
 *   closed `IamErrorCode` table of Doc 06 §2 and the `requestId` that correlates
 *   it with the server's logs — including when something in front of the API
 *   answered instead.
 */

export * from './auth.js';
export * from './client.js';
export * from './endpoints/index.js';
export * from './errors.js';
export * from './http.js';
export * from './resolve-cache.js';
