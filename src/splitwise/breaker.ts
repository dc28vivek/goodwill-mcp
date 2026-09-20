/**
 * Circuit breaker for the one upstream host.
 *
 * Without it, a Splitwise outage makes every client burn three retries with
 * backoff (0.5s + 1s + 2s) before failing, so a thousand users become a
 * thundering herd against a service that is trying to come back. The breaker
 * turns the second and later failures into an instant, honest refusal.
 *
 * State is per isolate rather than shared. That is deliberate: coordinating it
 * would put a storage round trip in front of every upstream call to save a
 * fraction of the calls it is meant to prevent. Each isolate learns
 * independently within a few requests, which is fast enough, and the failure
 * mode of getting it wrong is one extra upstream call rather than a wrong
 * answer. See ADR-0017.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export class UpstreamDown extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Splitwise is not responding. The connector stopped retrying so it does not make things worse.');
    this.name = 'UpstreamDown';
  }
}

export interface BreakerOptions {
  /** Consecutive failures before the circuit opens. Default 5. */
  threshold?: number;
  /** How long it stays open before one trial request. Default 30s. */
  cooldownMs?: number;
  /** Cap on the doubling cooldown. Default 5 minutes. */
  maxCooldownMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private cooldown: number;
  private consecutiveOpens = 0;
  private readonly threshold: number;
  private readonly baseCooldown: number;
  private readonly maxCooldown: number;
  private readonly now: () => number;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.threshold ?? 5;
    this.baseCooldown = opts.cooldownMs ?? 30_000;
    this.maxCooldown = opts.maxCooldownMs ?? 300_000;
    this.cooldown = this.baseCooldown;
    this.now = opts.now ?? (() => Date.now());
  }

  get state(): BreakerState {
    if (this.openedAt === 0) return 'closed';
    return this.now() - this.openedAt >= this.cooldown ? 'half_open' : 'open';
  }

  /** Throws UpstreamDown when the circuit is open. */
  assertClosed(): void {
    if (this.state === 'open') {
      throw new UpstreamDown(this.cooldown - (this.now() - this.openedAt));
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.consecutiveOpens = 0;
    this.cooldown = this.baseCooldown;
  }

  recordFailure(): void {
    // A failure during the trial request reopens immediately and waits longer.
    if (this.state === 'half_open') {
      this.consecutiveOpens += 1;
      this.cooldown = Math.min(this.maxCooldown, this.baseCooldown * 2 ** this.consecutiveOpens);
      this.openedAt = this.now();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = this.now();
      this.consecutiveOpens = 0;
      this.cooldown = this.baseCooldown;
    }
  }
}

/** Shared by every request in this isolate. Tests build their own. */
export const sharedBreaker = new CircuitBreaker();
