/**
 * `GET /openapi.json` — the generated document, served by the deployment that
 * implements it.
 *
 * ## Off unless a deployment says otherwise
 *
 * `OPENAPI_ENABLED` defaults to `false`, in **every** environment rather than
 * only in production. A default that keys off `NODE_ENV` is the arrangement
 * that eventually serves a document from production, because the one place
 * `NODE_ENV` is most often wrong is the place where being wrong matters. An
 * explicit switch is one line in `.env.example` for a developer and a decision
 * for an operator, which is the right split.
 *
 * There is nothing secret in the document — every route in it is in Doc 06 —
 * but it is an inventory, and an inventory is worth exactly one line of
 * configuration to withhold from an unauthenticated scanner. When the switch is
 * off the route answers `404` rather than `403`: a disabled endpoint should
 * look like an endpoint that does not exist, not like one worth retrying with
 * credentials.
 *
 * ## Why the route is not itself in the document
 *
 * It is not part of the API. `route-responses.ts` does not list this
 * controller, and `openapi.spec.ts`'s "describes exactly the routes the
 * application registers" therefore has to know about it — see the exclusion
 * there. That is deliberate: an API description that describes its own
 * description is noise for every consumer of it.
 */

import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '@plantops/auth-kit';
import type { EnvConfig } from '@plantops/config';
import { IamException } from '../common/iam.exception';
import { SkipRateLimit } from '../common/rate-limit.decorator';
import { SkipTransaction } from '../common/transaction-context';
import { ENV } from '../config/config.module';
import { type OpenApiDocument, buildOpenApiDocument } from './openapi';

@Controller()
@Public()
@SkipRateLimit()
// No database work: the document is a function of the code, not of any row.
@SkipTransaction()
export class OpenApiController {
  /**
   * Built once, on first request rather than at boot.
   *
   * Boot is the wrong time: a deployment with the switch off would pay for a
   * document nobody can fetch, and the conversion walks every schema in the
   * registry. After the first request it is a constant — the inputs are all
   * decorator metadata, which cannot change while the process runs.
   */
  private document?: OpenApiDocument;

  constructor(@Inject(ENV) private readonly env: EnvConfig) {}

  @Get('openapi.json')
  openapi(): OpenApiDocument {
    if (!this.env.OPENAPI_ENABLED) throw IamException.notFound('The requested route');
    return (this.document ??= buildOpenApiDocument());
  }
}
