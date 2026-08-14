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
import { PASSWORD_MAX_LENGTH, passwordSchema } from './password.util';
import { RESET_TOKEN_MAX_LENGTH } from './password-reset.util';
import { REFRESH_TOKEN_MAX_LENGTH } from './refresh-token.util';
import {
  SERVICE_ACCOUNT_KEY_MAX_LENGTH,
  SERVICE_ACCOUNT_SECRET_MAX_LENGTH,
} from './service-credentials.util';

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

/**
 * Bounded, and otherwise unexamined.
 *
 * The shape check lives in `parseRefreshToken`, not here, and the difference is
 * the response: a body whose `refresh_token` is the wrong *shape* must answer
 * the same 401 as one that is merely wrong, or a 400 becomes a way to probe
 * which tokens are worth presenting. The length bound stays, because the value
 * reaches a hash function on an unauthenticated endpoint.
 */
export const refreshSchema = z.object({
  refresh_token: z
    .string()
    .trim()
    .min(1, 'refresh_token is required')
    .max(REFRESH_TOKEN_MAX_LENGTH),
});

export class RefreshDto extends createZodDto(refreshSchema) {}

/**
 * `POST /auth/password/reset-request` (Doc 06 §3).
 *
 * The same two identifiers login takes, minus the password — a reset is for
 * `(client_slug, email)` because that is what identifies a user (Doc 01 §3.6),
 * and the address alone would be ambiguous across tenants.
 *
 * Nothing here can fail in a way that tells the caller anything: a malformed
 * address is a 400 about *syntax*, which says nothing about whether the account
 * exists, and every well-formed request gets the same 202.
 */
export const passwordResetRequestSchema = z.object({
  email,
  client_slug: clientSlug,
});

export class PasswordResetRequestDto extends createZodDto(passwordResetRequestSchema) {}

/**
 * `POST /auth/password/reset` (Doc 06 §3).
 *
 * `new_password` is checked against {@link passwordSchema} — the policy from
 * Doc 03 §7, enforced at the API as that section asks, and the same schema any
 * later set-password endpoint will use. This is the opposite of `loginPassword`
 * above and deliberately so: refusing a short password when it is being *set*
 * is the policy working, while refusing one at login would only leak that the
 * guess was too short to be worth checking.
 *
 * The token is bounded but not shape-checked, for the reason `refresh_token`
 * is: a 400 for a malformed token and a 401 for a wrong one would let a caller
 * tell which strings are worth presenting.
 */
export const passwordResetSchema = z.object({
  token: z.string().trim().min(1, 'token is required').max(RESET_TOKEN_MAX_LENGTH),
  new_password: passwordSchema,
});

export class PasswordResetDto extends createZodDto(passwordResetSchema) {}

/**
 * `POST /auth/token` — the client-credentials exchange (Doc 03 §5).
 *
 * Both fields are bounded and neither is shape-checked, which is the same
 * treatment `refresh_token` gets and for the same reason: a 400 for a
 * malformed key and a 401 for a wrong one would let a caller tell which strings
 * are worth presenting. The bounds stay because the key reaches a database
 * lookup and the secret reaches argon2id, both on an unauthenticated endpoint.
 *
 * Doc 03 §5 also allows HTTP Basic for this exchange. The JSON body is what is
 * implemented: it is one parsing path rather than two, it keeps the credential
 * out of a header that proxies and access logs habitually capture, and Basic can
 * be added later as an alternative encoding of the same two fields without
 * changing anything below the controller.
 */
export const serviceTokenSchema = z.object({
  account_key: z
    .string()
    .trim()
    .min(1, 'account_key is required')
    .max(SERVICE_ACCOUNT_KEY_MAX_LENGTH),
  account_secret: z
    .string()
    .min(1, 'account_secret is required')
    .max(SERVICE_ACCOUNT_SECRET_MAX_LENGTH),
});

export class ServiceTokenDto extends createZodDto(serviceTokenSchema) {}
