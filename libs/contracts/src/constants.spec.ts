import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLIENT_PERMISSION_NAMESPACE,
  CLOCK_SKEW_LEEWAY_SECONDS,
  GRANTS_CACHE_MAX_TTL_SECONDS,
  GRANTS_CACHE_TTL_SECONDS,
  IAM_ISSUER,
  PLATFORM_PERMISSION_NAMESPACE,
  REFRESH_REUSE_GRACE_MAX_SECONDS,
  REFRESH_REUSE_GRACE_MIN_SECONDS,
  REFRESH_REUSE_GRACE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  SCOPE_PATH_LABEL_PREFIX,
  SERVICE_ACCESS_TOKEN_MAX_TTL_SECONDS,
  SERVICE_ACCESS_TOKEN_TTL_SECONDS,
} from './constants.js';

describe('shared constants', () => {
  it('pins the clock-skew leeway at the Doc 03 §6 value', () => {
    // IAM and every consuming module must agree on this exact number.
    expect(CLOCK_SKEW_LEEWAY_SECONDS).toBe(60);
  });

  it('uses the Doc 03 §2 issuer', () => {
    expect(IAM_ISSUER).toBe('plantops-iam');
  });

  it('keeps token TTLs inside their Doc 03 bands', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(30 * 24 * 60 * 60);
    // Service tokens are the revocation window itself (Doc 03 §5): ≤ 5 min.
    expect(SERVICE_ACCESS_TOKEN_MAX_TTL_SECONDS).toBe(5 * 60);
    expect(SERVICE_ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(
      SERVICE_ACCESS_TOKEN_MAX_TTL_SECONDS,
    );
  });

  it('keeps the refresh grace window inside Doc 03 §4 (10–30 s)', () => {
    expect(REFRESH_REUSE_GRACE_MIN_SECONDS).toBe(10);
    expect(REFRESH_REUSE_GRACE_MAX_SECONDS).toBe(30);
    expect(REFRESH_REUSE_GRACE_SECONDS).toBeGreaterThanOrEqual(
      REFRESH_REUSE_GRACE_MIN_SECONDS,
    );
    expect(REFRESH_REUSE_GRACE_SECONDS).toBeLessThanOrEqual(
      REFRESH_REUSE_GRACE_MAX_SECONDS,
    );
  });

  it('caps the grants cache TTL at the Doc 04 §6 bound', () => {
    // The TTL is also the staleness bound on expired bindings (Doc 01 §4.5).
    expect(GRANTS_CACHE_MAX_TTL_SECONDS).toBe(10 * 60);
    expect(GRANTS_CACHE_TTL_SECONDS).toBeLessThanOrEqual(
      GRANTS_CACHE_MAX_TTL_SECONDS,
    );
  });

  it('uses an ltree-legal, id-derived scope label prefix (Doc 01 §3.5)', () => {
    expect(SCOPE_PATH_LABEL_PREFIX).toBe('n_');
    expect(`${SCOPE_PATH_LABEL_PREFIX}9f2c4a1b`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('separates the two administrative permission namespaces (Doc 02 §1)', () => {
    expect(PLATFORM_PERMISSION_NAMESPACE).toBe('iam.platform');
    expect(CLIENT_PERMISSION_NAMESPACE).toBe('iam.client');
    expect(PLATFORM_PERMISSION_NAMESPACE).not.toBe(CLIENT_PERMISSION_NAMESPACE);
  });
});
