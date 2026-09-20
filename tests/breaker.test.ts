import { describe, expect, it } from 'vitest';
import { CircuitBreaker, UpstreamDown } from '../src/splitwise/breaker.js';

function fixed() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('CircuitBreaker', () => {
  it('stays closed below the threshold', () => {
    const clock = fixed();
    const b = new CircuitBreaker({ threshold: 3, now: clock.now });
    b.recordFailure();
    b.recordFailure();
    expect(b.state).toBe('closed');
    expect(() => b.assertClosed()).not.toThrow();
  });

  it('opens on the threshold and refuses instantly', () => {
    const clock = fixed();
    const b = new CircuitBreaker({ threshold: 3, cooldownMs: 30_000, now: clock.now });
    for (let i = 0; i < 3; i += 1) b.recordFailure();
    expect(b.state).toBe('open');
    expect(() => b.assertClosed()).toThrow(UpstreamDown);
  });

  it('tells the caller how long to wait', () => {
    const clock = fixed();
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 30_000, now: clock.now });
    b.recordFailure();
    clock.advance(10_000);
    try {
      b.assertClosed();
      throw new Error('should have refused');
    } catch (err) {
      expect((err as UpstreamDown).retryAfterMs).toBe(20_000);
    }
  });

  it('lets one request through after the cooldown', () => {
    const clock = fixed();
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 30_000, now: clock.now });
    b.recordFailure();
    clock.advance(30_000);
    expect(b.state).toBe('half_open');
    expect(() => b.assertClosed()).not.toThrow();
  });

  it('closes again when the trial request succeeds', () => {
    const clock = fixed();
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 30_000, now: clock.now });
    b.recordFailure();
    clock.advance(30_000);
    b.recordSuccess();
    expect(b.state).toBe('closed');
  });

  it('waits longer each time the trial request fails, up to a cap', () => {
    const clock = fixed();
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, maxCooldownMs: 4000, now: clock.now });
    b.recordFailure();
    for (const expected of [2000, 4000, 4000]) {
      clock.advance(10_000);
      expect(b.state).toBe('half_open');
      b.recordFailure();
      clock.advance(expected - 1);
      expect(b.state).toBe('open');
      clock.advance(1);
      expect(b.state).toBe('half_open');
    }
  });
});
