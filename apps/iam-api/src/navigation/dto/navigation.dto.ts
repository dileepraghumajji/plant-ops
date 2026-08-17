/**
 * The one query parameter `GET /iam/navigation` takes (Doc 06 §11).
 *
 * Camel-cased, like `ResolveQueryDto` and unlike the snake_case query parameters
 * of the admin surfaces, because Doc 06 §11 spells it `?applicationId=` — this
 * table is the contract other teams' modules and the console consume, so its
 * spelling is the spec's rather than this codebase's house style.
 *
 * Optional, and the absence is a *different request* rather than a default: no
 * `applicationId` asks for the cross-application shell (Doc 05 §4). A schema
 * declared here rather than shared with `authz/dto/authz.dto.ts`'s identical one,
 * so the published document names `NavigationQueryDto` on this route — a
 * generated client that saw `ResolveQueryDto` on `/iam/navigation` would be
 * reading a claim about the resolve endpoint.
 *
 * No pagination: a menu cut off at row 25 is not a partial menu, it is a set of
 * orphans — the argument `registry/nav.service.ts` makes about the catalog tree,
 * one layer up.
 */

import { z } from 'zod';
import { createZodDto } from '../../common/validation.pipe';

export const navigationQuerySchema = z.object({
  applicationId: z.uuid().optional(),
});

export class NavigationQueryDto extends createZodDto(navigationQuerySchema) {}
