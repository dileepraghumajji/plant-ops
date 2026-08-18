import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface NavEntry {
  route?: string;
  children?: NavEntry[];
}

function routesOf(entries: readonly NavEntry[]): string[] {
  return entries.flatMap((entry) => [
    ...(typeof entry.route === 'string' ? [entry.route] : []),
    ...routesOf(entry.children ?? []),
  ]);
}

function pageFor(route: string): string {
  return join(__dirname, '../src/app', route.replace(/^\/+|\/+$/g, ''), 'page.tsx');
}

/**
 * The console's routes are not a frontend decision.
 *
 * They are whatever the IAM's own manifest put in the nav catalog (Doc 02,
 * Doc 05 §7) — the console renders the tree the server sends and keeps no menu
 * constants of its own. A route in that catalog with nothing behind it is a menu
 * item that leads to "no screen here", which an administrator reads as a broken
 * console.
 *
 * While Sessions 28–37 were building, "something behind it" could also mean a
 * placeholder naming the session that would replace it, and
 * `pending-screens.spec.ts` allowed for both. Milestone 3 is complete, every
 * placeholder is gone, and the bar is now the real one: a page.
 *
 * The check runs against the manifest rather than against a list here, so
 * adding a menu to `tools/iam-manifest.json` without a screen fails a test
 * instead of shipping a dead link.
 */
describe('the IAM manifest’s menu', () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../../../tools/iam-manifest.json'), 'utf-8'),
  ) as { nav: NavEntry[] };

  const routes = routesOf(manifest.nav);

  it('puts at least one route in the menu', () => {
    // Guards the two assertions below from passing vacuously if the manifest
    // were ever read wrong.
    expect(routes.length).toBeGreaterThan(5);
  });

  it.each(routes)('has a screen at %s', (route) => {
    expect(existsSync(pageFor(route))).toBe(true);
  });

  it('has no placeholder left anywhere', () => {
    // The console's own scaffolding is gone; `unknown-screen.tsx` is what a
    // route outside the build resolves to now, and no manifest route may reach
    // it. A page that mounted it would be a menu entry with nothing behind it,
    // which is exactly what the assertion above exists to catch — this one
    // catches it hiding inside a file that does exist.
    const placeholders = routes.filter((route) => {
      const page = pageFor(route);
      return existsSync(page) && readFileSync(page, 'utf-8').includes('UnknownScreen');
    });

    expect(placeholders).toEqual([]);
  });
});
