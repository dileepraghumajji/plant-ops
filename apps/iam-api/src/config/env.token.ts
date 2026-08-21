/**
 * The injection token for the validated environment (Doc 08 §5).
 *
 * ## Why it is not in `config.module.ts`
 *
 * It was, until `ConfigModule` grew a controller. `config.module.ts` now
 * imports `deployment.controller.ts`, which imports `deployment-mode.ts`, which
 * needs this token — a cycle, and under CommonJS transpilation a cycle through
 * a `const` is not a warning, it is a `ReferenceError: Cannot access 'ENV'
 * before initialization` thrown at import time by whichever file the loader
 * happened to reach first.
 *
 * A token has no dependencies of its own, so giving it a file of its own is the
 * whole fix — and every consumer now imports it from here rather than from the
 * module. `config.module.ts` deliberately does **not** re-export it: one import
 * path means the cycle cannot come back through a convenience alias.
 */

/** Injection token for the validated `EnvConfig`. */
export const ENV = Symbol('ENV');
