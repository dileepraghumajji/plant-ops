/**
 * Request bodies for `/auth/*` (Doc 06 §3).
 *
 * The field names are the spec's — `client_slug`, not `clientSlug`. Doc 06 §3
 * writes the login body as `{ email, password, client_slug }`, and this is a
 * published contract that `iam-client`, `admin-web` and every future module
 * code against; renaming it here to match an internal convention would be a
 * breaking change made for tidiness.
 *
 * Every schema is `z.object`, which **strips** unknown keys rather than merely
 * tolerating them (see `validation.pipe.ts`). On an authentication endpoint
 * that is load-bearing: a body carrying an extra `status` or `client_id` cannot
 * reach a service that might one day read it.
 */

import { z } from 'zod';
import { createZodDto } from '../common/validation.pipe';
import { PASSWORD_MAX_LENGTH } from './password.util';

/**
 * Slugs are the tenant half of the login credential (Doc 01 §3.4). Bounded and
 * character-restricted here because the value reaches a database lookup and an
 * audit payload before anything has authenticated.
 */
const clientSlug = z
  .string()
  .trim()
  .min(1, 'client_slug is required')
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'client_slug must be lowercase alphanumeric or hyphen');

/**
 * Lowercased on the way in, because `user.email` is stored lowercased
 * (migration 0003) and a login that fails on capitalisation is a support ticket
 * nobody can diagnose.
 */
const email = z
  .string()
  .trim()
  .min(1, 'email is required')
  .max(320)
  .transform((value) => value.toLowerCase());

/**
 * Bounded but **not** policy-checked.
 *
 * The minimum length in `password.util.ts` governs *setting* a password. Here
 * it would be actively harmful: rejecting a short password at login tells the
 * caller their guess was wrong before it is checked, and it would lock out
 * every account whose password predates a later policy change. The maximum
 * stays, because argon2id will hash whatever it is handed and an unbounded
 * field is unbounded memory-hard work per request.
 */
const loginPassword = z.string().min(1, 'password is required').max(PASSWORD_MAX_LENGTH);

export const loginSchema = z.object({
  email,
  password: loginPassword,
  client_slug: clientSlug,
  /**
   * What a session list shows instead of a row of uuids (Doc 01 §4.7) — "Gate-3
   * Terminal". Optional, caller-chosen, and therefore length-bounded: it is
   * stored and rendered back into an admin screen.
   */
  device_label: z.string().trim().max(120).optional(),
});

export class LoginDto extends createZodDto(loginSchema) {}
