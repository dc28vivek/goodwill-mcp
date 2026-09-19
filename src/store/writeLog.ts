/**
 * Write log: the duplicate guard for `add_expense`. See ADR-0002 and PRD.
 *
 * Every write is keyed by a content fingerprint (group, amount, day, payer,
 * words) and optionally by a caller-supplied idempotency key. A repeat within
 * the window is refused and the original result is returned.
 *
 * Two implementations: in-memory for stdio and tests, KV for Cloudflare.
 */

export interface WriteRecord {
  fingerprint: string;
  idempotencyKey?: string;
  expenseId: number;
  createdAt: string;
  description: string;
}

export interface WriteLog {
  /** Find a completed write with this fingerprint or idempotency key inside the window. */
  find(userId: string, fingerprint: string, idempotencyKey?: string): Promise<WriteRecord | undefined>;
  /** Record a completed write. */
  record(userId: string, rec: WriteRecord): Promise<void>;
}

export const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;

export class MemoryWriteLog implements WriteLog {
  private readonly rows = new Map<string, WriteRecord>();
  constructor(private readonly windowMs = DEFAULT_WINDOW_MS, private readonly now: () => number = () => Date.now()) {}

  private fresh(rec: WriteRecord): boolean {
    return this.now() - new Date(rec.createdAt).getTime() <= this.windowMs;
  }

  async find(userId: string, fingerprint: string, idempotencyKey?: string): Promise<WriteRecord | undefined> {
    if (idempotencyKey) {
      const byKey = this.rows.get(`${userId}|key|${idempotencyKey}`);
      if (byKey && this.fresh(byKey)) return byKey;
    }
    const byFp = this.rows.get(`${userId}|fp|${fingerprint}`);
    return byFp && this.fresh(byFp) ? byFp : undefined;
  }

  async record(userId: string, rec: WriteRecord): Promise<void> {
    this.rows.set(`${userId}|fp|${rec.fingerprint}`, rec);
    if (rec.idempotencyKey) this.rows.set(`${userId}|key|${rec.idempotencyKey}`, rec);
  }
}

/** Minimal KV shape so this file does not import Cloudflare types. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export class KvWriteLog implements WriteLog {
  constructor(private readonly kv: KvLike, private readonly windowMs = DEFAULT_WINDOW_MS) {}

  async find(userId: string, fingerprint: string, idempotencyKey?: string): Promise<WriteRecord | undefined> {
    if (idempotencyKey) {
      const raw = await this.kv.get(`wl|${userId}|key|${idempotencyKey}`);
      if (raw) return JSON.parse(raw) as WriteRecord;
    }
    const raw = await this.kv.get(`wl|${userId}|fp|${fingerprint}`);
    return raw ? (JSON.parse(raw) as WriteRecord) : undefined;
  }

  async record(userId: string, rec: WriteRecord): Promise<void> {
    const ttl = { expirationTtl: Math.max(60, Math.floor(this.windowMs / 1000)) };
    const value = JSON.stringify(rec);
    await this.kv.put(`wl|${userId}|fp|${rec.fingerprint}`, value, ttl);
    if (rec.idempotencyKey) await this.kv.put(`wl|${userId}|key|${rec.idempotencyKey}`, value, ttl);
  }
}
