/**
 * The catalog and the database say the same words (Doc 10 §4).
 *
 * Some audit actions are written by TypeScript and some are pinned inside
 * migrations 0011–0015, which are frozen artefacts that import nothing from the
 * app (see `audit-actions.ts` for why). That leaves the same string spelled in
 * two files, and duplication nothing checks is drift with a delay on it: the
 * day `user.disabled` becomes `user.disable` on one side, every query written
 * against the other silently returns nothing, and the rows already committed
 * cannot be corrected.
 *
 * So this suite checks both directions — every constant the migrations export
 * is in the catalog, and every literal they embed is too.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCOUNT_AUDIT_ACTIONS,
  ONPREM_AUDIT_ACTIONS,
  REFRESH_AUDIT_ACTIONS,
  ROLE_BINDING_EXPIRED_ACTION,
  SERVICE_ACCOUNT_AUDIT_ACTIONS,
} from '@plantops/db';
import { AUDIT_ACTIONS } from './audit-actions';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', 'libs', 'db', 'src', 'migrations');

const catalog: readonly string[] = Object.values(AUDIT_ACTIONS);

function migrationSources(): { file: string; source: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{4}-.*\.ts$/.test(file))
    .map((file) => ({ file, source: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }));
}

describe('the action catalog', () => {
  it('has no duplicate strings under two names', () => {
    expect(new Set(catalog).size).toBe(catalog.length);
  });

  it.each([
    ['REFRESH_AUDIT_ACTIONS', REFRESH_AUDIT_ACTIONS],
    ['ACCOUNT_AUDIT_ACTIONS', ACCOUNT_AUDIT_ACTIONS],
    ['SERVICE_ACCOUNT_AUDIT_ACTIONS', SERVICE_ACCOUNT_AUDIT_ACTIONS],
    // A bare string rather than a group: migration 0016 writes exactly one
    // action, and wrapping it in an object to fit this table would invent a
    // namespace the migration does not have.
    ['ROLE_BINDING_EXPIRED_ACTION', { EXPIRED: ROLE_BINDING_EXPIRED_ACTION }],
    // Session 45. `SEEDED` is written by migration 0019 and would be caught by
    // the literal scan below too; `BREAK_GLASS` is written by
    // `tools/break-glass-admin.ts`, which no scan of this directory can see —
    // so this row is the only thing pinning that spelling to the catalog.
    ['ONPREM_AUDIT_ACTIONS', ONPREM_AUDIT_ACTIONS],
  ])('contains every action %s exports', (_name, actions) => {
    for (const action of Object.values(actions)) {
      expect(catalog).toContain(action);
    }
  });

  it('spells the sweep action the same way the catalog does', () => {
    // The one the regex below cannot see: 0016 interpolates the constant rather
    // than embedding a literal, which is the *right* way round and therefore
    // needs its own assertion.
    expect(ROLE_BINDING_EXPIRED_ACTION).toBe(AUDIT_ACTIONS.ROLE_BINDING_EXPIRED);
  });

  it('contains every action a migration passes to write_audit as a literal', () => {
    // The interpolated ones — `'${REFRESH_AUDIT_ACTIONS.ROTATED}'` — are
    // covered by the exported-constant check above; this catches the literals,
    // which is what a *new* migration is most likely to introduce.
    const found = migrationSources().flatMap(({ file, source }) =>
      [...source.matchAll(/write_audit\(\s*'([a-z_]+(?:\.[a-z_]+)+)'/g)].map(
        (match) => ({ file, action: match[1] }),
      ),
    );

    // A regex that matches nothing would pass this suite vacuously.
    expect(found.length).toBeGreaterThan(0);

    for (const { file, action } of found) {
      expect(`${file}: ${action}`).toBe(
        `${file}: ${catalog.includes(action) ? action : 'NOT IN CATALOG'}`,
      );
    }
  });

  it.each([
    AUDIT_ACTIONS.LOGIN_SUCCESS,
    // Written by a direct INSERT rather than through `write_audit`, because a
    // failed login has no session context to derive an actor from (migration
    // 0012) — so the regex above cannot see it and this names it explicitly.
    AUDIT_ACTIONS.LOGIN_FAILED,
    AUDIT_ACTIONS.PLATFORM_BOOTSTRAP,
  ])('still finds %s embedded in a migration', (action) => {
    const sources = migrationSources();
    expect(sources.some(({ source }) => source.includes(`'${action}'`))).toBe(true);
  });
});
