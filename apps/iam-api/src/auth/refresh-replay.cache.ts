/**
 * Which successor a raced refresh converges on (Doc 03 §4).
 *
 * ## Why anything is cached at all
 *
 * Doc 03 §4 requires that a token presented inside the grace window "returns the
 * already-rotated successor (idempotent replay)". The database can decide
 * *whether* a replay is legitimate — that is what `previous_refresh_token_hash`
 * and `rotated_at` are for — but it cannot say *what to return*, because refresh
 * tokens are stored hashed and a hash cannot be handed to a client.
 *
 * Issuing a *different* new token instead is the tempting shortcut, and it does
 * not work. Two tabs would end up holding two different tokens, only the later
 * of which is current; the tab holding the other one is then one generation
 * behind and loses its session at its *next* refresh, fifteen minutes later and
 * nowhere near the code that caused it. Idempotence is the whole point: both
 * clients must converge on one token.
 *
 * ## Election, not publication
 *
 * The obvious arrangement — rotate, then publish what you rotated to — has a
 * race the caller cannot win: a client blocked on the row lock reads this cache
 * the instant it can see the rotation, and both sides are one round-trip from
 * the same commit. So the order is inverted. Every refresh proposes a freshly
 * minted secret *before* touching the database, `SET … NX` keeps the first
 * proposal and rejects the rest, and every racing request then hands the
 * **elected** secret to `iam.auth_rotate_refresh_token`.
 *
 * That makes the two arbiters agree by construction. The cache elects *which*
 * secret; the row lock elects *who installs it*; and because every contender
 * proposes the same one, it no longer matters that those can be different
 * requests. Whoever rotates installs the elected secret, and whoever is told
 * `replay` returns the same value it already holds.
 *
 * ## Nothing here is trusted
 *
 * An election can still be wrong — the entry may be a leftover, or the real
 * rotation may have happened during an outage this cache never saw. So the
 * elected secret is not treated as an answer but as a *proposal*, and
 * `iam.auth_rotate_refresh_token` is what confirms it: on the replay branch it
 * compares the proposal against the hash actually installed and answers `stale`
 * when they differ. This class therefore needs no notion of confidence, and no
 * failure of it can produce a token that a session does not recognise.
 *
 * ## What is kept, and for how long
 *
 * The refresh secret only — not the access token that accompanied it. A replay
 * mints a fresh access token instead, which costs one signature and is honest
 * about its own `expires_in`. That halves what is in Redis, and it is the
 * refresh token that has to be byte-identical anyway.
 *
 * The entry outlives the grace window by {@link REPLAY_SLACK_SECONDS} so the
 * *database* always decides where the window ends. With equal lifetimes a
 * request arriving on the boundary could be authorised by the row and then find
 * nothing here, turning a legitimate race into a refusal for no reason a reader
 * of either component could explain.
 *
 * ## Not in `@plantops/contracts`, unlike the revoked-`sid` key
 *
 * That prefix is shared because every module *reads* it. Nothing outside the IAM
 * participates in refresh — Doc 06 §11 has modules verify tokens locally and
 * send their users here to rotate — so this key is the IAM's own business and
 * publishing it would invite a second writer.
 */

/**
 * The two commands this needs; `ioredis`'s `Redis` satisfies it as-is.
 *
 * Structural rather than an `ioredis` import, for the reason `auth-kit`'s
 * `RevocationStore` is: nothing in this design should force a client library on
 * anything that later needs to host it.
 */
export interface ReplayStore {
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
    exists: 'NX',
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

const REPLAY_KEY_PREFIX = 'refresh-replay:';

/** See above: the row, not the cache, decides where grace ends. */
export const REPLAY_SLACK_SECONDS = 5;

export class RefreshReplayCache {
  constructor(
    private readonly store: ReplayStore,
    private readonly graceSeconds: number,
  ) {}

  /**
   * Elects the successor for the token whose hash is `presentedHash`, proposing
   * `candidate` if nothing has been elected yet.
   *
   * `NX` is the whole mechanism, not an optimisation: write-once per key is what
   * makes the first request to arrive the authority, and every later one a
   * follower rather than a competitor.
   *
   * @throws when the store cannot answer. The caller falls back to its own
   * candidate, which is correct for a rotation and refused for a replay.
   */
  async elect(presentedHash: string, candidate: string): Promise<string> {
    const stored = await this.store.set(
      key(presentedHash),
      candidate,
      'EX',
      this.graceSeconds + REPLAY_SLACK_SECONDS,
      'NX',
    );
    // Redis answers `OK` when it wrote and nil when the key was already there.
    if (stored !== null) return candidate;

    // Nil on the read means the entry expired between the two commands — the
    // window is over, so this request's own candidate stands.
    return (await this.store.get(key(presentedHash))) ?? candidate;
  }
}

function key(presentedHash: string): string {
  return `${REPLAY_KEY_PREFIX}${presentedHash}`;
}
