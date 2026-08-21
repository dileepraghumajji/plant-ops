/**
 * The deployed build, over `/health` (Doc 11 §8, gap 8).
 *
 * The property this file protects is smaller than it looks, and it is the one
 * the release pipeline leans on. CI builds each image with
 * `--build-arg APP_VERSION=<tag>`, boots the stack, and asserts that
 * `/health`'s `version` is that same string (`.github/workflows/ci.yml`, the
 * `stack` job). That check is only meaningful if the endpoint reports the
 * configured value **verbatim** — the moment anything here prefixes a `v`,
 * trims a suffix, or falls back to a package version, the pipeline compares two
 * strings that were never supposed to be equal and the failure reads as a
 * broken tag rather than a broken endpoint.
 *
 * So: reported exactly, from the validated environment, with no credential
 * required, and refused at boot rather than reported blank.
 */

import { type Harness, createHarness, testEnv } from '../testing/app-harness';

describe('/health — reported version', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  it('reports APP_VERSION verbatim — the string CI compares against the image tag', async () => {
    harness = await createHarness({ env: testEnv({ APP_VERSION: '1.4.2-rc.3' }) });

    const response = await harness.get('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      version: '1.4.2-rc.3',
      uptimeSeconds: expect.any(Number),
    });
  });

  it('reports it without a credential — support asks from outside the guard', async () => {
    harness = await createHarness({ env: testEnv({ APP_VERSION: '2.0.0' }) });

    // No `authorization` header, deliberately. A version readable only by an
    // authenticated caller is unreadable by the person on the phone.
    const body = (await (await harness.get('/health')).json()) as {
      version: string;
    };

    expect(body.version).toBe('2.0.0');
  });

  it('falls back to 0.0.0-dev when nothing stamped it', async () => {
    // What a developer's `nx serve` reports. Named rather than empty, so a
    // support answer of "0.0.0-dev" is unambiguous: this is not a release.
    harness = await createHarness({ env: testEnv() });

    const body = (await (await harness.get('/health')).json()) as {
      version: string;
    };

    expect(body.version).toBe('0.0.0-dev');
  });

  it('refuses to boot on a blank APP_VERSION rather than reporting an empty version', () => {
    // The realistic way to get here is an image built with
    // `--build-arg APP_VERSION=` — a CI expression that resolved to nothing.
    // Failing at boot makes that a red pipeline; reporting `""` would make it a
    // support call six months later.
    expect(() => testEnv({ APP_VERSION: '   ' })).toThrow(/APP_VERSION/);
  });
});
