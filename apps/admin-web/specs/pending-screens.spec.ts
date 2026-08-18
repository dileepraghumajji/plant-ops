import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PENDING_SCREENS, pendingScreenFor } from '../src/lib/pending-screens';

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

/**
 * Does a real screen live at this route?
 *
 * Next resolves a literal segment ahead of the optional catch-all, so a
 * `page.tsx` at the route's path takes the route over from the placeholder with
 * no other coordination. That is the mechanism each screen session uses to
 * retire its own row from `PENDING_SCREENS`.
 *
 * A file is not enough to answer, though, and has not been since Session 33.
 * `admin/users/[id]` is a dynamic segment, which also beats the catch-all — so
 * `/admin/users/by-role` and `/admin/users/bulk` needed `page.tsx` files of
 * their own just to keep rendering the placeholder they were already rendering.
 * A page that mounts `<PendingScreenPage>` is still a pending screen, whatever
 * the filesystem looks like, and this is where the two are told apart.
 */
function hasBuiltScreen(route: string): boolean {
  const segments = route.replace(/^\/+|\/+$/g, '');
  if (segments === '') return false;

  const page = join(__dirname, '../src/app', segments, 'page.tsx');
  if (!existsSync(page)) return false;
  return !readFileSync(page, 'utf-8').includes('PendingScreenPage');
}

describe('pending screens', () => {
  /**
   * The console's routes are not a frontend decision — they are whatever the
   * IAM's own manifest put in the nav catalog (Doc 02, Doc 05 §7). A route in
   * the catalog with nothing behind it is a menu item that leads to "no screen
   * here", which an admin reads as a broken console.
   *
   * "Something behind it" means one of two things while the console is still
   * being built: a real screen at that path, or a placeholder that names the
   * session which replaces it. Session 28 turned `/platform/applications` from
   * the second into the first, and the assertion holds either way.
   */
  it('covers every route the IAM manifest puts in the menu', () => {
    const manifestPath = join(__dirname, '../../../tools/iam-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      nav: NavEntry[];
    };

    const uncovered = routesOf(manifest.nav).filter(
      (route) => pendingScreenFor(route) === null && !hasBuiltScreen(route),
    );

    expect(uncovered).toEqual([]);
  });

  /**
   * The placeholder and the finished screen are alternatives, not layers. A row
   * left behind after its page landed would be dead code that still passes the
   * coverage test above — and, worse, would read as though the screen were
   * still pending.
   */
  it('has no placeholder left for a route that now has a screen', () => {
    const stale = Object.keys(PENDING_SCREENS).filter(hasBuiltScreen);
    expect(stale).toEqual([]);
  });

  it('names the roadmap session that replaces each placeholder', () => {
    for (const [route, screen] of Object.entries(PENDING_SCREENS)) {
      expect(screen.session).toMatch(/Session/);
      expect(screen.title.length).toBeGreaterThan(0);
      expect(screen.description.length).toBeGreaterThan(0);
      expect(route.startsWith('/')).toBe(true);
    }
  });

  it('matches a route with a trailing slash', () => {
    // Whichever route is still pending — the point is the normalisation, and
    // naming a route here would make this fail every time a session retires
    // one, which is what the last three sessions kept doing.
    const [route, screen] = Object.entries(PENDING_SCREENS)[0];

    expect(pendingScreenFor(`${route}/`)?.title).toBe(screen.title);
  });

  it('has nothing for a route the console does not know', () => {
    // A catalog may legitimately point at a screen this build lacks — an
    // application registered ahead of its console.
    expect(pendingScreenFor('/gatepass/passes')).toBeNull();
  });
});
