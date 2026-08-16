/**
 * The OpenAPI document, generated from the code that already defines the API.
 *
 * ## What it is generated *from*
 *
 * Three sources, none of them a hand-written copy of the surface:
 *
 * - **Routes** come from Nest's own decorator metadata — the same `PATH`,
 *   `METHOD`, `HTTP_CODE` and `__routeArguments__` keys the router reads. If a
 *   route exists it is here, and if its path changes so does the document.
 * - **Request bodies and query parameters** come from the live `zodSchema` on
 *   the `createZodDto` class the handler declares. The document cannot drift
 *   from the validator, because it *is* the validator — which removes rather
 *   than mitigates the usual reason generated API docs go stale.
 * - **Responses** come from `route-responses.ts`, whose schemas are pinned to
 *   the published contracts by exact type equality (`schemas.spec.ts`).
 *
 * ## Why not `@nestjs/swagger`
 *
 * H6 sketched this as `SwaggerModule.createDocument`, and that would work. Two
 * things argued against it once the shape became clear.
 *
 * `createDocument` takes an **initialized application**, so producing
 * `openapi.json` would mean booting Nest — a `DataSource`, a Redis client, a
 * signing key and a validated environment, none of which a documentation build
 * should need. Reading metadata off the controller classes instead makes the
 * document a pure function of the code, so the build target is
 * `tsx tools/emit-openapi.ts` with no infrastructure at all.
 *
 * And every route-level fact `@nestjs/swagger` contributes has to be decorated
 * onto the controllers by hand anyway. Its value is the decorator vocabulary
 * this codebase deliberately does not want (see `route-responses.ts`), so what
 * remained was route scanning — and `openapi.spec.ts` checks that scanning
 * against the routes the real application registers, which is a stronger
 * guarantee than trusting the library would have been.
 *
 * ## What this is not
 *
 * It is not the specification. Doc 06 is, and stays so. This is a machine
 * projection of the implementation, useful precisely because it can be
 * mechanically compared against Doc 06 rather than trusted in its place.
 */

import type { Type } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { IS_PUBLIC_METADATA } from '@plantops/auth-kit';
import { z } from 'zod';
import { type ZodDtoClass, zodSchemaOf } from '../common/validation.pipe';
import { ROUTE_RESPONSES, type ResponseSpec } from './route-responses';
import {
  componentSchemas,
  errorResponseSchema,
  refFor,
  registerRequestSchema,
} from './schemas';

/** Minimal OpenAPI 3.1 shapes — only what this document actually emits. */
export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  tags: string[];
  security?: { bearerAuth: [] }[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: true;
    content: { 'application/json': { schema: unknown } };
  };
  responses: Record<string, OpenApiResponse>;
}

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: unknown;
}

interface OpenApiResponse {
  description: string;
  content?: { 'application/json': { schema: unknown } };
}

/** One route, as read off a controller class. */
export interface ScannedRoute {
  controller: Type<unknown>;
  handlerName: string;
  /** `get`, `post`, … as OpenAPI spells them. */
  verb: string;
  /** The full Express-style path, e.g. `/iam/applications/:id/manifest`. */
  path: string;
  /** `@HttpCode(...)`, or Nest's default for the verb. */
  status: number;
  isPublic: boolean;
  body?: ZodDtoClass;
  query?: ZodDtoClass;
  /** Names of the `:params` in the path, in order. */
  pathParams: string[];
}

const VERB_BY_METHOD: Readonly<Record<number, string>> = Object.freeze({
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
});

/**
 * The failures that are real on **every** route inside the envelope surface.
 *
 * Kept short on purpose. A document that lists all ten codes against every
 * operation tells an integrating team nothing — they learn which failures to
 * handle from a list that is the same everywhere. These three are genuinely
 * universal: a query or body can fail validation, the throttle applies to
 * everything outside `/health`, and anything unanticipated is a 500. The rest
 * are declared per route in `route-responses.ts`.
 */
const UNIVERSAL_ERRORS: readonly number[] = [400, 429, 500];

export const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = Object.freeze(
  {
    400: 'VALIDATION_FAILED — the request failed validation, or exceeded the body limit (§1)',
    401: 'AUTH_REQUIRED / INVALID_CREDENTIALS',
    403: 'PERMISSION_DENIED / SCOPE_DENIED — never says whether the target exists elsewhere',
    404: 'NOT_FOUND — within the caller’s tenant',
    409: 'CONFLICT — duplicate key, or a cross-tenant violation',
    423: 'ACCOUNT_LOCKED',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_ERROR — the message is fixed; correlate with `requestId`',
  },
);

/**
 * Builds the document for a set of controllers.
 *
 * Defaults to the controllers `route-responses.ts` describes; the parameter
 * exists so `openapi.spec.ts` can point it at the controllers the *application*
 * registers and prove the two sets are the same.
 */
export function buildOpenApiDocument(
  controllers: readonly Type<unknown>[] = [...ROUTE_RESPONSES.keys()],
): OpenApiDocument {
  const routes = controllers.flatMap(scanController);

  // Registration first: `componentSchemas()` reads the registries, so a request
  // body registered after it would be `$ref`d without being defined.
  for (const route of routes) {
    if (route.body !== undefined) {
      registerRequestSchema(route.body.name, route.body.zodSchema);
    }
  }

  const paths: OpenApiDocument['paths'] = {};
  for (const route of routes) {
    (paths[toOpenApiPath(route.path)] ??= {})[route.verb] = toOperation(route);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'PlantOps IAM',
      version: '1.0.0',
      description:
        'Identity, access and navigation for the PlantOps platform. Doc 06 is ' +
        'the specification; this document is generated from the implementation, ' +
        'and is what a client generator should be pointed at.',
    },
    servers: [{ url: '/', description: 'The deployment serving this document' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'An access token from POST /auth/login, /auth/refresh or /auth/token.',
        },
      },
      schemas: componentSchemas(),
    },
    paths: sortKeys(paths),
  };
}

// ── scanning ────────────────────────────────────────────────────────────────

/** Every route a controller class declares, in declaration order. */
export function scanController(controller: Type<unknown>): ScannedRoute[] {
  const base = normalise(
    (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '',
  );
  const prototype = controller.prototype as Record<string, unknown>;

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = prototype[name];
      if (typeof handler !== 'function') return [];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        | number
        | undefined;
      if (method === undefined) return [];
      return [scanRoute(controller, base, name, handler, method)];
    });
}

function scanRoute(
  controller: Type<unknown>,
  base: string,
  handlerName: string,
  handler: object,
  method: number,
): ScannedRoute {
  const suffix = normalise(
    (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '',
  );
  const path = base + suffix === '' ? '/' : base + suffix;

  return {
    controller,
    handlerName,
    verb: VERB_BY_METHOD[method],
    path,
    status:
      (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ??
      (method === RequestMethod.POST ? 201 : 200),
    // `@Public()` sits on the handler or on the whole controller, and
    // `AuthGuard` reads it with `getAllAndOverride` over both.
    isPublic:
      Reflect.getMetadata(IS_PUBLIC_METADATA, handler) === true ||
      Reflect.getMetadata(IS_PUBLIC_METADATA, controller) === true,
    ...parameterDtos(controller, handlerName),
    pathParams: [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map(([, name]) => name),
  };
}

/**
 * The DTO classes a handler's `@Body()` and `@Query()` parameters carry.
 *
 * Nest records *which* parameter is the body under `__routeArguments__`, and
 * TypeScript records *what type* each parameter has under `design:paramtypes`
 * (`emitDecoratorMetadata`). Neither is enough alone; the parameter index joins
 * them.
 *
 * A parameter with no schema is skipped rather than reported. `@Param('id') id:
 * string` and `@Claims() claims: VerifiedClaims` are both legitimate and neither
 * describes a request body — and the one case that would matter, a `@Body()`
 * carrying no schema, cannot reach here: `ZodValidationPipe` refuses it at
 * request time (H3).
 */
function parameterDtos(
  controller: Type<unknown>,
  handlerName: string,
): { body?: ZodDtoClass; query?: ZodDtoClass } {
  const args =
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handlerName) as
      | Record<string, { index: number }>
      | undefined) ?? {};
  const paramTypes =
    (Reflect.getMetadata('design:paramtypes', controller.prototype, handlerName) as
      | unknown[]
      | undefined) ?? [];

  const found: { body?: ZodDtoClass; query?: ZodDtoClass } = {};
  for (const [key, { index }] of Object.entries(args)) {
    // The key is `"<RouteParamtypes>:<index>"`.
    const paramtype = Number(key.split(':')[0]);
    const dto = zodSchemaOf(paramTypes[index]);
    if (dto === undefined) continue;
    if (paramtype === RouteParamtypes.BODY) found.body = dto;
    if (paramtype === RouteParamtypes.QUERY) found.query = dto;
  }
  return found;
}

// ── emitting ────────────────────────────────────────────────────────────────

function toOperation(route: ScannedRoute): OpenApiOperation {
  const spec = responseSpecFor(route);

  const operation: OpenApiOperation = {
    operationId: `${tagFor(route)}_${route.handlerName}`,
    summary: `${route.verb.toUpperCase()} ${route.path}`,
    tags: [tagFor(route)],
    ...(route.isPublic ? {} : { security: [{ bearerAuth: [] as [] }] }),
    responses: {
      ...successResponses(spec),
      ...errorResponses(route, spec),
    },
  };

  const parameters = [...pathParameters(route), ...queryParameters(route)];
  if (parameters.length > 0) operation.parameters = parameters;

  if (route.body !== undefined) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': { schema: { $ref: refFor(route.body.zodSchema) } },
      },
    };
  }

  return operation;
}

/**
 * The declared response for a route, or a loud failure.
 *
 * Unreachable through the type system — `ControllerResponses` is exhaustive —
 * but reachable through `buildOpenApiDocument(otherControllers)`, which is
 * exactly what `openapi.spec.ts` does with the application's real controller
 * list. That is the check: a controller wired into `AppModule` and forgotten
 * here fails there.
 */
export function responseSpecFor(route: ScannedRoute): ResponseSpec {
  const spec = ROUTE_RESPONSES.get(route.controller)?.[route.handlerName];
  if (spec === undefined) {
    throw new Error(
      `${route.controller.name}.${route.handlerName} has no response declared. ` +
        'Add it to ROUTE_RESPONSES in openapi/route-responses.ts.',
    );
  }
  return spec;
}

function successResponses(spec: ResponseSpec): Record<string, OpenApiResponse> {
  return Object.fromEntries(
    [spec, ...(spec.also ?? [])].map((entry) => [
      String(entry.status),
      entry.schema === undefined
        ? { description: entry.description }
        : {
            description: entry.description,
            content: {
              'application/json': {
                schema:
                  'array' in entry && entry.array === true
                    ? { type: 'array', items: { $ref: refFor(entry.schema) } }
                    : { $ref: refFor(entry.schema) },
              },
            },
          },
    ]),
  );
}

/**
 * The envelope responses for a route.
 *
 * Empty for the ops endpoints: Doc 06 §13 puts `/health` and `/ready` outside
 * this surface — they answer with a report and a status code, and a probe reads
 * status codes rather than error codes.
 */
function errorResponses(
  route: ScannedRoute,
  spec: ResponseSpec,
): Record<string, OpenApiResponse> {
  if (spec.envelope === false) return {};

  const statuses = new Set<number>([
    ...UNIVERSAL_ERRORS,
    ...(route.isPublic ? [] : [401]),
    ...(spec.errors ?? []),
  ]);
  const envelope = { $ref: refFor(errorResponseSchema) };

  return Object.fromEntries(
    [...statuses]
      .sort((a, b) => a - b)
      .map((status) => [
        String(status),
        {
          description: ERROR_DESCRIPTIONS[status],
          content: { 'application/json': { schema: envelope } },
        },
      ]),
  );
}

function pathParameters(route: ScannedRoute): OpenApiParameter[] {
  return route.pathParams.map((name) => ({
    name,
    in: 'path' as const,
    required: true,
    // Every path parameter on this surface is a uuid, parsed by `ParseUUIDPipe`
    // before any query runs — `:id` and `:appId` alike.
    schema: { type: 'string', format: 'uuid' },
  }));
}

/**
 * Query parameters, exploded out of the `@Query()` DTO's schema.
 *
 * OpenAPI describes a query string as a list of named parameters rather than as
 * one object, so the DTO's JSON Schema is converted and its properties lifted
 * out. Converted as an **input**: `?limit=` arrives as a string that the DTO
 * coerces, and the pre-coercion shape is the one a caller has to send.
 */
function queryParameters(route: ScannedRoute): OpenApiParameter[] {
  if (route.query === undefined) return [];

  const schema = z.toJSONSchema(route.query.zodSchema, {
    target: 'draft-2020-12',
    io: 'input',
  }) as { properties?: Record<string, unknown>; required?: string[] };

  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    in: 'query' as const,
    required: schema.required?.includes(name) === true,
    schema: property,
  }));
}

/** `/iam/applications/:id` → `/iam/applications/{id}`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function tagFor(route: ScannedRoute): string {
  return route.controller.name.replace(/Controller$/, '');
}

/** Stable output: the document is a committed artefact and gets diffed. */
function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** A leading slash, no trailing one, and `''` for an empty segment. */
function normalise(segment: string): string {
  const trimmed = segment.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}
