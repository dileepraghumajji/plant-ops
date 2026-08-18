/**
 * The endpoint modules, one per section of Doc 06.
 *
 * Each exports an interface and a factory that takes a {@link Requester} and
 * nothing else. That shape is what keeps `client.ts` from becoming a
 * thousand-line class, and it is what lets a consumer that wants only one
 * surface — a migration script that talks to the registry, say — build it
 * without a token store or a cache.
 */

export * from './applications.js';
export * from './audit.js';
export * from './auth.js';
export * from './authz.js';
export * from './bindings.js';
export * from './clients.js';
export * from './navigation.js';
export * from './roles.js';
export * from './scopes.js';
export * from './service-accounts.js';
export * from './users.js';
