/**
 * One Durable Object per Splitwise user. It holds the two pieces of state that
 * have to be right rather than fast: the write-log reservation and the upstream
 * budget.
 *
 * Why not KV. KV offers no read-after-write guarantee, so the previous
 * KV-backed write log could read an empty slot for a fingerprint another colo
 * had just claimed, and post a duplicate. A Durable Object is a single
 * addressable instance with strongly consistent storage and an input gate: while
 * a storage operation is outstanding no other event is delivered to the object,
 * so the read-then-write inside `claim` cannot interleave with itself. That is
 * exactly the property the guard needs and the one KV cannot give.
 *
 * Addressing by Splitwise user id means one object per person, so the
 * serialisation point is per user and never global. See ADR-0016.
 */
import { DurableObject } from 'cloudflare:workers';
import { type BucketOptions, type Budget, type BudgetVerdict, type BucketState, step } from '../store/budget.js';
import { type Claim, type Entry, type LogStore, StoreWriteLog, type WriteLog, type WriteRecord } from '../store/writeLog.js';

const BUCKET_KEY = 'budget';
const SWEEP_MS = 60 * 60 * 1000;

/** Adapts Durable Object storage to the store the write log is written against. */
class DoLogStore implements LogStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async get(key: string): Promise<Entry | undefined> {
    return await this.storage.get<Entry>(key);
  }

  async put(key: string, entry: Entry): Promise<void> {
    await this.storage.put(key, entry);
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }
}

export class UserState extends DurableObject {
  private readonly log: StoreWriteLog;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.log = new StoreWriteLog(new DoLogStore(ctx.storage));
  }

  private async scheduleSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async find(userId: string, fingerprint: string, idempotencyKey?: string): Promise<WriteRecord | undefined> {
    return await this.log.find(userId, fingerprint, idempotencyKey);
  }

  async claim(userId: string, fingerprint: string, idempotencyKey?: string): Promise<Claim> {
    const claim = await this.log.claim(userId, fingerprint, idempotencyKey);
    if (claim.status === 'claimed') await this.scheduleSweep();
    return claim;
  }

  async record(userId: string, token: string, rec: WriteRecord): Promise<void> {
    await this.log.record(userId, token, rec);
    await this.scheduleSweep();
  }

  async release(userId: string, token: string, fingerprint: string, idempotencyKey?: string): Promise<void> {
    await this.log.release(userId, token, fingerprint, idempotencyKey);
  }

  async take(cost: number, opts?: BucketOptions): Promise<BudgetVerdict> {
    const prior = await this.ctx.storage.get<BucketState>(BUCKET_KEY);
    const next = step(prior, cost, Date.now(), opts ?? {});
    await this.ctx.storage.put(BUCKET_KEY, next.state);
    return next.verdict;
  }

  /**
   * Entries carry their own expiry because Durable Object storage has no TTL.
   * Reads already drop what has expired; this stops an abandoned key from
   * sitting there forever and growing the object without bound.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const all = await this.ctx.storage.list<Entry>({ prefix: 'wl|' });
    const dead: string[] = [];
    for (const [key, entry] of all) {
      if (entry.expiresAt <= now) dead.push(key);
    }
    if (dead.length) await this.ctx.storage.delete(dead);
    if (all.size > dead.length) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }
}

type UserStateStub = DurableObjectStub<UserState>;

/** The WriteLog the hosted server uses. Every call is one RPC to the user's object. */
export class DurableWriteLog implements WriteLog {
  constructor(private readonly stub: UserStateStub) {}

  async find(userId: string, fingerprint: string, idempotencyKey?: string): Promise<WriteRecord | undefined> {
    return await this.stub.find(userId, fingerprint, idempotencyKey);
  }

  async claim(userId: string, fingerprint: string, idempotencyKey?: string): Promise<Claim> {
    return await this.stub.claim(userId, fingerprint, idempotencyKey);
  }

  async record(userId: string, token: string, rec: WriteRecord): Promise<void> {
    await this.stub.record(userId, token, rec);
  }

  async release(userId: string, token: string, fingerprint: string, idempotencyKey?: string): Promise<void> {
    await this.stub.release(userId, token, fingerprint, idempotencyKey);
  }
}

export class DurableBudget implements Budget {
  constructor(private readonly stub: UserStateStub) {}

  async take(cost: number): Promise<BudgetVerdict> {
    return await this.stub.take(cost);
  }
}

export function userStateStub(ns: DurableObjectNamespace<UserState>, userId: number): UserStateStub {
  return ns.get(ns.idFromName(`user:${userId}`));
}
