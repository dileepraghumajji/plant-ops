/**
 * `@plantops/config` — the validated environment schema every app boots
 * through (Doc 08 §5).
 *
 * Depends only on `@plantops/contracts`, whose constants supply the defaults,
 * so the IAM and future modules cannot drift apart on token lifetimes or the
 * clock-skew leeway.
 */

export * from './env.schema.js';
export * from './load-env.js';

/**
 * Re-exported for Doc 03 §6, which names `libs/config` as the home of the
 * shared clock-skew leeway. The value itself lives in `@plantops/contracts`
 * (zero-dependency, importable by browser consumers too); this keeps both
 * import paths valid without a second declaration.
 */
export {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_SKEW_LEEWAY_SECONDS,
  GRANTS_CACHE_TTL_SECONDS,
  REFRESH_REUSE_GRACE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  SERVICE_ACCESS_TOKEN_TTL_SECONDS,
} from '@plantops/contracts';
