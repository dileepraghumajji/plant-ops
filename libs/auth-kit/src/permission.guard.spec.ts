/**
 * `PermissionGuard` as a framework adapter — the part `scope-resolver.spec.ts`
 * cannot reach.
 *
 * The rule itself is tested there, over plain values. What is left here is
 * everything that only exists because Nest exists, and every one of these is a
 * property somebody could break without failing a single assertion about
 * coverage:
 *
 * - a route that declares **nothing** is refused (the deny-by-default direction
 *   `require-permission.decorator.ts` argues for, and the reason
 *   `@NoPermissionRequired()` has to exist at all);
 * - `@Public()` short-circuits ahead of everything, because a public route has
 *   no subject to resolve grants for;
 * - the handler's metadata overrides the controller's;
 * - `scopeFrom` reads the place in the request it names, and nowhere else;
 * - the two outcomes become the two Doc 06 §2 codes;
 * - every denial reaches the auditor, with what was attempted.
 */

import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IamErrorCode, type ResolvedGrants } from '@plantops/contracts';
import { Public } from './auth.guard';
import {
  AuthorizationDeniedException,
  DenialAuditor,
  PermissionGuard,
  type VerifiedClaimsSource,
} from './permission.guard';
import {
  NoPermissionRequired,
  RequirePermission,
  readScopeTarget,
} from './require-permission.decorator';
import {
  AuthorizationOutcome,
  ScopeResolver,
  type GrantsSource,
  type SubjectClaims,
} from './scope-resolver';

const CLAIMS: SubjectClaims = {
  sub: 'subject-1',
  sty: 'user',
  cid: 'client-1',
  sid: 'session-1',
};

const APPROVE = 'gatepass.dc.approve';

const GRANTS: ResolvedGrants = {
  permissions: [APPROVE],
  scopes: { [APPROVE]: ['g.a'] },
};

/** `g.a` is Plant A; `gate1` is beneath it, `gate9` is not. */
const TREE: Record<string, string> = { gate1: 'g.a.1', gate9: 'g.b.9' };

interface Request {
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

/**
 * A minimal `ExecutionContext` over a handler, its controller and a request.
 *
 * Real classes and real decorators rather than a metadata map, so that
 * `Reflector.getAllAndOverride`'s own lookup is exercised — the override order
 * between handler and controller is one of the things under test, and a stub
 * that returned a value would be asserting the stub.
 */
function contextFor(
  controller: new () => object,
  handlerName: string,
  request: Request = {},
): ExecutionContext {
  const handler = (controller.prototype as Record<string, unknown>)[handlerName];
  return {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * `null` means "the request carries no claims" — spelled that way rather than
 * `undefined`, which a default parameter would swallow back into {@link CLAIMS}.
 */
function guardOver(
  claims: SubjectClaims | null = CLAIMS,
  auditor: DenialAuditor | null = null,
): PermissionGuard {
  const source: GrantsSource = {
    authorize: (_c, scopeNodeId) =>
      Promise.resolve(
        scopeNodeId === undefined
          ? { grants: GRANTS }
          : { grants: GRANTS, targetPath: TREE[scopeNodeId] ?? null },
      ),
  };
  const claimsSource: VerifiedClaimsSource = { claimsOf: () => claims ?? undefined };
  return new PermissionGuard(
    new Reflector(),
    new ScopeResolver(source),
    claimsSource,
    auditor,
  );
}

// ── the fixture controllers ─────────────────────────────────────────────────

class UndeclaredController {
  read(): void {
    /* declares neither decorator — the wiring mistake under test */
  }
}

class ExemptController {
  @NoPermissionRequired('answers a question about the bearer themselves')
  read(): void {
    /* intentionally ungated */
  }
}

class PublicController {
  @Public()
  read(): void {
    /* no subject at all */
  }
}

@RequirePermission(APPROVE)
class ScopedController {
  /** Inherits the controller's requirement. */
  list(): void {
    /* unscoped */
  }

  @RequirePermission(APPROVE, { scopeFrom: 'params.id' })
  update(): void {
    /* scoped on the path segment */
  }

  @RequirePermission(APPROVE, { scopeFrom: 'body.scope_node_id' })
  bind(): void {
    /* scoped on a body field */
  }

  @RequirePermission('gatepass.dc.create')
  create(): void {
    /* a permission the subject does not hold — overrides the class */
  }
}

// ── the cases ───────────────────────────────────────────────────────────────

describe('PermissionGuard', () => {
  it('refuses a route that declares neither decorator', async () => {
    // The whole argument for deny-by-default: forgetting the decorator produces
    // a 403 on the first request rather than an ungated route nobody notices.
    await expect(
      guardOver().canActivate(contextFor(UndeclaredController, 'read')),
    ).rejects.toBeInstanceOf(AuthorizationDeniedException);
  });

  it('admits a route that says why it is ungated', async () => {
    await expect(
      guardOver().canActivate(contextFor(ExemptController, 'read')),
    ).resolves.toBe(true);
  });

  it('admits a @Public() route without looking for a subject', async () => {
    // `undefined` claims: a public route reaches the guard with none, and the
    // exemption has to be decided before that is a problem.
    await expect(
      guardOver(null).canActivate(contextFor(PublicController, 'read')),
    ).resolves.toBe(true);
  });

  it('refuses an authenticated route that somehow has no claims', async () => {
    await expect(
      guardOver(null).canActivate(contextFor(ScopedController, 'list')),
    ).rejects.toBeInstanceOf(AuthorizationDeniedException);
  });

  it('inherits the controller-level requirement', async () => {
    await expect(
      guardOver().canActivate(contextFor(ScopedController, 'list')),
    ).resolves.toBe(true);
  });

  it('lets the handler override the controller', async () => {
    await expect(
      guardOver().canActivate(contextFor(ScopedController, 'create')),
    ).rejects.toMatchObject({ code: IamErrorCode.PERMISSION_DENIED });
  });

  it('reads the scope target from the path segment `scopeFrom` names', async () => {
    await expect(
      guardOver().canActivate(
        contextFor(ScopedController, 'update', { params: { id: 'gate1' } }),
      ),
    ).resolves.toBe(true);
  });

  it('answers SCOPE_DENIED for a node the grants do not cover', async () => {
    await expect(
      guardOver().canActivate(
        contextFor(ScopedController, 'update', { params: { id: 'gate9' } }),
      ),
    ).rejects.toMatchObject({ code: IamErrorCode.SCOPE_DENIED });
  });

  it('reads a body field where the route names one', async () => {
    await expect(
      guardOver().canActivate(
        contextFor(ScopedController, 'bind', { body: { scope_node_id: 'gate1' } }),
      ),
    ).resolves.toBe(true);
  });

  // The guard runs before the validation pipe, so it reads the raw body — a
  // field in the wrong place is a field that was not sent, and a route that
  // declared a target and got none is refused (`scopeOptional` is off here).
  it('ignores a target sitting somewhere other than where `scopeFrom` points', async () => {
    await expect(
      guardOver().canActivate(
        contextFor(ScopedController, 'bind', { query: { scope_node_id: 'gate1' } }),
      ),
    ).rejects.toMatchObject({ code: IamErrorCode.SCOPE_DENIED });
  });

  // A node this subject cannot see reaches the handler, which answers the 404
  // or 409 Doc 06 §2 fixes for an absent or foreign target.
  it('lets an invisible node through to the handler', async () => {
    await expect(
      guardOver().canActivate(
        contextFor(ScopedController, 'update', { params: { id: 'nobody-knows' } }),
      ),
    ).resolves.toBe(true);
  });

  it('audits a permission denial with what was attempted', async () => {
    const recordDenial = jest.fn(() => Promise.resolve());
    const guard = guardOver(CLAIMS, { recordDenial });

    await expect(
      guard.canActivate(contextFor(ScopedController, 'create')),
    ).rejects.toBeInstanceOf(AuthorizationDeniedException);

    expect(recordDenial).toHaveBeenCalledWith(
      CLAIMS,
      AuthorizationOutcome.PERMISSION_DENIED,
      'gatepass.dc.create',
      undefined,
    );
  });

  it('audits a scope denial with the node that was named', async () => {
    const recordDenial = jest.fn(() => Promise.resolve());
    const guard = guardOver(CLAIMS, { recordDenial });

    await expect(
      guard.canActivate(
        contextFor(ScopedController, 'update', { params: { id: 'gate9' } }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationDeniedException);

    expect(recordDenial).toHaveBeenCalledWith(
      CLAIMS,
      AuthorizationOutcome.SCOPE_DENIED,
      APPROVE,
      'gate9',
    );
  });

  it('audits nothing when the request is allowed', async () => {
    const recordDenial = jest.fn(() => Promise.resolve());
    const guard = guardOver(CLAIMS, { recordDenial });

    await guard.canActivate(contextFor(ScopedController, 'list'));

    expect(recordDenial).not.toHaveBeenCalled();
  });

  it('steps aside for a non-HTTP context', async () => {
    const context = {
      getType: () => 'rpc',
    } as unknown as ExecutionContext;
    await expect(guardOver().canActivate(context)).resolves.toBe(true);
  });
});

describe('readScopeTarget', () => {
  it('walks the dotted path', () => {
    expect(readScopeTarget({ params: { id: 'n1' } }, 'params.id')).toBe('n1');
    expect(readScopeTarget({ body: { a: { b: 'n2' } } }, 'body.a.b')).toBe('n2');
  });

  it('is undefined for anything that is not a non-empty string', () => {
    expect(readScopeTarget({ params: {} }, 'params.id')).toBeUndefined();
    expect(readScopeTarget({ body: { id: null } }, 'body.id')).toBeUndefined();
    expect(readScopeTarget({ body: { id: 42 } }, 'body.id')).toBeUndefined();
    expect(readScopeTarget({ body: { id: '  ' } }, 'body.id')).toBeUndefined();
    expect(readScopeTarget(undefined, 'params.id')).toBeUndefined();
  });

  // `scopeFrom` is authored in a controller rather than sent by a caller, but a
  // lookup that could walk into a prototype is one that resolves to something
  // no request contains.
  it('refuses to walk the prototype keys', () => {
    expect(readScopeTarget({}, '__proto__.id')).toBeUndefined();
    expect(readScopeTarget({}, 'constructor.name')).toBeUndefined();
  });
});
