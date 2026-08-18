/**
 * `/iam/audit` — the read side of the trail (Doc 06 §12, Doc 10 §7).
 *
 * ## Two routes, and no third
 *
 * A page and an export, both `GET`. Doc 10 §7: *"audit is read-only through the
 * API — there is no mutate/delete endpoint by design"*. That sentence is a
 * design constraint rather than an omission, so it is asserted rather than
 * merely honoured: `audit.controller.spec.ts` scans this class and fails if any
 * handler carries a verb other than `GET`. Append-only is enforced three times
 * over — no privilege (migration 0010 grants `select` alone), no policy (there
 * is no insert/update/delete policy to permit a row), and now no route.
 *
 * ## One route serves both tiers, and the permission gate says so
 *
 * `@RequirePermission([CLIENT_AUDIT_READ, PLATFORM_AUDIT_READ])` — either key
 * admits. Doc 06 §12 heads the section `iam.*.audit.read`, and it is the only
 * section of that document that names a wildcard where every other names a
 * concrete tier. This is the route that reads it literally.
 *
 * What the two readers then *see* is not decided here and is not decided in
 * `AuditQueryService` either. It is the `audit_trail_read` policy of migration
 * 0010, evaluated against the RLS context derived from the verified token:
 *
 * ```sql
 * using (app.is_platform_admin or client_id = app.current_client_id)
 * ```
 *
 * — so a client admin gets their tenant's rows, a platform admin gets everything
 * including the `client_id is null` rows that record platform-level acts, and no
 * handler code decides either. See `audit-query.service.ts` for why that
 * placement is the point rather than a shortcut.
 *
 * ## The export is a separate route because it is a separate act
 *
 * Doc 06 §12's table has one row and this controller has two, which is the one
 * place this surface goes beyond that table. The reason is Doc 10 §7, which asks
 * for a CSV export and asks that it be *audited* — an obligation the page does
 * not carry. Given that, `?format=csv` on the list route would be a single
 * operation that sometimes writes an audit record and sometimes does not,
 * ignores `page` in one mode, and answers with two incompatible media types. Two
 * routes state the difference instead of hiding it, and the export gets the
 * tighter rate limit that taking a copy of a security log deserves.
 *
 * ## Why it lives in `audit/` rather than in a module of its own
 *
 * `AuditModule` is imported by every feature module for its writer, so the
 * controller rides in on a module that is already in the graph. That is
 * deliberate and it is the reverse of `navigation/`'s arrangement: navigation
 * needed a module because it needed the nav-catalog cache and the resolution
 * engine, whereas reading the trail needs the request transaction and nothing
 * else. A second module here would exist only to hold one controller.
 */

import { Controller, Get, Header, Query } from '@nestjs/common';
import { RequirePermission } from '@plantops/auth-kit';
import {
  AUDIT_EXPORT_CONTENT_TYPE,
  AUDIT_EXPORT_FILENAME,
  IAM_ROUTE_PREFIX,
  type AuditRecordDTO,
  type Paginated,
} from '@plantops/contracts';
import {
  IAM_CLIENT_PERMISSIONS,
  IAM_PLATFORM_PERMISSIONS,
} from '../authz/iam-permissions';
import { RateLimit } from '../common/rate-limit.decorator';
import { Transactional } from '../common/transaction-context';
import { AuditExportService } from './audit-export.service';
import { AuditQueryService } from './audit-query.service';
import { AuditExportQueryDto, AuditQueryDto } from './dto/audit.dto';

/**
 * Either tier's key admits — Doc 06 §12's `iam.*.audit.read`.
 *
 * Named once and used on both routes, so the two can never drift into a page a
 * reader may see and an export they may not.
 */
const AUDIT_READ = [
  IAM_CLIENT_PERMISSIONS.AUDIT_READ,
  IAM_PLATFORM_PERMISSIONS.AUDIT_READ,
] as const;

/** The ordinary admin-surface bound, matching `/iam/users` and `/iam/roles`. */
const AUDIT_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/**
 * The export's own, much tighter bound — the shape `/iam/users/bulk` uses, for
 * the mirror-image reason.
 *
 * One request here reads up to ten thousand rows and assembles a document from
 * them, so sharing the sixty-a-minute budget would let a caller pull six hundred
 * thousand audit records a minute. An operator producing a report issues one or
 * two; ten an hour's worth is already generous, and a scripted loop through a
 * tenant's whole history is precisely the traffic this bound is for.
 */
const AUDIT_EXPORT_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;

@Controller(`${IAM_ROUTE_PREFIX}/audit`)
export class AuditController {
  constructor(
    private readonly query: AuditQueryService,
    private readonly exporter: AuditExportService,
  ) {}

  /**
   * One page of the trail, filtered (Doc 06 §12).
   *
   * Reading is not itself audited. Doc 10 §7 audits the *export* and not the
   * page, and the asymmetry is the intended one: an admin console renders this
   * on every filter change and every page turn, so recording each would fill the
   * trail with reads of the trail and bury the events an investigator is looking
   * for. Taking a copy away is the act worth a record.
   */
  @Get()
  @RateLimit(AUDIT_RATE_LIMIT)
  @RequirePermission(AUDIT_READ)
  list(@Query() query: AuditQueryDto): Promise<Paginated<AuditRecordDTO>> {
    return this.query.list(query);
  }

  /**
   * The same filter as a CSV, and `audit.exported` beside it (Doc 10 §7).
   *
   * The headers are static decorators rather than a touched `Response`, keeping
   * the controller free of Express (hardening H1). The filename is fixed for the
   * same reason: a timestamped one would have to come from a mutable response
   * object, and a browser saving `audit-export.csv` alongside an earlier
   * `audit-export (1).csv` loses nothing — every row carries its own
   * `created_at`, and the filter that produced the file is in the audit record.
   *
   * `400` where the filter matches more than the export cap, with the count
   * (`audit-export.service.ts`): a compliance export is complete or it is
   * refused.
   *
   * `REPEATABLE READ` because this is the one handler that issues *many*
   * statements about one question: a count, then a chunk per thousand rows. At
   * `READ COMMITTED` each takes its own snapshot, so a row committed between the
   * count and the first chunk would be exported without having been counted —
   * an export marginally larger than the cap that checked it, and a
   * `rows` figure in the audit record that disagreed with the file. One snapshot
   * makes the count and the document the same claim. It costs nothing here: a
   * serialization failure needs a write conflict, and this transaction writes
   * one row of its own and reads everything else, so there are no `retries` to
   * declare.
   */
  @Get('export')
  @RateLimit(AUDIT_EXPORT_RATE_LIMIT)
  @Transactional({ isolation: 'REPEATABLE READ' })
  @RequirePermission(AUDIT_READ)
  @Header('content-type', AUDIT_EXPORT_CONTENT_TYPE)
  @Header('content-disposition', `attachment; filename="${AUDIT_EXPORT_FILENAME}"`)
  export(@Query() query: AuditExportQueryDto): Promise<string> {
    return this.exporter.export(query);
  }
}
