import { HttpTransport, type FetchLike } from '@plantops/iam-client';

import {
  apiLabelFor,
  IAM_API_URL,
  resolveApiBase,
} from '../src/lib/api-config';

/**
 * The console's one piece of self-configuration (Doc 11 §8, gap 2).
 *
 * Worth a suite because it is what makes a single build serve any hostname: if
 * the default stops being relative, or a relative base stops producing a
 * correct request URL, nothing fails loudly — the console simply calls the
 * wrong origin on a customer's server, where nobody is watching a test run.
 */
describe('resolveApiBase', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('defaults a %s value to the same-origin path', (_name, configured) => {
    expect(resolveApiBase(configured)).toBe('/api');
  });

  it('honours an absolute origin exactly as before', () => {
    expect(resolveApiBase('http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveApiBase('https://iam.plantops.example')).toBe(
      'https://iam.plantops.example',
    );
  });

  it('trims the whitespace a copied .env line brings with it', () => {
    expect(resolveApiBase('  https://iam.plantops.example  ')).toBe(
      'https://iam.plantops.example',
    );
  });
});

describe('apiLabelFor', () => {
  it.each([
    ['https://iam.plantops.example', 'iam.plantops.example'],
    ['http://localhost:3000', 'localhost:3000'],
    ['https://iam.plantops.example/', 'iam.plantops.example'],
    ['//iam.plantops.example', 'iam.plantops.example'],
  ])('strips the scheme off %s', (base, label) => {
    expect(apiLabelFor(base)).toBe(label);
  });

  it.each([
    ['/api', 'same origin /api'],
    ['/iam-api', 'same origin /iam-api'],
    ['/api/', 'same origin /api'],
    ['/', 'same origin'],
    ['', 'same origin'],
  ])('names %s for what it is rather than stripping nothing', (base, label) => {
    expect(apiLabelFor(base)).toBe(label);
  });
});

/**
 * The line the whole arrangement rests on.
 *
 * `HttpTransport` builds a request URL by concatenating `baseUrl + path`, which
 * is why a relative base needs no change anywhere in `libs/iam-client`. That is
 * an assumption about somebody else's file, so it is asserted here rather than
 * believed — through the real transport, not a re-implementation of it.
 */
describe('a relative base at the transport', () => {
  const capture = (): { fetch: FetchLike; urls: string[] } => {
    const urls: string[] = [];
    const fetch: FetchLike = (url) => {
      urls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve('{}'),
      });
    };
    return { fetch, urls };
  };

  it('sends the default base to a same-origin path', async () => {
    const { fetch, urls } = capture();
    const transport = new HttpTransport({
      baseUrl: resolveApiBase(undefined),
      fetch,
    });

    await transport.request({ method: 'POST', path: '/auth/login', auth: 'none' });

    expect(urls).toEqual(['/api/auth/login']);
  });

  it('keeps the query string and the /iam prefix intact', async () => {
    const { fetch, urls } = capture();
    const transport = new HttpTransport({
      baseUrl: resolveApiBase(undefined),
      fetch,
    });

    await transport.request({
      method: 'GET',
      path: '/iam/users',
      query: { status: 'active', limit: 25 },
    });

    expect(urls).toEqual(['/api/iam/users?status=active&limit=25']);
  });

  it('still builds an absolute URL from an absolute base', async () => {
    const { fetch, urls } = capture();
    const transport = new HttpTransport({
      baseUrl: resolveApiBase('http://localhost:3000'),
      fetch,
    });

    await transport.request({ method: 'POST', path: '/auth/login', auth: 'none' });

    expect(urls).toEqual(['http://localhost:3000/auth/login']);
  });
});

/**
 * `IAM_API_URL` is fixed at import, and under `next/jest` that import has
 * already seen `apps/admin-web/.env.local` — so this asserts the shape of what
 * the module produced, not a value the developer's env file decides.
 */
describe('IAM_API_URL', () => {
  it('is a usable base: either an absolute origin or an origin-relative path', () => {
    expect(IAM_API_URL).toMatch(/^(https?:\/\/\S+|\/\S*)$/);
  });

  it('carries no trailing slash into the transport', () => {
    expect(IAM_API_URL === '/' || !IAM_API_URL.endsWith('/')).toBe(true);
  });
});
