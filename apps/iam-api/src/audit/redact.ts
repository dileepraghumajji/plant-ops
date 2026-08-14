/**
 * The redaction boundary (Doc 10 §8).
 *
 * ## What this is defending against
 *
 * Doc 10 §8 says passwords, hashes, refresh tokens, service-account secrets and
 * signing keys must never be logged, and that they should be redacted "at the
 * `AuditService` boundary so they cannot reach `payload`". The distinction
 * matters: a rule that every caller must remember is a rule that holds until
 * somebody writes `{ ...input }` into an audit payload — and an audit trail is
 * append-only by design, so a secret that lands in one is not deletable. It is
 * in the backups too (Doc 10 §5), which are "records of record".
 *
 * So the boundary is mechanical. Everything that goes through
 * {@link AuditService.record} goes through {@link redactPayload} first, and
 * there is no parameter that skips it.
 *
 * ## Two independent filters, because either one alone has a hole
 *
 * **By key** — a denylist of name fragments (`password`, `secret`, `token`,
 * `hash`, …). This catches the ordinary case, where a field is named after what
 * it holds. It cannot catch `{ ...input }` spreading a well-named field into a
 * differently-named one, or a value nested inside something innocuous.
 *
 * **By shape** — the value is examined regardless of what it is called. An
 * argon2/bcrypt hash, a JWT, a refresh token in this system's own
 * `<uuid>~<secret>` form, a raw byte buffer, or any long high-entropy
 * base64url/hex blob is redacted wherever it appears. This is what catches the
 * spread, and it is why `redactPayload` recurses rather than looking only at
 * the top level.
 *
 * ## Deliberate non-targets
 *
 * Over-redaction is not free — an audit row that cannot say *which* account was
 * created is one an operator cannot act on — so two things are pointedly left
 * alone:
 *
 * - **`account_key`.** The public half of a service-account credential
 *   (`service-credentials.util.ts`), 25 characters, already audited on create
 *   and rotate. `key` is therefore not a denied fragment; `key_hash` is caught
 *   by `hash`.
 * - **UUIDs**, which are the ids every target and subject is named by, and
 *   **dotted permission keys** like `gatepass.dc.approve`, which the
 *   authorization actions must carry (Doc 10 §4). The JWT rule below is
 *   anchored on `eyJ` precisely so a three-part permission key is not mistaken
 *   for a token.
 */

/** What a redacted value is replaced with. One marker, so it is greppable. */
export const REDACTED = '[redacted]';

/** A value nested deeper than {@link MAX_DEPTH}. */
export const TRUNCATED = '[truncated]';

/** A value that refers back to one of its own ancestors. */
export const CIRCULAR = '[circular]';

/**
 * How deep the walk goes before it stops.
 *
 * Audit payloads are meant to be compact — "a compact `before`/`after` or the
 * salient fields" (Doc 10 §2) — so anything past this is a caller handing over
 * an object graph rather than a record, and walking it unbounded would let one
 * mutation stall a request.
 */
const MAX_DEPTH = 8;

/**
 * Key-name fragments that mean the value is secret material.
 *
 * Matched against the key with case and separators stripped, so `keyHash`,
 * `key_hash` and `KEY-HASH` are one rule. Fragments rather than exact names
 * because the same thing is called `refresh_token_hash` here and
 * `previousRefreshTokenHash` there.
 */
const DENIED_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'hash',
  'salt',
  'signature',
  'privatekey',
  'apikey',
  'authorization',
  'cookie',
] as const;

/** `$argon2id$v=19$…`, `$2b$…` — anything in modular-crypt form is a hash. */
const MODULAR_CRYPT = /^\$[a-z0-9]+[a-z0-9-]*\$/i;

/**
 * A JWT, anchored on the `eyJ` that every base64url-encoded `{"…` header
 * begins with. Without that anchor this pattern also matches a dotted
 * permission key, which authorization denials are required to record.
 */
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** This system's refresh token: `<session uuid>~<secret>` (`refresh-token.util.ts`). */
const REFRESH_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}~[A-Za-z0-9_-]{16,}$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A long unbroken base64url/hex run — the shape of every bearer secret in this
 * codebase (32 random bytes is 43 base64url characters) and of a SHA-256 digest
 * in either encoding.
 *
 * 32 is the threshold because it sits above everything that is legitimately
 * this shape — an `sa_`-prefixed account key is 25 characters — and below the
 * 43 that any minted secret reaches.
 */
const HIGH_ENTROPY_BLOB = /^[A-Za-z0-9_-]{32,}$/;

/** Normalised key: lower case, letters and digits only. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Does this key name secret material? */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return DENIED_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Does this value look like secret material, whatever it is called?
 *
 * Order matters only for readability; the checks are disjoint apart from the
 * UUID carve-out, which has to run before the blob rule (a uuid with its
 * hyphens is not matched by it, but the carve-out states the intent).
 */
export function looksLikeSecret(value: string): boolean {
  if (UUID.test(value)) return false;
  return (
    MODULAR_CRYPT.test(value) ||
    JWT.test(value) ||
    REFRESH_TOKEN.test(value) ||
    HIGH_ENTROPY_BLOB.test(value)
  );
}

/** What callers may hand to {@link AuditService.record}. */
export type AuditPayload = Record<string, unknown>;

/**
 * Returns a JSON-safe copy of `payload` with every secret-shaped key and value
 * replaced by {@link REDACTED}.
 *
 * Non-JSON values are normalised on the way through, because the result goes
 * into a `jsonb` column: `Date` becomes an ISO string, `bigint` a decimal
 * string, and `undefined`/functions/symbols are dropped exactly as
 * `JSON.stringify` would drop them. A `Buffer` or typed array is *redacted*
 * rather than encoded — raw bytes in an audit payload are key material far more
 * often than they are anything else.
 */
export function redactPayload(payload: AuditPayload): Record<string, unknown> {
  const result = redactValue(payload, 0, new Set());
  // `payload` is an object, so the walk always yields one — except at a depth
  // or cycle marker, which cannot happen at the root.
  return isPlainRecord(result) ? result : {};
}

function redactValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null) return null;

  if (typeof value === 'string') {
    return looksLikeSecret(value) ? REDACTED : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  // Matches JSON.stringify: these have no representation, and an audit payload
  // that silently carries a `null` where a function was is more confusing than
  // one that omits the key.
  if (typeof value !== 'object') return undefined;

  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;

  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (seen.has(value)) return CIRCULAR;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // `undefined` inside an array becomes `null`, as JSON does — dropping the
      // element instead would silently change every subsequent index.
      return value.map((item) => redactValue(item, depth + 1, seen) ?? null);
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      const redacted = redactValue(item, depth + 1, seen);
      if (redacted !== undefined) out[key] = redacted;
    }
    return out;
  } finally {
    // Removed on the way back up so that a value referenced twice in *siblings*
    // is rendered twice, rather than the second one reading as a cycle.
    seen.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
