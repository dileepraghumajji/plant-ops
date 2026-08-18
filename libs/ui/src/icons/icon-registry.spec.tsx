import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { iconForKey, isKnownIconKey, knownIconKeys } from './icon-registry';

describe('icon registry', () => {
  it('resolves a known key to a component', () => {
    expect(typeof iconForKey('users')).toBe('object');
    expect(isKnownIconKey('users')).toBe(true);
  });

  /**
   * Icon keys are catalog data written at runtime (Doc 02 §8), so the registry
   * is permanently incomplete by design. An unknown key must degrade to a
   * glyph, never to `undefined` — a menu row that renders no icon is 14px
   * shorter than its neighbours and looks like a rendering bug.
   */
  it('falls back rather than failing on a key nobody has mapped', () => {
    expect(isKnownIconKey('forklift')).toBe(false);
    expect(iconForKey('forklift')).toBeDefined();
    expect(iconForKey(null)).toBeDefined();
    expect(iconForKey(undefined)).toBeDefined();
  });

  it('lists its keys sorted, for a catalog editor’s picker', () => {
    const keys = knownIconKeys();
    expect(keys).toEqual([...keys].sort());
    expect(keys.length).toBeGreaterThan(0);
  });

  /**
   * The IAM dogfoods its own registry (Doc 02, roadmap Session 23), so its
   * manifest is the one catalog this console is guaranteed to render. Every
   * icon it names should resolve properly rather than through the fallback —
   * a mapped key that quietly became a fallback is invisible in a screenshot
   * and obvious to nobody.
   */
  it('maps every icon key the IAM’s own manifest uses', () => {
    const manifestPath = join(__dirname, '../../../../tools/iam-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      nav: NavEntry[];
    };

    const unmapped = collectIconKeys(manifest.nav).filter((key) => !isKnownIconKey(key));

    expect(unmapped).toEqual([]);
  });
});

interface NavEntry {
  icon?: string;
  children?: NavEntry[];
}

function collectIconKeys(entries: readonly NavEntry[]): string[] {
  return entries.flatMap((entry) => [
    ...(typeof entry.icon === 'string' ? [entry.icon] : []),
    ...collectIconKeys(entry.children ?? []),
  ]);
}
