/**
 * Service-account CRUD — create, list, rotate, revoke (Doc 06 §10, Doc 03 §5).
 *
 * ## The secret exists for the length of one response
 *
 * {@link ServiceAccountsService.create} and {@link ServiceAccountsService.rotate}
 * mint a secret, hash it with argon2id, store the hash and return the plaintext
 * once. It is not written to the row, the log, or the audit payload (Doc 10 §8),
 * and there is no endpoint that can produce it again — an operator who loses it
 * rotates, which is a different secret and a recorded event.
 *
 * That is why the return type differs from every read's: `ServiceAccountSecretDTO`
 * exists only on these two paths, so a handler that leaked one from a list would
 * not compile.
 *
 * ## Everything here runs on the request transaction
 *
 * Unlike the exchange, which is pre-authentication and goes through migration
 * 0015's definer functions, these are authenticated administrative writes. RLS
 * confines them to the caller's tenant — an id belonging to another client
 * updates nothing and comes back `null`, which the controller turns into the
 * same 404 a nonexistent id gets (Doc 06 §2) — and `iam.write_audit` derives the
 * actor from the context the token established rather than from anything this
 * service asserts (Doc 07 §6).
 *
 * Since Session 12 those audit calls go through `AuditService`, which is what
 * couples them to that transaction structurally and redacts their payloads
 * (Doc 10 §3, §8).
 *
 * ## Interim authorization, and why it is not nothing
 *
 * Doc 06 §10 gates this surface on `iam.client.svc.*`, which needs the
 * `PermissionGuard` that arrives in Session 23. Until then `assertAdministrator`
 * (`common/administrator.ts`) admits two subjects: a platform admin (derived
 * from a binding at the platform scope root, Doc 04 §10 — never asserted by a
 * caller), and a user carrying `user.is_client_admin`, which Doc 01 §3.6
 * describes as exactly this shortcut, "still enforced via permissions" once
 * permissions exist. Both are rows the database confirms under the caller's own
 * RLS context.
 *
 * It lived here as a private method until Session 16 needed the identical rule
 * for the scope tree (Doc 06 §6) and moved it to `common/`, beside the
 * platform-tier check — the reason `platform-admin.ts` gives for being shared:
 * two copies of "what an administrator is" end with the two disagreeing.
 *
 * The alternative — shipping the surface ungated because the real check is two
 * sessions away — would let any authenticated user in a tenant mint a machine
 * identity for that tenant, which is a credential with no expiry and no session
 * to revoke. Session 23 replaces the call with a decorator; the endpoints do not
 * move.
 *
 * A **service** subject is refused unless it is a platform admin. A machine
 * identity that can mint machine identities turns one leaked secret into a
 * supply of them, and no module-to-module call has a reason to.
 */

import { Injectable } from '@nestjs/common';
import {
  ServiceAccountStatus,
  SubjectType,
  normalizePagination,
  paginated,
  type Paginated,
  type ServiceAccountDTO,
  type ServiceAccountSecretDTO,
} from '@plantops/contracts';
import { IAM_SCHEMA, hashSecret, type VerifiedClaims } from '@plantops/db';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { GrantInvalidationService } from '../authz/invalidation.service';
import { assertAdministrator } from '../common/administrator';
import { afterCommit, entityManager } from '../common/transaction-context';
import {
  mintAccountKey,
  mintAccountSecret,
} from '../auth/service-credentials.util';

const S = `"${IAM_SCHEMA}"`;

/** The columns every response is built from — `key_hash` is not among them. */
const COLUMNS = `id, client_id, name, key, status, created_at, updated_at`;

export interface ServiceAccountRow {
  id: string;
  client_id: string | null;
  name: string;
  key: string;
  status: ServiceAccountStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateServiceAccountInput {
  name: string;
}

@Injectable()
export class ServiceAccountsService {
  constructor(
    private readonly audit: AuditService,
    private readonly invalidation: GrantInvalidationService,
  ) {}

  /**
   * Creates an account and returns its secret, once (Doc 06 §10).
   *
   * The tenant is `claims.cid` and cannot be anything else: it is the verified
   * claim (Doc 07 §5), and the RLS policy's `with check` would refuse a row
   * carrying any other client anyway. Platform-*level* accounts — the null
   * `client_id` of Doc 01 §3.7 — are deliberately not creatable here; the one
   * that exists is the bootstrap identity, seeded out of band by migration 0011,
   * and an API that mints tenant-less machine identities is a larger decision
   * than this endpoint should be making.
   */
  async create(
    claims: VerifiedClaims,
    input: CreateServiceAccountInput,
  ): Promise<ServiceAccountSecretDTO> {
    await assertAdministrator(claims);

    const accountKey = mintAccountKey();
    const accountSecret = mintAccountSecret();

    const rows = (await entityManager().query(
      `insert into ${S}."service_account" (client_id, name, key, key_hash, status)
       values ($1, $2, $3, $4, '${ServiceAccountStatus.ACTIVE}')
       returning ${COLUMNS}`,
      [claims.cid, input.name, accountKey, await hashSecret(accountSecret)],
    )) as ServiceAccountRow[];

    const row = rows[0];
    await this.audit.record(
      AUDIT_ACTIONS.SERVICE_ACCOUNT_CREATED,
      { type: 'service_account', id: row.id },
      {
        name: row.name,
        // The key, never the secret. It is the public half, and an audit trail
        // that cannot say *which* account was created is not one an operator can
        // act on (Doc 10 §8) — which is why `redact.ts` deliberately leaves
        // `account_key` alone while catching `key_hash`.
        account_key: row.key,
      },
    );

    return { ...toDto(row), account_secret: accountSecret };
  }

  /**
   * The tenant's accounts, newest first (Doc 06 §10).
   *
   * No secret material of any kind: {@link COLUMNS} omits `key_hash`, which is
   * the stored form of a credential and belongs in no response — the same
   * omission `SessionDTO` makes of `refresh_token_hash`.
   *
   * A platform admin sees across tenants here, because the RLS policy's `using`
   * arm says so (migration 0007) and Doc 10 §7 intends it. Nothing extra is
   * granted by this method.
   */
  async list(
    claims: VerifiedClaims,
    query: { page?: number; limit?: number } = {},
  ): Promise<Paginated<ServiceAccountDTO>> {
    await assertAdministrator(claims);

    const { page, limit } = normalizePagination(query);

    const rows = (await entityManager().query(
      `select ${COLUMNS} from ${S}."service_account"
        order by created_at desc, id desc
        limit $1 offset $2`,
      [limit, (page - 1) * limit],
    )) as ServiceAccountRow[];

    const [count] = (await entityManager().query(
      `select count(*)::int as total from ${S}."service_account"`,
    )) as { total: number }[];

    return paginated(rows.map(toDto), count?.total ?? rows.length, query);
  }

  /**
   * Issues a new secret for an existing account (Doc 06 §10).
   *
   * The old secret stops working the moment this commits — there is one
   * `key_hash` column and this overwrites it. That is the intended semantics of
   * a rotation prompted by a leak, and it is worth stating plainly because the
   * gentler alternative (accept both for a grace period, as refresh rotation
   * does) would be wrong here: the reason to rotate a machine credential is that
   * somebody else may have it, and a window in which the old one still works is
   * exactly the window that must close.
   *
   * The `account_key` is untouched, so a deployment updates one value rather
   * than being re-registered.
   *
   * Returns `null` when no such account exists in the caller's tenant.
   */
  async rotate(
    claims: VerifiedClaims,
    id: string,
  ): Promise<ServiceAccountSecretDTO | null> {
    await assertAdministrator(claims);

    const accountSecret = mintAccountSecret();

    // Wrapped in a CTE so the statement's command is SELECT. A bare
    // `update … returning` looks equivalent and is not: TypeORM's Postgres
    // driver returns `[rows, rowCount]` for an UPDATE, so `rows.length === 0`
    // would never be true and "no such account" would read as success.
    const rows = (await entityManager().query(
      `with rotated as (
         update ${S}."service_account" sa
            set key_hash = $2
          where sa.id = $1
         returning ${COLUMNS}
       )
       select ${COLUMNS} from rotated`,
      [id, await hashSecret(accountSecret)],
    )) as ServiceAccountRow[];

    const row = rows[0];
    if (row === undefined) return null;

    await this.audit.record(
      AUDIT_ACTIONS.SERVICE_ACCOUNT_ROTATED,
      { type: 'service_account', id: row.id },
      { account_key: row.key },
    );

    return { ...toDto(row), account_secret: accountSecret };
  }

  /**
   * Revokes or reactivates an account (Doc 06 §10).
   *
   * Revocation is the machine equivalent of a force-logout, and it is
   * deliberately weaker: a service token's `sid` is ephemeral and backed by no
   * `session` row, so tokens already issued keep working until they expire.
   * Doc 03 §5 makes that trade explicitly and bounds it at the ≤5 min TTL; what
   * this changes is that the *next* exchange fails, immediately and without a
   * cache in the path.
   *
   * Idempotent: setting the status an account already has changes no row and
   * writes no audit record, for the reason `AccountStateService.transition`
   * gives — an audit trail that logs "revoked" three times because a screen was
   * double-clicked is one nobody can read. The current row still comes back, so
   * the caller gets a 200 and the state it asked for.
   *
   * Returns `null` when no such account exists in the caller's tenant.
   *
   * Doc 03 §5 also asks that revoking invalidate the account's cached grants
   * (Doc 04 §7) — wired in Session 22, published after commit like every other
   * out-of-Postgres effect (see `SessionService.revoke`).
   *
   * Only the revocation direction publishes. Reactivating cannot *grant*
   * anything from cache: the account's bindings never went away — revocation is
   * a status on the credential, not a change to the binding graph — so a
   * reactivated account's cached grants are the same ones it had, and correct.
   * What stops a revoked account is `/auth/token` refusing the next exchange
   * (migration 0015) and its ≤5 minute token TTL expiring, which is the model
   * Doc 03 §5 describes. The bump on revoke is belt to that braces: it makes the
   * dead credential's remaining token window carry no grants either.
   */
  async setStatus(
    claims: VerifiedClaims,
    id: string,
    status: ServiceAccountStatus,
  ): Promise<ServiceAccountDTO | null> {
    await assertAdministrator(claims);

    const changed = (await entityManager().query(
      `with changed as (
         update ${S}."service_account" sa
            set status = $2::${S}."service_account_status"
          where sa.id = $1
            and sa.status <> $2::${S}."service_account_status"
         returning ${COLUMNS}
       )
       select ${COLUMNS} from changed`,
      [id, status],
    )) as ServiceAccountRow[];

    const row = changed[0];
    if (row !== undefined) {
      await this.audit.record(
        status === ServiceAccountStatus.REVOKED
          ? AUDIT_ACTIONS.SERVICE_ACCOUNT_REVOKED
          : AUDIT_ACTIONS.SERVICE_ACCOUNT_REACTIVATED,
        { type: 'service_account', id: row.id },
        { account_key: row.key },
      );

      if (status === ServiceAccountStatus.REVOKED) {
        afterCommit(() =>
          this.invalidation.publish(
            claims.cid,
            [{ type: SubjectType.SERVICE, id: row.id }],
            { cause: 'service_account.revoked', serviceAccountId: row.id },
          ),
        );
      }

      return toDto(row);
    }

    // Nothing changed: either the account already has that status, or there is
    // no such account here. Only a read tells the two apart, and only one of
    // them is a 404.
    const current = (await entityManager().query(
      `select ${COLUMNS} from ${S}."service_account" where id = $1`,
      [id],
    )) as ServiceAccountRow[];

    return current[0] === undefined ? null : toDto(current[0]);
  }

  /**
   * The account, or `null` — confined to the caller's **own** tenant.
   *
   * Added for Session 20: binding a machine identity to a role has to establish
   * that the identity is the caller's own before anchoring a grant to it
   * (Doc 02 §6), and migration 0004 says in as many words that this arm of the
   * check is the service layer's — `role_binding.service_account_id` gets a
   * plain foreign key rather than the composite one the user arm gets, because a
   * platform account's `client_id` is null and a composite key would make it
   * unbindable anywhere at all.
   *
   * The explicit `client_id = $2` is therefore load-bearing here in a way it is
   * not in the methods above, which pin nothing and let RLS decide. Two rows it
   * excludes and RLS would not: a platform-level account (null `client_id`,
   * Doc 01 §3.7), which Doc 02 §6 keeps out of every client's binding space
   * entirely; and any account at all when the caller is a platform admin acting
   * inside a tenant, whose `using` arm spans every client (migration 0007).
   * Both would otherwise be bindable into a tenant that does not own them.
   *
   * Status is deliberately not part of the question. A revoked account can be
   * reactivated (`setStatus`), and refusing to bind one would mean an operator
   * had to restore the credential before they could restore its access — two
   * ordered steps where the tenant meant one act.
   */
  async findRow(
    claims: VerifiedClaims,
    id: string,
  ): Promise<ServiceAccountRow | null> {
    const [row] = (await entityManager().query(
      `select ${COLUMNS} from ${S}."service_account"
        where id = $1 and client_id = $2`,
      [id, claims.cid],
    )) as ServiceAccountRow[];

    return row ?? null;
  }
}

function toDto(row: ServiceAccountRow): ServiceAccountDTO {
  return {
    id: row.id,
    client_id: row.client_id,
    name: row.name,
    account_key: row.key,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
