/**
 * Compile-time assertion helpers for the type-level tests (Doc 08 §7).
 *
 * These are checked by `nx typecheck` (the spec files are compiled by
 * `tsconfig.spec.json`); Jest's SWC transform strips types without checking
 * them, so a broken contract fails typecheck, not the test run.
 */

/** Fails to compile unless `T` is exactly `true`. */
export type Expect<T extends true> = T;

/** Exact (invariant) type equality — distinguishes `any`, unions, optionality. */
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/** True when `X` is assignable to `Y`. */
export type Extends<X, Y> = X extends Y ? true : false;

/** Keys of `T` whose values are required. */
export type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];
