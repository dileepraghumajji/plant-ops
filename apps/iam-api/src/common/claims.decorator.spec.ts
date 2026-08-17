/**
 * `@Claims()` as the assembled app applies it.
 *
 * The decorator is four lines and testing it in isolation would prove almost
 * nothing: calling the factory with a hand-built `ExecutionContext` asserts that
 * a function reads a symbol off an object. What actually needs proving is that
 * the *pipeline* delivers verified claims to a handler parameter and refuses in
 * the Doc 06 §2 envelope when there are none — which needs the real guard, the
 * real filter and a real request. So both suites below run against
 * `createHarness`.
 *
 * The `@Public()` controller is the interesting one. It is the wiring bug the
 * fail-closed branch exists for — a route that asks for a subject but is not
 * behind the guard — and it is the only way to reach that branch at all, since
 * with the guard in place an unauthenticated request never gets to the handler.
 */

import { Controller, Get } from '@nestjs/common';
import { NoPermissionRequired, Public } from '@plantops/auth-kit';
import { IamErrorCode, type IamErrorResponse } from '@plantops/contracts';
import type { VerifiedClaims } from '@plantops/db';
import { type Harness, createHarness } from '../testing/app-harness';
import { SkipTransaction } from './transaction-context';
import { Claims } from './claims.decorator';

/** Reports what the decorator handed it, so a test can compare against the token. */
// A fixture controller for a spec about something else. The pipeline it
// runs through is the real one, so an ungated route still has to say so.
@NoPermissionRequired('test fixture')
@Controller('__claims')
@SkipTransaction()
class ClaimsController {
  @Get()
  read(@Claims() claims: VerifiedClaims): VerifiedClaims {
    return claims;
  }
}

/**
 * The wiring bug, mounted deliberately: `@Public()` *and* asking for a subject.
 * No real route looks like this, and the point is that if one ever did it would
 * fail closed instead of running with nothing.
 */
// A fixture controller for a spec about something else. The pipeline it
// runs through is the real one, so an ungated route still has to say so.
@NoPermissionRequired('test fixture')
@Controller('__claims-unguarded')
@Public()
@SkipTransaction()
class UnguardedClaimsController {
  @Get()
  read(@Claims() claims: VerifiedClaims): VerifiedClaims {
    return claims;
  }
}

describe('@Claims()', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      controllers: [ClaimsController, UnguardedClaimsController],
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('hands the handler the claims the guard verified', async () => {
    const token = harness.tokenFor();

    const response = await harness.get('/__claims', { headers: token.headers });

    expect(response.status).toBe(200);
    // Every field the services key off: the subject, its type, the tenant and
    // the session. Not a subset — a decorator that dropped `cid` would still
    // pass a `sub`-only assertion and would break every tenant-scoped service.
    expect(await response.json()).toMatchObject({
      sub: token.claims.sub,
      sty: token.claims.sty,
      cid: token.claims.cid,
      sid: token.claims.sid,
    });
  });

  it('fails closed on a route that reaches the handler without claims', async () => {
    const response = await harness.get('/__claims-unguarded');
    const body = (await response.json()) as IamErrorResponse;

    // The same 401 an anonymous request gets anywhere else — the envelope, not
    // Nest's own body, so the throw goes through `HttpExceptionFilter`.
    expect(response.status).toBe(401);
    expect(body.error.code).toBe(IamErrorCode.AUTH_REQUIRED);
    expect(body.error.requestId).toEqual(expect.any(String));
  });

  it('refuses the guarded route before the handler is reached at all', async () => {
    // The ordinary path, for contrast: the guard answers, and the decorator's
    // own check is never what refuses a real anonymous request.
    const response = await harness.get('/__claims');

    expect(response.status).toBe(401);
    expect(((await response.json()) as IamErrorResponse).error.code).toBe(
      IamErrorCode.AUTH_REQUIRED,
    );
  });
});

describe('controllers after the refactor', () => {
  it('has no copy of the old claimsOf() helper left', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const source = join(__dirname, '..');
    const directories = await readdir(source, { withFileTypes: true });
    const controllers: string[] = [];
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      const files = await readdir(join(source, entry.name));
      for (const file of files) {
        if (file.endsWith('.controller.ts')) {
          controllers.push(join(source, entry.name, file));
        }
      }
    }

    // Not a style check: the duplicated helper is the thing H2 removed, and it
    // comes back one controller at a time unless something says so.
    expect(controllers.length).toBeGreaterThan(0);
    for (const path of controllers) {
      const text = await readFile(path, 'utf8');
      expect(text).not.toMatch(/function claimsOf\b/);
    }
  });

  it('leaves express imported only where the raw request or response is used', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const source = join(__dirname, '..');
    const directories = await readdir(source, { withFileTypes: true });
    const offenders: string[] = [];
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      const files = await readdir(join(source, entry.name));
      for (const file of files) {
        if (!file.endsWith('.controller.ts')) continue;
        const path = join(source, entry.name, file);
        const text = await readFile(path, 'utf8');
        // `/ready` is the sole legitimate case (`@Res({ passthrough: true })`),
        // and it carries the reason in a comment above the import.
        if (/from 'express'/.test(text) && !/@Res\(/.test(text)) {
          offenders.push(`${entry.name}/${file}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
