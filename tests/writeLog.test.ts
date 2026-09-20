import { describe, expect, it } from 'vitest';
import { MemoryWriteLog, RESERVATION_MS, StoreWriteLog, MemoryLogStore } from '../src/store/writeLog.js';

const rec = (t: number, over: Partial<{ fingerprint: string; idempotencyKey: string; expenseId: number; description: string }> = {}) => ({
  fingerprint: 'fp',
  expenseId: 5,
  createdAt: new Date(t).toISOString(),
  description: 'dinner',
  ...over,
});

async function claimed(log: MemoryWriteLog, user: string, fp: string, key?: string): Promise<string> {
  const c = await log.claim(user, fp, key);
  if (c.status !== 'claimed') throw new Error(`expected a claim, got ${c.status}`);
  return c.token;
}

describe('write log', () => {
  it('finds a completed write by fingerprint and by idempotency key, and forgets it after the window', async () => {
    let t = 1_000_000;
    const log = new MemoryWriteLog(1000, () => t);
    const token = await claimed(log, 'u1', 'fp', 'k1');
    await log.record('u1', token, rec(t, { idempotencyKey: 'k1' }));

    expect((await log.find('u1', 'fp'))?.expenseId).toBe(5);
    expect((await log.find('u1', 'other', 'k1'))?.expenseId).toBe(5);
    expect(await log.find('u2', 'fp')).toBeUndefined();

    t += 2000;
    expect(await log.find('u1', 'fp')).toBeUndefined();
  });

  it('refuses a second claim on a fingerprint that is already being posted', async () => {
    const log = new MemoryWriteLog();
    await claimed(log, 'u1', 'fp');
    expect((await log.claim('u1', 'fp')).status).toBe('in_flight');
  });

  it('reports a duplicate once the first write completed', async () => {
    const log = new MemoryWriteLog();
    const token = await claimed(log, 'u1', 'fp');
    await log.record('u1', token, rec(Date.now()));
    const again = await log.claim('u1', 'fp');
    expect(again.status).toBe('duplicate');
    if (again.status === 'duplicate') expect(again.record.expenseId).toBe(5);
  });

  it('a released reservation can be claimed again straight away', async () => {
    const log = new MemoryWriteLog();
    const token = await claimed(log, 'u1', 'fp', 'k1');
    await log.release('u1', token, 'fp', 'k1');
    expect((await log.claim('u1', 'fp', 'k1')).status).toBe('claimed');
  });

  it('release by a different holder does nothing', async () => {
    const log = new MemoryWriteLog();
    await claimed(log, 'u1', 'fp');
    await log.release('u1', 'someone-elses-token', 'fp');
    expect((await log.claim('u1', 'fp')).status).toBe('in_flight');
  });

  it('a reservation expires so a crash between claim and post cannot wedge a fingerprint', async () => {
    let t = 1_000_000;
    const log = new MemoryWriteLog(60 * 60 * 1000, () => t);
    await claimed(log, 'u1', 'fp');
    t += RESERVATION_MS + 1;
    expect((await log.claim('u1', 'fp')).status).toBe('claimed');
  });

  it('a pending reservation is not reported as a completed write', async () => {
    const log = new MemoryWriteLog();
    await claimed(log, 'u1', 'fp');
    expect(await log.find('u1', 'fp')).toBeUndefined();
  });

  it('a late holder does not overwrite the reservation that replaced it', async () => {
    let t = 1_000_000;
    const log = new MemoryWriteLog(60 * 60 * 1000, () => t);
    const stale = await claimed(log, 'u1', 'fp');
    t += RESERVATION_MS + 1;
    const fresh = await claimed(log, 'u1', 'fp');

    await log.record('u1', stale, rec(t, { expenseId: 111 }));
    expect(await log.find('u1', 'fp')).toBeUndefined();

    await log.record('u1', fresh, rec(t, { expenseId: 222 }));
    expect((await log.find('u1', 'fp'))?.expenseId).toBe(222);
  });

  it('two racing claims on one store produce exactly one winner', async () => {
    const log = new StoreWriteLog(new MemoryLogStore());
    const [a, b] = await Promise.all([log.claim('u1', 'fp'), log.claim('u1', 'fp')]);
    const statuses = [a.status, b.status].toSorted();
    expect(statuses).toEqual(['claimed', 'in_flight']);
  });

  it('keeps users apart', async () => {
    const log = new MemoryWriteLog();
    const token = await claimed(log, 'u1', 'fp');
    await log.record('u1', token, rec(Date.now()));
    expect((await log.claim('u2', 'fp')).status).toBe('claimed');
  });
});
