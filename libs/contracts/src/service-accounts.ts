/**
 * Service-account contract — the machine-identity surface (Doc 06 §10) and the
 * shape of what its client-credentials exchange consumes (Doc 03 §5).
 *
 * ## The secret appears in exactly one type
 *
 * {@link ServiceAccountDTO} is what every read returns and it has no secret in
 * it, because only the hash is stored (Doc 03 §7) — there is nothing a read
 * *could* return. {@link ServiceAccountSecretDTO} is the create and rotate
 * response, and it is the one moment the secret exists outside the caller's
 * hands. Splitting them at the type level is the cheap half of "shown once": a
 * handler that returned the wrong one on a list would not compile.
 */

/**
 * A machine identity's lifecycle states (Doc 01 §3.7).
 *
 * Two, not three: there is no `locked`. Locking exists for humans because a
 * person can be told to contact an administrator and come back; a machine has
 * nobody to ask, so the only useful states are "works" and "does not". Revoking
 * fails the *next* `/auth/token` exchange (Doc 03 §5).
 *
 * Spelled here rather than imported from `@plantops/db`, which contracts must
 * not depend on — it has zero dependencies by design (Doc 08 §3). The Postgres
 * enum is the same two values, and `libs/db`'s `entities.spec.ts` asserts the
 * two spellings against each other so they cannot drift into a status the API
 * accepts and the column rejects.
 */
export const ServiceAccountStatus = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const;
export type ServiceAccountStatus =
  (typeof ServiceAccountStatus)[keyof typeof ServiceAccountStatus];

export const SERVICE_ACCOUNT_STATUS_VALUES = [
  ServiceAccountStatus.ACTIVE,
  ServiceAccountStatus.REVOKED,
] as const satisfies readonly ServiceAccountStatus[];

/**
 * One service account, as every read returns it (Doc 06 §10).
 *
 * `account_key` is the public half of the credential — the lookup handle the
 * exchange takes, and the only way an operator can tell two accounts apart in a
 * log. It is deliberately *not* a secret and is safe to display; `key_hash` is
 * the secret's stored form and appears in no response at all, for the reason
 * `SessionDTO` omits `refresh_token_hash` (Doc 10 §8).
 */
export interface ServiceAccountDTO {
  id: string;
  /** `null` = platform-level, outside any tenant (Doc 01 §3.7). */
  client_id: string | null;
  name: string;
  /** The `account_key` of the client-credentials exchange (Doc 03 §5). */
  account_key: string;
  status: ServiceAccountStatus;
  /** ISO-8601. */
  created_at: string;
  updated_at: string;
}

/**
 * The create and rotate response — the only type in this contract that carries
 * a secret, and the only time the secret exists anywhere but in the caller's
 * hands (Doc 03 §7, Doc 06 §10: "secret returned once").
 *
 * A caller that loses it has not lost the account: rotate issues a new one. It
 * cannot be re-read, because it was never stored.
 */
export interface ServiceAccountSecretDTO extends ServiceAccountDTO {
  /** The `account_secret` of the exchange. Never returned again. */
  account_secret: string;
}

/** `POST /iam/service-accounts` body (Doc 06 §10). */
export interface CreateServiceAccountRequest {
  name: string;
}

/**
 * `PATCH /iam/service-accounts/:id` body (Doc 06 §10) — revoke, or reactivate.
 *
 * The status is the whole body: the name is not editable through this route and
 * `account_key` never is, since it is the identifier a deployed consumer has
 * already been configured with.
 */
export interface UpdateServiceAccountRequest {
  status: ServiceAccountStatus;
}
