import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_KEYS } from './env.schema.js';
import { type EnvSource, parseEnv } from './load-env.js';

/**
 * `.env.example` is the only documentation an operator reads before their first
 * boot. These tests keep it honest: every variable the schema knows is listed,
 * nothing stale lingers, and the template as shipped actually validates.
 */
const EXAMPLE_PATH = join(__dirname, '..', '..', '..', '.env.example');
const EXAMPLE = readFileSync(EXAMPLE_PATH, 'utf-8');

/** Minimal `KEY=value` reader — quotes stripped, comments and blanks skipped. */
function parseExample(contents: string): EnvSource {
  const entries: EnvSource = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    entries[key] = rawValue.replace(/^["'](.*)["']$/, '$1');
  }
  return entries;
}

/** Keys that appear either assigned or commented out as documentation. */
function documentedKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) keys.add(match[1]);
  }
  return keys;
}

describe('.env.example', () => {
  const documented = documentedKeys(EXAMPLE);
  const assigned = parseExample(EXAMPLE);

  it.each(ENV_KEYS)('documents %s', (key) => {
    expect(documented.has(key)).toBe(true);
  });

  it('documents nothing the schema does not read', () => {
    const known = new Set<string>(ENV_KEYS);
    expect([...documented].filter((key) => !known.has(key))).toEqual([]);
  });

  it('is itself a valid environment — copy, fill, boot', () => {
    expect(() => parseEnv(assigned)).not.toThrow();
  });

  it('ships no real secret', () => {
    const env = parseEnv(assigned);
    expect(env.PLATFORM_BOOTSTRAP_SECRET).toMatch(/change-me/i);
    expect(env.JWT_PRIVATE_KEY).toContain('...');
  });
});
