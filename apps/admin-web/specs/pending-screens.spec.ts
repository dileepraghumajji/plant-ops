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

describe('pending screens', () => {
  /**
   * The console's routes are not a frontend decision — they are whatever the
   * IAM's own manifest put in the nav catalog (Doc 02, Doc 05 §7). A route in
   * the catalog with nothing behind it is a menu item that leads to "no screen
   * here", which an admin reads as a broken console.
   *
   * This is scaffolding-era cover: each screen session replaces its row with a
   * real page at the same path, and the assertion keeps holding because the
   * page takes the route over.
   */
  it('covers every route the IAM manifest puts in the menu', () => {
    const manifestPath = join(__dirname, '../../../tools/iam-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      nav: NavEntry[];
    };

    const uncovered = routesOf(manifest.nav).filter(
      (route) => pendingScreenFor(route) === null,
    );

    expect(uncovered).toEqual([]);
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
    expect(pendingScreenFor('/admin/users/')?.title).toBe('Users');
  });

  it('has nothing for a route the console does not know', () => {
    // A catalog may legitimately point at a screen this build lacks — an
    // application registered ahead of its console.
    expect(pendingScreenFor('/gatepass/passes')).toBeNull();
  });
});
