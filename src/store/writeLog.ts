/**
 * Write log: the duplicate guard for every write tool. See ADR-0002 and ADR-0016.
 *
 * Every write is keyed by a content fingerprint (group, amount, day, payer,
 * words) and optionally by a caller-supplied idempotency key. A repeat inside
 * the window is refused and the original result is returned instead.
 *
 * The guard is a claim, not a lookup. The first version read the log, posted to
 * Splitwise, then wrote the log, which is a read-modify-write with a live
 * window between the three steps. The thing it guards against is a retry or a
 * second device arriving in exactly that window: both read nothing and both
 * post. With one user it never fires. With a thousand it fires, and the result
 * is a real duplicate in somebody's shared ledger, which is the one outcome the
 * whole safety model exists to prevent.
 *
 * So `claim` reserves the fingerprint atomically before the upstream call and
 * `record` or `release` closes it afterwards. Both stores below are
 * single-threaded per user, which is what makes the reservation atomic: a Map
 * in one process, and one Durable Object per user on Cloudflare.
 *
 * Reservations expire quickly (60s) so a crash between claim and post cannot
 * wedge a fingerprint for the full 48 hours.
 */

export interface WriteRecord {
  fingerprint: string;
  idempotencyKey?: string;
  expenseId: number;
  createdAt: string;
  description: string;
}

export type Claim =
  /** The caller owns this fingerprint and may post. Pass the token back. */
  | { status: 'claimed'; token: string }
  /** An identical write already completed inside the window. */
  | { status: 'duplicate'; record: WriteRecord }
  /** An identical write is being posted right now by another request. */
  | { status: 'in_flight' };

export interface WriteLog {
  /** Read-only peek used before a preview. Never reserves. */
  find(userId: string, fingerprint: string, idempotencyKey?: string): Promise<WriteRecord | undefined>;
  /** Atomically reserve this fingerprint, or report why it cannot be had. */
  claim(userId: string, fingerprint: string, idempotencyKey?: string): Promise<Claim>;
  /** Turn a held reservation into a completed record. */
  record(userId: string, token: string, rec: WriteRecord): Promise<void>;
  /** Give back a held reservation because the upstream call failed. */
  release(userId: string, token: string, fingerprint: string, idempotencyKey?: string): Promise<void>;
}

export const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const RESERVATION_MS = 60_000;

export type Entry = { kind: 'done'; rec: WriteRecord; expiresAt: number } | { kind: 'pending'; token: string; expiresAt: number };

/** The storage the log needs. Must be single-threaded per user to stay atomic. */
export interface LogStore {
  get(key: string): Promise<Entry | undefined>;
  put(key: string, entry: Entry): Promise<void>;
  delete(key: string): Promise<void>;
}

const fpKey = (userId: string, fingerprint: string) => `wl|${userId}|fp|${fingerprint}`;
const idKey = (userId: string, idempotencyKey: string) => `wl|${userId}|key|${idempotencyKey}`;

/**
 * The whole guard, written once against LogStore. Both stores are atomic per
 * user, so the read-then-write inside `claim` cannot interleave with itself.
 */
export class StoreWriteLog implements WriteLog {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: LogStore,
    private readonly windowMs = DEFAULT_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Run one mutating operation at a time.
   *
   * The first version of this class assumed that a single-threaded store made
   * `claim` atomic. It does not. `claim` awaits the store between reading a
   * key and writing it, and an await yields, so two concurrent claims both read
   * an empty slot and both win. A test caught it, which is the whole reason the
   * test races two claims instead of calling them in turn.
   *
   * Cloudflare's input gate would in fact have covered the Durable Object case,
   * but a correctness property this important should not rest on a platform
   * detail that is invisible in the code and absent in every other store. The
   * queue makes the guarantee local and the same everywhere.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async live(key: string): Promise<Entry | undefined> {
    const entry = await this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      await this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private keys(userId: string, fingerprint: string, idempotencyKey?: string): string[] {
    return idempotencyKey ? [idKey(userId, idempotencyKey), fpKey(userId, fingerprint)] : [fpKey(userId, fingerprint)];
  }

  async find(userId: string, fingerprint: string, idempotencyKey?: string): Promise<WriteRecord | undefined> {
    for (const key of this.keys(userId, fingerprint, idempotencyKey)) {
      const entry = await this.live(key);
      if (entry?.kind === 'done') return entry.rec;
    }
    return undefined;
  }

  claim(userId: string, fingerprint: string, idempotencyKey?: string): Promise<Claim> {
    return this.serialize(() => this.claimLocked(userId, fingerprint, idempotencyKey));
  }

  record(userId: string, token: string, rec: WriteRecord): Promise<void> {
    return this.serialize(() => this.recordLocked(userId, token, rec));
  }

  release(userId: string, token: string, fingerprint: string, idempotencyKey?: string): Promise<void> {
    return this.serialize(() => this.releaseLocked(userId, token, fingerprint, idempotencyKey));
  }

  private async claimLocked(userId: string, fingerprint: string, idempotencyKey?: string): Promise<Claim> {
    const keys = this.keys(userId, fingerprint, idempotencyKey);
    for (const key of keys) {
      const entry = await this.live(key);
      if (entry?.kind === 'done') return { status: 'duplicate', record: entry.rec };
      if (entry?.kind === 'pending') return { status: 'in_flight' };
    }
    const token = crypto.randomUUID();
    const pending: Entry = { kind: 'pending', token, expiresAt: this.now() + RESERVATION_MS };
    for (const key of keys) await this.store.put(key, pending);
    return { status: 'claimed', token };
  }

  private async recordLocked(userId: string, token: string, rec: WriteRecord): Promise<void> {
    const done: Entry = { kind: 'done', rec, expiresAt: this.now() + this.windowMs };
    for (const key of this.keys(userId, rec.fingerprint, rec.idempotencyKey)) {
      const held = await this.store.get(key);
      // Only the holder closes its own reservation. A foreign entry here means
      // the reservation expired and somebody else took it, so leave theirs.
      if (held?.kind === 'pending' && held.token !== token) continue;
      await this.store.put(key, done);
    }
  }

  private async releaseLocked(userId: string, token: string, fingerprint: string, idempotencyKey?: string): Promise<void> {
    for (const key of this.keys(userId, fingerprint, idempotencyKey)) {
      const held = await this.store.get(key);
      if (held?.kind === 'pending' && held.token === token) await this.store.delete(key);
    }
  }
}

/** Per-process store for stdio and tests. One process serves one user. */
export class MemoryLogStore implements LogStore {
  private readonly rows = new Map<string, Entry>();

  async get(key: string): Promise<Entry | undefined> {
    return this.rows.get(key);
  }

  async put(key: string, entry: Entry): Promise<void> {
    this.rows.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }
}

export class MemoryWriteLog extends StoreWriteLog {
  constructor(windowMs = DEFAULT_WINDOW_MS, now: () => number = () => Date.now()) {
    super(new MemoryLogStore(), windowMs, now);
  }
}
