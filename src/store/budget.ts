/**
 * Per-user upstream budget.
 *
 * Splitwise publishes no rate limit, so the way we would find it is by being
 * cut off, and the limit is more likely to be per OAuth application than per
 * token. That makes one runaway agent loop everybody else's problem: the app
 * gets throttled and every user of the connector sees it. A bucket per user
 * turns a shared, invisible failure into a private, explainable one.
 *
 * The bucket is deliberately generous. A normal question costs 7 to 15 calls,
 * so 150 tokens of burst and 90 a minute sustained is roughly ten questions
 * back to back and six a minute forever. It is sized to stop a loop, not to
 * ration a person.
 */

export interface BudgetVerdict {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface Budget {
  /** Spend `cost` tokens. A refusal says how long until the next one is free. */
  take(cost: number): Promise<BudgetVerdict>;
}

export interface BucketOptions {
  /** Maximum tokens held, which is the largest burst. Default 150. */
  capacity?: number;
  /** Tokens added per second. Default 1.5, which is 90 a minute. */
  refillPerSecond?: number;
}

export interface BucketState {
  tokens: number;
  updatedAt: number;
}

export const DEFAULT_BUCKET: Required<BucketOptions> = { capacity: 150, refillPerSecond: 1.5 };

/** Pure token bucket step, shared by every store. */
export function step(state: BucketState | undefined, cost: number, now: number, opts: BucketOptions = {}): { state: BucketState; verdict: BudgetVerdict } {
  const capacity = opts.capacity ?? DEFAULT_BUCKET.capacity;
  const refill = opts.refillPerSecond ?? DEFAULT_BUCKET.refillPerSecond;
  const prior = state ?? { tokens: capacity, updatedAt: now };
  const elapsed = Math.max(0, now - prior.updatedAt) / 1000;
  const tokens = Math.min(capacity, prior.tokens + elapsed * refill);
  if (tokens < cost) {
    return {
      state: { tokens, updatedAt: now },
      verdict: { ok: false, remaining: Math.floor(tokens), retryAfterMs: Math.ceil(((cost - tokens) / refill) * 1000) },
    };
  }
  return {
    state: { tokens: tokens - cost, updatedAt: now },
    verdict: { ok: true, remaining: Math.floor(tokens - cost), retryAfterMs: 0 },
  };
}

export class OverBudget extends Error {
  constructor(readonly retryAfterMs: number) {
    super('This connector has made too many Splitwise requests in a short time and paused itself. Wait a moment and ask again.');
    this.name = 'OverBudget';
  }
}

/** Per-process bucket for stdio, where one process serves one user. */
export class MemoryBudget implements Budget {
  private state: BucketState | undefined;
  constructor(
    private readonly opts: BucketOptions = {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  async take(cost: number): Promise<BudgetVerdict> {
    const next = step(this.state, cost, this.now(), this.opts);
    this.state = next.state;
    return next.verdict;
  }
}

export function unlimitedBudget(): Budget {
  return {
    async take() {
      return { ok: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0 };
    },
  };
}
