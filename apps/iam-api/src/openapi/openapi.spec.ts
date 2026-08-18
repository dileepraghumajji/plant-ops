/**
 * The document, checked against the application it claims to describe.
 *
 * `openapi.ts` reads Nest's decorator metadata itself rather than asking a
 * booted application, which is what makes `openapi.json` a build artefact with
 * no infrastructure behind it. The cost of that choice is that the scanner
 * could be subtly wrong — a path joined differently from the router, a verb
 * missed, a `@HttpCode` ignored — and nothing about generating a document from
 * metadata would reveal it.
 *
 * So this suite boots the real `AppModule` and compares the document with the
 * routes Express actually has. Every claim below is of that shape: not "the
 * generator produced something", but "the generator produced what is running".
 */

import { HEADERS_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Harness, createHarness, testEnv } from '../testing/app-harness';
import { buildOpenApiDocument, toOpenApiPath } from './openapi';
import { OpenApiController } from './openapi.controller';
import { ROUTE_RESPONSES } from './route-responses';

/** `post /iam/applications` — the comparable form of one route. */
type RouteKey = string;

/**
 * Every route Express has, read off the real router stack.
 *
 * A `Set` rather than a list, because one entry legitimately appears twice:
 * `ManifestBodyMiddleware` is applied to a specific path *and* method
 * (`app.module.ts`), and Nest registers that as `app.post(path, …)` — which is
 * a router layer like any other. Deduplicating by `verb + path` compares what
 * is reachable rather than how many layers implement it.
 */
function registeredRoutes(app: NestExpressApplication): Set<RouteKey> {
  // Through `unknown`: `router` is Express's own internal, and `@types/express`
  // declares it only as the deprecated 3.x accessor that throws when read.
  const express = app.getHttpAdapter().getInstance() as unknown as {
    router: {
      stack: {
        route?: { path: string; methods: Record<string, boolean> };
      }[];
    };
  };

  const routes = new Set<RouteKey>();
  for (const layer of express.router.stack) {
    if (layer.route === undefined) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) routes.add(`${method} ${toOpenApiPath(layer.route.path)}`);
    }
  }
  return routes;
}

/** Every controller class the application registers. */
function registeredControllers(app: NestExpressApplication): Type<unknown>[] {
  return [...app.get(ModulesContainer).values()].flatMap((module) =>
    [...module.controllers.values()]
      .map((wrapper) => wrapper.metatype as Type<unknown> | undefined)
      .filter((metatype): metatype is Type<unknown> => metatype !== undefined),
  );
}

function documentedRoutes(
  document: ReturnType<typeof buildOpenApiDocument>,
): Set<RouteKey> {
  const routes = new Set<RouteKey>();
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const verb of Object.keys(operations)) routes.add(`${verb} ${path}`);
  }
  return routes;
}

describe('the generated OpenAPI document', () => {
  let harness: Harness;
  let app: NestExpressApplication;
  const document = buildOpenApiDocument();

  beforeAll(async () => {
    harness = await createHarness();
    app = harness.app as NestExpressApplication;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('describes exactly the routes the application registers', () => {
    const registered = registeredRoutes(app);
    registered.delete('get /openapi.json');
    const documented = documentedRoutes(document);

    // Both directions. A missing route is a gap an integrating team falls into;
    // an extra one is an endpoint they will write code against and never reach.
    expect([...registered].filter((route) => !documented.has(route)).sort()).toEqual(
      [],
    );
    expect([...documented].filter((route) => !registered.has(route)).sort()).toEqual(
      [],
    );
  });

  it('covers every controller the application registers', () => {
    const missing = registeredControllers(app)
      // `OpenApiController` serves the document; it is not part of the API the
      // document describes (see its header).
      .filter((controller) => controller !== OpenApiController)
      .filter((controller) => !ROUTE_RESPONSES.has(controller))
      .map((controller) => controller.name);

    expect(missing).toEqual([]);
  });

  describe('serving it (H6)', () => {
    it('is off unless a deployment opts in', async () => {
      const response = await harness.get('/openapi.json');

      // A disabled endpoint looks like an absent one, not like one worth
      // retrying with credentials.
      expect(response.status).toBe(404);
    });

    it('serves the document when enabled', async () => {
      const enabled = await createHarness({
        env: testEnv({ OPENAPI_ENABLED: 'true' }),
      });
      try {
        const response = await enabled.get('/openapi.json');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(document);
      } finally {
        await enabled.close();
      }
    });
  });

  it('refuses to describe a route whose response is not declared', () => {
    @Controller('__undeclared')
    class UndeclaredController {
      @Get()
      list(): [] {
        return [];
      }
    }

    expect(() => buildOpenApiDocument([UndeclaredController])).toThrow(
      /has no response declared/,
    );
  });

  describe('the error envelope (Doc 06 §2)', () => {
    const envelope = { $ref: '#/components/schemas/IamErrorResponse' };

    /** Every operation outside `/health` and `/ready`, which §13 exempts. */
    const apiOperations = () =>
      Object.entries(document.paths)
        .filter(([path]) => path !== '/health' && path !== '/ready')
        .flatMap(([path, operations]) =>
          Object.entries(operations).map(([verb, operation]) => ({
            route: `${verb} ${path}`,
            operation,
          })),
        );

    it('is a documented response on every route', () => {
      const without = apiOperations()
        .filter(({ operation }) =>
          Object.entries(operation.responses)
            .filter(([status]) => Number(status) >= 400)
            .every(
              ([, response]) =>
                JSON.stringify(response.content?.['application/json'].schema) !==
                JSON.stringify(envelope),
            ),
        )
        .map(({ route }) => route);

      expect(without).toEqual([]);
    });

    it('publishes the code table as a closed enum', () => {
      const schema = document.components.schemas['IamErrorResponse'] as {
        properties: { error: { properties: { code: { enum: string[] } } } };
      };

      expect(schema.properties.error.properties.code.enum).toEqual([
        'VALIDATION_FAILED',
        'AUTH_REQUIRED',
        'INVALID_CREDENTIALS',
        'PERMISSION_DENIED',
        'SCOPE_DENIED',
        'NOT_FOUND',
        'CONFLICT',
        'ACCOUNT_LOCKED',
        'RATE_LIMITED',
        'INTERNAL_ERROR',
      ]);
    });

    it('leaves the ops endpoints outside it', () => {
      // Doc 06 §13: a probe consumes status codes, not error codes. So no
      // envelope anywhere on these two, and no 4xx invented for them either.
      for (const path of ['/health', '/ready']) {
        for (const response of Object.values(document.paths[path].get.responses)) {
          expect(
            JSON.stringify(response.content?.['application/json'].schema),
          ).not.toContain('IamErrorResponse');
        }
      }
      expect(Object.keys(document.paths['/health'].get.responses)).toEqual(['200']);
      expect(Object.keys(document.paths['/ready'].get.responses)).toEqual([
        '200',
        '503',
      ]);

      // `/ready`'s 503 is the report again, not an error: the whole value of a
      // readiness probe is that the failing dependency is named.
      expect(
        document.paths['/ready'].get.responses['503'].content?.[
          'application/json'
        ].schema,
      ).toEqual({ $ref: '#/components/schemas/ReadinessReport' });
    });
  });

  describe('schemas', () => {
    it('resolves every $ref it emits', () => {
      const refs = [
        ...JSON.stringify(document.paths).matchAll(
          /"#\/components\/schemas\/([^"]+)"/g,
        ),
      ].map(([, name]) => name);

      expect(refs.length).toBeGreaterThan(0);
      const undefinedRefs = [...new Set(refs)].filter(
        (name) => document.components.schemas[name] === undefined,
      );
      expect(undefinedRefs).toEqual([]);
    });

    it('takes request bodies from the DTO the handler actually validates', () => {
      // Not merely "a body is documented": the schema published for
      // `POST /iam/applications` has to be the one `CreateApplicationDto`
      // enforces, which is what makes the document unable to drift from it.
      const body =
        document.paths['/iam/applications'].post.requestBody?.content[
          'application/json'
        ].schema;

      expect(body).toEqual({ $ref: '#/components/schemas/CreateApplicationDto' });
      const schema = document.components.schemas['CreateApplicationDto'] as {
        required: string[];
      };
      expect(schema.required.sort()).toEqual(['key', 'name']);
    });

    it('describes a query DTO as query parameters rather than a body', () => {
      const list = document.paths['/iam/applications'].get;

      expect(list.requestBody).toBeUndefined();
      expect(list.parameters?.map((parameter) => parameter.name)).toEqual([
        'page',
        'limit',
      ]);
    });
  });

  describe('statuses', () => {
    it('agrees with @HttpCode on every route', () => {
      // The declared status in `route-responses.ts` and the one the handler
      // actually answers with are two independent statements; a document is
      // only useful if they are the same statement.
      const disagreements: string[] = [];
      for (const [controller, responses] of ROUTE_RESPONSES) {
        for (const [path, operations] of Object.entries(document.paths)) {
          for (const [verb, operation] of Object.entries(operations)) {
            const [tag, handler] = operation.operationId.split('_');
            if (tag !== controller.name.replace(/Controller$/, '')) continue;
            const declared = responses[handler].status;
            if (!(String(declared) in operation.responses)) {
              disagreements.push(`${verb} ${path} → ${declared}`);
            }
          }
        }
      }
      expect(disagreements).toEqual([]);
    });
  });

  describe('media types', () => {
    /**
     * `route-responses.ts` declares the media type and the handler sets the
     * header; the two are independent statements about the same byte stream, so
     * — exactly as with `@HttpCode` above — they are cross-checked rather than
     * one being derived from the other.
     *
     * Compared on the type alone: the header carries `charset`, which is a
     * parameter of the media type and not part of it, and OpenAPI keys `content`
     * by the type.
     */
    const declaredMediaTypeOf = (
      controller: Type<unknown>,
      handler: string,
    ): string | undefined => {
      const headers = Reflect.getMetadata(
        HEADERS_METADATA,
        (controller.prototype as unknown as Record<string, object>)[handler],
      ) as { name: string; value: string }[] | undefined;

      return headers
        ?.find(({ name }) => name.toLowerCase() === 'content-type')
        ?.value.split(';')[0]
        .trim();
    };

    it('agrees with the content-type header the handler sets', () => {
      const disagreements: string[] = [];

      for (const [controller, responses] of ROUTE_RESPONSES) {
        for (const [handler, spec] of Object.entries(responses)) {
          const header = declaredMediaTypeOf(controller, handler);
          const declared = spec.mediaType ?? (spec.schema && 'application/json');
          if (header !== undefined && header !== declared) {
            disagreements.push(`${controller.name}.${handler}: ${header} ≠ ${declared}`);
          }
        }
      }

      expect(disagreements).toEqual([]);
    });

    it('names every body that is not JSON, and there are two', () => {
      // Enumerated rather than spot-checked: the interesting regression is a
      // *new* non-JSON body appearing unnoticed, or one of these two silently
      // reverting to `application/json` — which a generated client would then
      // try to parse. Both fail here.
      const exceptions = Object.entries(document.paths)
        .flatMap(([path, operations]) =>
          Object.entries(operations).flatMap(([verb, operation]) =>
            Object.entries(operation.responses).flatMap(([status, response]) =>
              Object.keys(response.content ?? {}).map(
                (type) => `${verb} ${path} ${status} → ${type}`,
              ),
            ),
          ),
        )
        .filter((entry) => !entry.endsWith('application/json'));

      expect(exceptions.sort()).toEqual([
        // The JWK Set of RFC 7517 §8.5.1 …
        'get /iam/.well-known/jwks.json 200 → application/jwk-set+json',
        // … and the CSV export of Doc 10 §7.
        'get /iam/audit/export 200 → text/csv',
      ]);
    });
  });

  it('matches the committed openapi.json', () => {
    // The document is committed so a change to a published contract is visible
    // in a diff. This is what keeps that true: an edited DTO or response schema
    // fails here rather than leaving the checked-in document describing the
    // previous release. Run `npm run openapi` to update it.
    const committed = readFileSync(
      join(__dirname, '..', '..', 'openapi.json'),
      'utf-8',
    );

    expect(JSON.parse(committed)).toEqual(document);
  });
});
