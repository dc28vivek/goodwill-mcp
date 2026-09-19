/**
 * Product metrics as structured events. One line of JSON per event on stderr
 * (stdio and Node HTTP) or console (Workers, where the platform captures it).
 * No names, descriptions, or amounts ever appear here. See docs/metrics.md.
 */

export type MetricEvent =
  | { type: 'tool_call'; tool: string; ok: boolean; ms: number; round: 1 | 2 }
  | { type: 'preview_shown'; tool: string }
  | { type: 'preview_confirmed'; tool: string }
  | { type: 'preview_declined'; tool: string }
  | { type: 'duplicate_blocked'; tool: string; source: 'write_log' | 'splitwise' }
  | { type: 'write_posted'; tool: string };

export interface Metrics {
  emit(event: MetricEvent): void;
}

export function stderrMetrics(): Metrics {
  return {
    emit(event) {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
      // Node has process.stderr; Workers do not, and their console output is captured by the platform.
      const proc = (globalThis as { process?: { stderr?: { write(text: string): unknown } } }).process;
      if (proc?.stderr) proc.stderr.write(`${line}\n`);
      else console.log(line);
    },
  };
}

export function noopMetrics(): Metrics {
  return { emit() {} };
}

/** Collects events in memory. For tests and the evals summary. */
export function memoryMetrics(): Metrics & { events: MetricEvent[] } {
  const events: MetricEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}
