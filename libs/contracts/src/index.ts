/**
 * `@plantops/contracts` — the public contract of the PlantOps IAM (Doc 08 §3).
 *
 * Framework-agnostic types and constants only, with **zero dependencies**, so
 * every app, lib, and future operational module can import it without pulling
 * anything else in. Keep it stable: changes here ripple to every consumer.
 */

export * from './clients.js';
export * from './constants.js';
export * from './errors.js';
export * from './grants.js';
export * from './jwt.js';
export * from './manifest.js';
export * from './nav.js';
export * from './pagination.js';
export * from './registry.js';
export * from './roles.js';
export * from './scopes.js';
export * from './service-accounts.js';

/**
 * The compile-time assertion helpers (Doc 08 §7).
 *
 * Type-only and therefore free at runtime, and exported from the barrel since
 * Session H6: `iam-api`'s `openapi/schemas.spec.ts` pins every response schema
 * to the interface above it with `Expect<Equal<…>>`, and a helper that a second
 * workspace consumer needs belongs on the public surface rather than behind a
 * deep import.
 */
export * from './type-assertions.js';
