/**
 * Serves the generated document (H6). The generator itself is plain functions —
 * see `openapi.ts` — so there is nothing to provide here but the route.
 */

import { Module } from '@nestjs/common';
import { OpenApiController } from './openapi.controller';

@Module({ controllers: [OpenApiController] })
export class OpenApiModule {}
