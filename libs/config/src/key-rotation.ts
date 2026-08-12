/**
 * The mandatory key-rotation ordering, as executable rules (Doc 03 §1).
 *
 * Doc 03 §1 states rotation as four steps, and the ordering is the whole point:
 * every wrong order silently breaks tokens that are already in flight.
 *
 * ```
 * 1. generate the new keypair and publish its PUBLIC key in JWKS first
 * 2. wait for JWKS propagation (at least one cache TTL)
 * 3. only then switch signing to the new private key
 * 4. retain the old public key for at least one access-token lifetime
 *    after the last token signed with it, then remove
 * ```
 *
 * Doing (3) before (2) issues tokens whose `kid` no consumer has yet fetched;
 * doing (4) early invalidates tokens that are still perfectly valid. Neither
 * fails loudly — both produce sporadic 401s across a fleet, at a moment when
 * someone has just changed the keys and is inclined to blame something else.
 *
 * So the ordering is not documentation here. {@link planRotation} refuses a
 * step whose predecessor has not happened, and refuses a step whose waiting
 * period has not elapsed, and returns the next environment as data.
 *
 * ## Why this lives in `libs/config`
 *
 * The rotation is entirely a transformation of four environment variables that
 * this library already defines and validates — `JWT_SIGNING_KEY_ID`,
 * `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_RETIRED_PUBLIC_KEYS`. Putting the
 * rules beside the schema that gives those variables meaning keeps them from
 * drifting, and lets `tools/rotate-keys.ts` stay a thin CLI over tested pure
 * functions rather than the place the logic actually lives.
 *
 * Note that `JWT_RETIRED_PUBLIC_KEYS` carries keys at *both* ends of their
 * life: a key published ahead of activation (step 1) and a key retained after
 * retirement (step 4) sit in the same map. The variable is really "public keys
 * published alongside the signer" — the name is kept for compatibility, and
 * this is the file that explains it.
 */

import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_SKEW_LEEWAY_SECONDS,
  JWKS_CACHE_MAX_AGE_SECONDS,
} from '@plantops/contracts';

/** The four variables a rotation moves. Everything else in the env is untouched. */
export interface KeyEnvState {
  /** `kid` of the key currently signing. */
  signingKeyId: string;
  /** PEM private key of the current signer. */
  privateKey: string;
  /** PEM public key of the current signer. */
  publicKey: string;
  /** `kid → PEM` of every other public key published in JWKS. */
  retiredPublicKeys: Readonly<Record<string, string>>;
}

/** A freshly generated keypair, before it has any role. */
export interface GeneratedKeyPair {
  kid: string;
  privateKey: string;
  publicKey: string;
}

export const RotationStep = {
  /** Step 1 — publish the new public key alongside the current signer. */
  PUBLISH: 'publish',
  /** Step 3 — switch signing to the already-published key. */
  ACTIVATE: 'activate',
  /** Step 4 — drop a retained public key from JWKS. */
  RETIRE: 'retire',
} as const;
export type RotationStep = (typeof RotationStep)[keyof typeof RotationStep];

/**
 * How long to wait after publishing before activating (Doc 03 §1 step 2).
 *
 * One full JWKS cache lifetime, plus the clock-skew leeway: a consumer that
 * fetched the key set one millisecond before the new key was published holds a
 * stale copy for the whole `max-age`, and its clock may disagree with ours
 * about when that window ends.
 */
export const PROPAGATION_WAIT_SECONDS =
  JWKS_CACHE_MAX_AGE_SECONDS + CLOCK_SKEW_LEEWAY_SECONDS;

/**
 * How long a retired public key must stay published after it last signed
 * (Doc 03 §1 step 4).
 *
 * One full access-token lifetime — the longest a token signed just before the
 * switch can still be live — plus the leeway a verifier is required to allow on
 * `exp` (Doc 03 §6). Without the leeway term the key would be withdrawn while
 * verifiers are still, correctly, accepting the last tokens it signed.
 */
export const RETENTION_WAIT_SECONDS =
  ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_LEEWAY_SECONDS;

/** Refusal to perform a step out of order. Message names the fix. */
export class RotationOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RotationOrderError';
  }
}

/** The outcome of a step: the next env, and when the following step is safe. */
export interface RotationPlan {
  step: RotationStep;
  /** The four variables, after the step. */
  next: KeyEnvState;
  /** Human-readable summary of what changed. */
  summary: string;
  /** Earliest time the next step may run, or `null` when this was the last. */
  nextStepEarliestAt: Date | null;
  /** What that next step is, or `null`. */
  nextStep: RotationStep | null;
}

export interface PublishInput {
  current: KeyEnvState;
  incoming: GeneratedKeyPair;
  now?: Date;
}

export interface ActivateInput {
  current: KeyEnvState;
  /** `kid` published by an earlier {@link planPublish}. */
  kid: string;
  /** Its private key — held out of band since publish; JWKS never carried it. */
  privateKey: string;
  /** When {@link planPublish} was applied, to enforce the propagation wait. */
  publishedAt: Date;
  now?: Date;
  /**
   * Skips the propagation wait. For a rotation forced by a *compromised* key,
   * where issuing unverifiable tokens for a few minutes beats signing with a
   * key an attacker holds. Never for a routine rotation.
   */
  force?: boolean;
}

export interface RetireInput {
  current: KeyEnvState;
  /** `kid` to remove from JWKS. */
  kid: string;
  /** When that key stopped signing — i.e. when the *next* key was activated. */
  deactivatedAt: Date;
  now?: Date;
  force?: boolean;
}

/**
 * Step 1 — publish the incoming public key alongside the current signer.
 *
 * The private half is not returned into the environment: it must not be
 * deployed until step 3, because a key present in `JWT_PRIVATE_KEY` is a key
 * that signs.
 */
export function planPublish({
  current,
  incoming,
  now = new Date(),
}: PublishInput): RotationPlan {
  if (incoming.kid === current.signingKeyId) {
    throw new RotationOrderError(
      `"${incoming.kid}" is already the signing key id. A rotation needs a new ` +
        'kid — reusing one makes the old and new keys indistinguishable to ' +
        'every verifier, which is exactly what kid exists to prevent.',
    );
  }
  if (incoming.kid in current.retiredPublicKeys) {
    throw new RotationOrderError(
      `"${incoming.kid}" is already published. Either the publish step has ` +
        'already run (continue with `activate`), or the kid collides with a ' +
        'retained key and must be regenerated.',
    );
  }

  return {
    step: RotationStep.PUBLISH,
    next: {
      ...current,
      retiredPublicKeys: {
        ...current.retiredPublicKeys,
        [incoming.kid]: incoming.publicKey,
      },
    },
    summary:
      `Published "${incoming.kid}" in JWKS alongside the signer ` +
      `"${current.signingKeyId}". Signing is unchanged.`,
    nextStep: RotationStep.ACTIVATE,
    nextStepEarliestAt: addSeconds(now, PROPAGATION_WAIT_SECONDS),
  };
}

/**
 * Step 3 — switch signing to a key that is already in JWKS.
 *
 * The outgoing public key moves into the retained map in the same step, rather
 * than being dropped and re-added later. Making it one atomic change is what
 * removes the window in which the previous key has stopped signing but is no
 * longer published either — the window in which every still-valid token issued
 * a second ago fails to verify.
 */
export function planActivate({
  current,
  kid,
  privateKey,
  publishedAt,
  now = new Date(),
  force = false,
}: ActivateInput): RotationPlan {
  const publicKey = current.retiredPublicKeys[kid];
  if (publicKey === undefined) {
    throw new RotationOrderError(
      `"${kid}" is not published in JWKS. Doc 03 §1 requires the public key to ` +
        'be published and propagated before it signs anything; run the ' +
        '`publish` step first.',
    );
  }

  const earliest = addSeconds(publishedAt, PROPAGATION_WAIT_SECONDS);
  if (!force && now < earliest) {
    throw new RotationOrderError(
      `JWKS propagation is not complete: "${kid}" was published at ` +
        `${publishedAt.toISOString()} and may sign from ${earliest.toISOString()}. ` +
        'Activating now would issue tokens whose kid consumers have not fetched ' +
        'yet, and they would 401 until their JWKS cache expired. Wait, or pass ' +
        '--force if this rotation is a response to key compromise.',
    );
  }

  // Everything except the incoming key stays published; the outgoing signer
  // joins it.
  const retained = { ...current.retiredPublicKeys };
  delete retained[kid];
  retained[current.signingKeyId] = current.publicKey;

  return {
    step: RotationStep.ACTIVATE,
    next: {
      signingKeyId: kid,
      privateKey,
      publicKey,
      retiredPublicKeys: retained,
    },
    summary:
      `Signing switched to "${kid}". "${current.signingKeyId}" is retained in ` +
      'JWKS so tokens it signed keep verifying until they expire.',
    nextStep: RotationStep.RETIRE,
    nextStepEarliestAt: addSeconds(now, RETENTION_WAIT_SECONDS),
  };
}

/**
 * Step 4 — remove a retained public key once nothing it signed can still be
 * live.
 */
export function planRetire({
  current,
  kid,
  deactivatedAt,
  now = new Date(),
  force = false,
}: RetireInput): RotationPlan {
  if (kid === current.signingKeyId) {
    throw new RotationOrderError(
      `"${kid}" is the current signing key. Retiring it would leave the IAM ` +
        'signing with a key absent from its own JWKS — every token issued after ' +
        'that point would be unverifiable. Activate a successor first.',
    );
  }
  if (!(kid in current.retiredPublicKeys)) {
    throw new RotationOrderError(
      `"${kid}" is not in JWT_RETIRED_PUBLIC_KEYS; there is nothing to retire.`,
    );
  }

  const earliest = addSeconds(deactivatedAt, RETENTION_WAIT_SECONDS);
  if (!force && now < earliest) {
    throw new RotationOrderError(
      `"${kid}" stopped signing at ${deactivatedAt.toISOString()} and must stay ` +
        `published until ${earliest.toISOString()} — one access-token lifetime ` +
        'plus the clock-skew leeway. Removing it now would reject tokens that ' +
        'are still valid.',
    );
  }

  const retained = { ...current.retiredPublicKeys };
  delete retained[kid];

  return {
    step: RotationStep.RETIRE,
    next: { ...current, retiredPublicKeys: retained },
    summary: `Removed "${kid}" from JWKS. Rotation complete.`,
    nextStep: null,
    nextStepEarliestAt: null,
  };
}

/** Serialises the retained map the way `JWT_RETIRED_PUBLIC_KEYS` is parsed. */
export function serializeRetiredPublicKeys(
  keys: Readonly<Record<string, string>>,
): string {
  // Escaped newlines: the value is a single-line environment variable, and the
  // schema unescapes `\n` on the way back in.
  const escaped = Object.fromEntries(
    Object.entries(keys).map(([kid, pem]) => [kid, pem.replace(/\r?\n/g, '\\n')]),
  );
  return JSON.stringify(escaped);
}

function addSeconds(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * 1000);
}
