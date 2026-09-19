import { describe, expect, it } from 'vitest';
import { KvWriteLog, MemoryWriteLog } from '../src/store/writeLog.js';

describe('MemoryWriteLog', () => {
  it('finds a recent write by fingerprint and by idempotency key', async () => {
    let t = 1_000_000;
    const log = new MemoryWriteLog(1000, () => t);
    await log.record('u1', { fingerprint: 'fp', idempotencyKey: 'k1', expenseId: 5, createdAt: new Date(t).toISOString(), description: 'dinner' });
    expect((await log.find('u1', 'fp'))?.expenseId).toBe(5);
    expect((await log.find('u1', 'other', 'k1'))?.expenseId).toBe(5);
    expect(await log.find('u2', 'fp')).toBeUndefined();
    t += 2000;
    expect(await log.find('u1', 'fp')).toBeUndefined();
  });
});

describe('KvWriteLog', () => {
  it('round-trips through a KV-like store with a TTL', async () => {
    const store = new Map<string, string>();
    let lastTtl = 0;
    const kv = {
      async get(k: string) { return store.get(k) ?? null; },
      async put(k: string, v: string, o?: { expirationTtl?: number }) { store.set(k, v); lastTtl = o?.expirationTtl ?? 0; },
    };
    const log = new KvWriteLog(kv, 3600_000);
    await log.record('u1', { fingerprint: 'fp', expenseId: 7, createdAt: new Date().toISOString(), description: 'taxi' });
    expect((await log.find('u1', 'fp'))?.expenseId).toBe(7);
    expect(lastTtl).toBe(3600);
  });
});
