import type { RequestStateCodec } from '@modelcontextprotocol/server';
import type { SplitwiseClient } from '../splitwise/client.js';
import type { SwCurrentUser, SwGroup } from '../splitwise/types.js';
import type { WriteLog } from '../store/writeLog.js';
import type { Metrics } from './metrics.js';

/** The opaque state we mint for multi round-trip confirmations. */
export interface PendingWrite {
  kind: 'add_expense' | 'settle_up' | 'split_by_items' | 'create_group' | 'add_to_group' | 'update_expense';
  /** Splitwise user id of the person confirming. Bound so state cannot be replayed by someone else. */
  userId: number;
  fingerprint: string;
  idempotencyKey?: string;
  payload: unknown;
}

/** Everything a tool needs for one request. Built fresh per request. */
export interface Deps {
  client: SplitwiseClient;
  writeLog: WriteLog;
  codec: RequestStateCodec<PendingWrite>;
  now: () => Date;
  metrics: Metrics;
  /** Memoized per request. */
  me(): Promise<SwCurrentUser>;
  group(id: number): Promise<SwGroup>;
}

export function makeDeps(base: Omit<Deps, 'me' | 'group'>): Deps {
  let mePromise: Promise<SwCurrentUser> | undefined;
  const groups = new Map<number, Promise<SwGroup>>();
  return {
    ...base,
    me() {
      mePromise ??= base.client.currentUser();
      return mePromise;
    },
    group(id: number) {
      let p = groups.get(id);
      if (!p) {
        p = base.client.group(id);
        groups.set(id, p);
      }
      return p;
    },
  };
}
