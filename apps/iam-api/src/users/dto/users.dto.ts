/**
 * Request bodies and query parameters for `/iam/users` (Doc 06 §8).
 *
 * Same conventions as `roles/dto/*` and `scopes/dto/*`: the field names are the
 * spec's, and every schema is a `z.object`, which **strips** unknown keys.
 *
 * The stripping matters more here than anywhere else on the client surface,
 * because of what a `user` row carries. `client_id` in a create body would place
 * a person in another tenant; `is_client_admin` would let any administrator mint
 * a second administrator through a profile form — the interim authorization flag
 * of Doc 01 §3.6 is precisely what `assertAdministrator` reads, so a tolerated
 * key there is a privilege-escalation hole rather than an untidy payload. Both
 * are absent below and `users.dto.spec.ts` asserts that they are dropped rather
 * than merely ignored.
 *
 * There is no `password` field, and its absence is the design rather than an
 * omission: a user created here has no credential until they set one through the
 * tokenized reset flow (Doc 03 §7), which is the same flow Doc 09 §3.3 puts
 * behind the detail screen's *reset password* button. See `contracts/users.ts`.
 */

import { USER_STATUS_VALUES } from '@plantops/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';

/**
 * An email address, normalized the way the column stores it.
 *
 * Lowercased here rather than in the service, so that every path into an
 * `insert` or an `update` gets the same treatment and migration 0003's
 * `user_email_is_lowercase` check can never be the thing that catches a mistake
 * — a 500 from a check violation is a worse answer than a 409 from the unique
 * index, and `unique (client_id, email)` is only genuinely case-insensitive
 * because the stored form is normalized.
 *
 * `z.email()` is stricter than the column's deliberately loose shape check, and
 * that asymmetry is intended: the database refuses the nonsense, the API refuses
 * the plausible-but-wrong (Doc 01 §3.6's note that "real validation is the API's
 * job").
 *
 * Normalized **before** the format check rather than after, which is what the
 * `pipe` is for: `z.email()` runs its pattern first if it owns the schema, so a
 * pasted `" Gita@Acme.test "` would be refused for the whitespace the trim
 * exists to remove.
 *
 * The `meta()` is not decoration. `z.toJSONSchema` converts a pipe from its
 * *input* side for a request body (`openapi/schemas.ts`), and the input side of
 * this one is a bare string — so without it, the published document would
 * describe the one field every client validates locally as having no format and
 * no bound at all.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('a valid email address is required').max(320))
  .meta({ format: 'email', maxLength: 320 });

/** The display name every screen shows instead of a uuid (Doc 01 §3.6). */
const fullName = z.string().trim().min(1, 'full_name is required').max(160);

/**
 * The optional phone number (Doc 01 §3.6).
 *
 * Bounded and trimmed, and otherwise unvalidated. It is reserved for the
 * WhatsApp channel of Doc 03 §10, which does not exist yet, and a format this
 * system cannot currently use is not one it should be refusing people over —
 * plant staff numbers arrive with country codes, extensions and spaces in every
 * arrangement a clipboard allows.
 */
const phone = z.string().trim().max(40);

/** `active`, `locked` or `disabled` — the Doc 03 §8 states. */
const status = z.enum(USER_STATUS_VALUES);

/**
 * `POST /iam/users` (Doc 06 §8, Doc 09 §3.3).
 *
 * `status` is Doc 09 §3.3's "initial status" and defaults to `active` in the
 * service rather than here: an absent field and an explicit `"active"` should
 * produce the same row, and letting the schema fill it in would make the two
 * indistinguishable in the audit payload that records what the operator chose.
 */
export const createUserSchema = z.object({
  email,
  full_name: fullName,
  phone: phone.optional(),
  status: status.optional(),
});

export class CreateUserDto extends createZodDto(createUserSchema) {}

/**
 * `PATCH /iam/users/:id` — Doc 06 §8's "update, lock, unlock, disable".
 *
 * At least one field, so an empty body is a 400 rather than a 200 that audits a
 * change nobody made — the rule `updateRoleSchema` and `updateClientSchema`
 * follow.
 *
 * Which status *transitions* are legal is not a question a schema can ask: it
 * depends on the row's current state (Doc 03 §8), so `UsersService` decides it.
 * All three values parse here; `disabled → active` is the one the service
 * refuses.
 */
export const updateUserSchema = z
  .object({
    email: email.optional(),
    full_name: fullName.optional(),
    phone: phone.optional(),
    status: status.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field must be provided',
  });

export class UpdateUserDto extends createZodDto(updateUserSchema) {}

/**
 * `?page=&limit=&status=&q=` (Doc 06 §1, §8).
 *
 * `status=locked` is the "Account Locked Users" screen of Doc 09 §3.3 — a
 * screen, not a report, which is why it is a filter on the ordinary list rather
 * than an endpoint of its own.
 *
 * `q` searches the two columns an operator has in front of them, the address and
 * the name. It is bounded at 160 characters like the name itself: a search term
 * longer than the longest thing it could match is a client bug, and the bound is
 * also what keeps the `ilike` pattern the service builds from being unbounded
 * input.
 *
 * Spelled again rather than imported from `roles/dto/roles.dto.ts`, for the
 * reason that one gives: the surfaces are independent, and a shared query DTO is
 * the coupling that makes one endpoint's pagination change break another's.
 */
export const usersQuerySchema = z.object({
  page: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
  status: status.optional(),
  q: z.string().trim().min(1).max(160).optional(),
});

export class UsersQueryDto extends createZodDto(usersQuerySchema) {}
