/**
 * The signing key and the published key set (Doc 03 §1).
 *
 * One key signs; several keys verify. That asymmetry is the whole of rotation:
 * a new public key is published *before* it signs anything, and an old public
 * key stays published *after* it has stopped signing, so no token is ever
 * in flight without its verification key being available. The environment
 * models it as three variables — `JWT_SIGNING_KEY_ID` + `JWT_PRIVATE_KEY` +
 * `JWT_PUBLIC_KEY` name the current signer, and `JWT_RETIRED_PUBLIC_KEYS` is
 * a `kid → PEM` map of everything else that must still verify.
 *
 * ## Why the keys are parsed lazily
 *
 * Parsing in the constructor (or `onModuleInit`) would make every test that
 * boots the module supply a genuine RSA keypair, including the many that have
 * nothing to do with tokens. Instead the material is parsed on first use and
 * memoised, and {@link KeysService.assertKeysUsable} exists to force it — which
 * `main.ts` calls at boot, alongside the RLS check, so a real deployment still
 * dies immediately on a bad key rather than at its first login.
 *
 * ## What never leaves this service
 *
 * The private key. {@link KeysService.jwks} builds its response from *public*
 * `KeyObject`s only, and `KeyObject.export({ format: 'jwk' })` on a public key
 * emits `{ kty, n, e }` — there is no code path here that could reach a private
 * exponent, rather than a rule saying it must not (Doc 03 §1, Doc 10 §8).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { EnvConfig } from '@plantops/config';
import {
  JWKS_CACHE_MAX_AGE_SECONDS,
  JWT_MIN_RSA_KEY_BITS,
  JWT_SIGNING_ALGORITHM,
  type JwkDTO,
  type JwksResponse,
} from '@plantops/contracts';
import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { ENV } from '../config/config.module';
import {
  privateKeyFromPem,
  publicKeyFromPem,
  signCompactJws,
  parseCompactJws,
  verifyCompactJws,
} from './jws';

export { JWKS_CACHE_MAX_AGE_SECONDS };

/**
 * A misconfigured key set. Boot-fatal, and phrased for the operator: every
 * message names the environment variable at fault and never quotes its value.
 */
export class KeyConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid JWT key configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'KeyConfigurationError';
    this.issues = issues;
  }
}

/** The key currently signing tokens. */
export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

@Injectable()
export class KeysService {
  private signing?: SigningKey;
  private verification?: ReadonlyMap<string, KeyObject>;
  private published?: JwksResponse;

  constructor(@Inject(ENV) private readonly env: EnvConfig) {}

  /** How long a consumer may cache the JWKS — the rotation wait (Doc 03 §1). */
  get jwksMaxAgeSeconds(): number {
    return JWKS_CACHE_MAX_AGE_SECONDS;
  }

  /** The key to sign with, parsed once. */
  signingKey(): SigningKey {
    this.signing ??= {
      kid: this.env.JWT_SIGNING_KEY_ID,
      privateKey: privateKeyFromPem(this.env.JWT_PRIVATE_KEY, 'JWT_PRIVATE_KEY'),
      publicKey: publicKeyFromPem(this.env.JWT_PUBLIC_KEY, 'JWT_PUBLIC_KEY'),
    };
    return this.signing;
  }

  /**
   * The public key for a `kid`, or `undefined` if it is not published.
   *
   * `undefined` is the **unknown-`kid` path** (Doc 03 §1): a remote consumer
   * refetches the JWKS once — the key may have been published seconds ago by a
   * rotation in progress — and only then rejects. Inside the IAM there is
   * nothing to refetch, since this map *is* the source, so the caller rejects
   * straight away. Either way the token is never accepted by trying other keys:
   * verifying against every published key in turn would turn key retention into
   * a signature oracle.
   */
  verificationKey(kid: string): KeyObject | undefined {
    return this.verificationKeys().get(kid);
  }

  /** Every key that may verify a token right now: the signer plus retained. */
  verificationKeys(): ReadonlyMap<string, KeyObject> {
    if (this.verification === undefined) {
      const keys = new Map<string, KeyObject>();
      // Retained first, so a `kid` collision resolves in favour of the live
      // signer rather than a stale entry someone forgot to remove.
      for (const [kid, pem] of Object.entries(this.env.JWT_RETIRED_PUBLIC_KEYS)) {
        keys.set(kid, publicKeyFromPem(pem, `JWT_RETIRED_PUBLIC_KEYS["${kid}"]`));
      }
      const signing = this.signingKey();
      keys.set(signing.kid, signing.publicKey);
      this.verification = keys;
    }
    return this.verification;
  }

  /**
   * The JWKS body (Doc 03 §1).
   *
   * The signing key comes first. Order carries no meaning to a correct verifier
   * — selection is by `kid` — but it is the conventional hint, and it makes the
   * response readable when an operator is checking a rotation by eye.
   */
  jwks(): JwksResponse {
    if (this.published === undefined) {
      const signingKid = this.signingKey().kid;
      const entries = [...this.verificationKeys().entries()].sort(
        ([a], [b]) => Number(b === signingKid) - Number(a === signingKid),
      );
      this.published = {
        keys: entries.map(([kid, key]) => toJwk(kid, key)),
      };
    }
    return this.published;
  }

  /**
   * Forces every key to be parsed and checked. Call once, at boot.
   *
   * Collects all problems before throwing: fixing a key set one restart at a
   * time is miserable, and the checks are independent.
   *
   * @throws {KeyConfigurationError}
   */
  assertKeysUsable(): void {
    const issues: string[] = [];

    let signing: SigningKey | undefined;
    try {
      signing = this.signingKey();
    } catch (error) {
      issues.push(messageOf(error));
    }

    if (signing !== undefined) {
      issues.push(...checkKeySize(signing.publicKey, 'JWT_PUBLIC_KEY'));
      issues.push(...checkKeySize(signing.privateKey, 'JWT_PRIVATE_KEY'));
      issues.push(...checkKeyPairMatches(signing));
    }

    for (const [kid, pem] of Object.entries(this.env.JWT_RETIRED_PUBLIC_KEYS)) {
      const label = `JWT_RETIRED_PUBLIC_KEYS["${kid}"]`;
      try {
        issues.push(...checkKeySize(publicKeyFromPem(pem, label), label));
      } catch (error) {
        issues.push(messageOf(error));
      }
    }

    if (issues.length > 0) throw new KeyConfigurationError(issues);
  }
}

/** A public `KeyObject` as a JWKS entry. */
function toJwk(kid: string, key: KeyObject): JwkDTO {
  // `export` on a *public* KeyObject yields only the public parameters, so
  // there is no private field to strip and no chance of forgetting to.
  const jwk = key.export({ format: 'jwk' }) as Record<string, string>;
  return {
    ...jwk,
    kty: jwk['kty'] ?? 'RSA',
    kid,
    use: 'sig',
    alg: JWT_SIGNING_ALGORITHM,
  } as JwkDTO;
}

function checkKeySize(key: KeyObject, label: string): string[] {
  if (key.asymmetricKeyType !== 'rsa') {
    return [
      `${label} is a ${key.asymmetricKeyType ?? 'non-asymmetric'} key; ` +
        `${JWT_SIGNING_ALGORITHM} requires RSA`,
    ];
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  return bits < JWT_MIN_RSA_KEY_BITS
    ? [`${label} is a ${bits}-bit RSA key; the minimum is ${JWT_MIN_RSA_KEY_BITS}`]
    : [];
}

/**
 * Proves `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` are two halves of one keypair,
 * by signing a throwaway document and verifying it.
 *
 * This is the check that catches the realistic rotation mistake: updating one
 * of the two variables and not the other. Nothing fails at boot without it —
 * signing works, the JWKS serves a perfectly valid key — and every token the
 * instance issues is unverifiable by every consumer, including itself.
 */
function checkKeyPairMatches(signing: SigningKey): string[] {
  try {
    const probe = signCompactJws({ probe: randomUUID() }, signing.privateKey, signing.kid);
    if (verifyCompactJws(parseCompactJws(probe), signing.publicKey)) return [];
  } catch (error) {
    return [`JWT_PRIVATE_KEY could not sign a test token: ${messageOf(error)}`];
  }
  return [
    'JWT_PUBLIC_KEY does not match JWT_PRIVATE_KEY — tokens signed by this ' +
      'instance would fail verification everywhere, including here',
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
