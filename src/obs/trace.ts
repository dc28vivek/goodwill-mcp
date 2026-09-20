/**
 * Minimal OpenTelemetry tracing over OTLP/HTTP JSON.
 *
 * Why not the OpenTelemetry SDK. Its auto-instrumentation records full request
 * URLs, query strings and headers. Ours carry expense ids, group ids and a
 * bearer token that grants full access to somebody's account. The rule set in
 * metrics.ts is that no name, description or amount leaves this process, and a
 * stock exporter breaks that on the first request. So this module speaks the
 * wire format every collector accepts and exports only the attribute keys in
 * ATTRIBUTE_KEYS. Nothing else can reach a collector, whatever a caller passes.
 *
 * The trace id doubles as the correlation id a user can quote in a bug report.
 * See ADR-0018.
 */

/** The only attribute keys that ever leave this process. Anything else is dropped. */
export const ATTRIBUTE_KEYS = [
  'service.name',
  'service.version',
  'deployment.environment',
  'mcp.tool',
  'mcp.method',
  'mcp.round',
  'mcp.outcome',
  'splitwise.endpoint',
  'splitwise.status',
  'splitwise.attempt',
  'splitwise.pages',
  'cache.hit',
  'breaker.state',
  'budget.remaining',
  'budget.refused',
  'writelog.outcome',
  'user.hash',
  'error.type',
] as const;

export type AttrKey = (typeof ATTRIBUTE_KEYS)[number];
export type AttrValue = string | number | boolean;
export type Attrs = Partial<Record<AttrKey, AttrValue>>;

const ALLOWED = new Set<string>(ATTRIBUTE_KEYS);

/**
 * Second line of defence behind the key allowlist: an allowed key whose value
 * was built from user data still must not carry it. Strings are capped and
 * reduced to an identifier-safe alphabet with no spaces, so a group name or a
 * description cannot survive even if one is passed by mistake.
 */
function scrub(value: AttrValue): AttrValue {
  if (typeof value !== 'string') return value;
  return value.replace(/[^A-Za-z0-9._/:{}-]/g, '_').slice(0, 64);
}

/**
 * Span names are written here, never taken from user data, so they keep their
 * spaces and their `{id}` route placeholders. Sanitised anyway, because a name
 * built by string interpolation is one careless edit away from carrying data.
 */
function scrubName(name: string): string {
  return name.replace(/[^A-Za-z0-9._/:{} -]/g, '_').slice(0, 96);
}

export const SPAN_KIND = { internal: 1, server: 2, client: 3 } as const;
export type SpanKind = (typeof SPAN_KIND)[keyof typeof SPAN_KIND];

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  child(name: string, kind?: SpanKind, attrs?: Attrs): Span;
  setAttributes(attrs: Attrs): void;
  recordError(err: unknown): void;
  end(): void;
  /** W3C traceparent for this span, to pass to a downstream service. */
  traceparent(): string;
}

export interface Tracer {
  startSpan(name: string, kind?: SpanKind, attrs?: Attrs): Span;
  /** Send finished spans. Safe to call more than once; a second call is a no-op. */
  flush(): Promise<void>;
}

interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startNano: bigint;
  endNano?: bigint;
  attributes: Map<string, AttrValue>;
  error?: string;
}

function hex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

export function newTraceId(): string {
  return hex(16);
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Read an inbound W3C traceparent so a trace started by the client continues here. */
export function parseTraceparent(header: string | null | undefined): { traceId: string; spanId: string } | undefined {
  if (!header) return undefined;
  const m = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!m?.[1] || !m[2]) return undefined;
  if (m[1] === '0'.repeat(32) || m[2] === '0'.repeat(16)) return undefined;
  return { traceId: m[1], spanId: m[2] };
}

class SpanImpl implements Span {
  constructor(
    private readonly raw: RawSpan,
    private readonly sink: Recorder,
  ) {}

  get traceId(): string {
    return this.raw.traceId;
  }

  get spanId(): string {
    return this.raw.spanId;
  }

  child(name: string, kind: SpanKind = SPAN_KIND.internal, attrs?: Attrs): Span {
    return this.sink.open(name, kind, attrs, { traceId: this.raw.traceId, spanId: this.raw.spanId });
  }

  setAttributes(attrs: Attrs): void {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || !ALLOWED.has(k)) continue;
      this.raw.attributes.set(k, scrub(v as AttrValue));
    }
  }

  recordError(err: unknown): void {
    this.raw.error = err instanceof Error ? err.constructor.name : 'Error';
    this.raw.attributes.set('error.type', this.raw.error);
  }

  end(): void {
    this.raw.endNano ??= nowNano();
  }

  traceparent(): string {
    return `00-${this.raw.traceId}-${this.raw.spanId}-01`;
  }
}

/** One attribute in the OTLP JSON encoding, which tags the value by type. */
function attribute(key: string, value: AttrValue): { key: string; value: Record<string, unknown> } {
  if (typeof value === 'number') return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

function nowNano(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

interface Recorder {
  open(name: string, kind: SpanKind, attrs: Attrs | undefined, parent?: { traceId: string; spanId: string }): Span;
}

export interface OtlpOptions {
  /** Collector base URL. `/v1/traces` is appended when the path is missing. */
  endpoint: string;
  /** Extra headers, typically an API key for a hosted collector. */
  headers?: Record<string, string>;
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  /** Continue an inbound trace instead of starting a new one. */
  parent?: { traceId: string; spanId: string } | undefined;
  fetch?: typeof fetch;
  /** Fraction of traces kept, 0 to 1. Errors are always kept. Default 1. */
  sampleRatio?: number;
}

export class OtlpTracer implements Tracer, Recorder {
  private readonly spans: RawSpan[] = [];
  private readonly traceId: string;
  private readonly rootParent: string | undefined;
  private readonly url: string;
  private readonly sampled: boolean;

  constructor(private readonly opts: OtlpOptions) {
    this.traceId = opts.parent?.traceId ?? newTraceId();
    this.rootParent = opts.parent?.spanId;
    const base = opts.endpoint.replace(/\/+$/, '');
    this.url = base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
    const ratio = opts.sampleRatio ?? 1;
    this.sampled = ratio >= 1 || Math.random() < ratio;
  }

  /** The correlation id to show a user when something fails. */
  get id(): string {
    return this.traceId;
  }

  startSpan(name: string, kind: SpanKind = SPAN_KIND.server, attrs?: Attrs): Span {
    const parent = this.rootParent ? { traceId: this.traceId, spanId: this.rootParent } : undefined;
    return this.open(name, kind, { 'service.name': this.opts.serviceName ?? 'splittab-mcp', ...attrs }, parent);
  }

  open(name: string, kind: SpanKind, attrs: Attrs | undefined, parent?: { traceId: string; spanId: string }): Span {
    const raw: RawSpan = {
      traceId: parent?.traceId ?? this.traceId,
      spanId: hex(8),
      name: scrubName(name),
      kind,
      startNano: nowNano(),
      attributes: new Map(),
    };
    if (parent?.spanId) raw.parentSpanId = parent.spanId;
    this.spans.push(raw);
    const span = new SpanImpl(raw, this);
    if (attrs) span.setAttributes(attrs);
    return span;
  }

  private body(batch: RawSpan[]): string {
    return JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              attribute('service.name', this.opts.serviceName ?? 'splittab-mcp'),
              attribute('service.version', this.opts.serviceVersion ?? '0.0.0'),
              ...(this.opts.environment ? [attribute('deployment.environment', this.opts.environment)] : []),
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'splittab', version: this.opts.serviceVersion ?? '0.0.0' },
              spans: batch.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: s.kind,
                startTimeUnixNano: s.startNano.toString(),
                endTimeUnixNano: (s.endNano ?? nowNano()).toString(),
                attributes: [...s.attributes].map(([k, v]) => attribute(k, v)),
                status: s.error ? { code: 2, message: s.error } : { code: 1 },
              })),
            },
          ],
        },
      ],
    });
  }

  /**
   * Send every finished span and forget it. Spans still open are kept for the
   * next call, so a long-lived process can flush after each request without
   * losing work in flight.
   */
  async flush(): Promise<void> {
    const ready = this.spans.filter((s) => s.endNano !== undefined);
    if (ready.length === 0) return;
    const open = this.spans.filter((s) => s.endNano === undefined);
    this.spans.length = 0;
    this.spans.push(...open);
    // An unsampled trace is still exported when something went wrong, because
    // the failures are the traces anybody actually opens.
    if (!this.sampled && !ready.some((s) => s.error)) return;
    const send = this.opts.fetch ?? fetch.bind(globalThis);
    try {
      await send(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.headers },
        body: this.body(ready),
      });
    } catch {
      // Telemetry must never fail a user's request.
    }
  }
}

const NOOP_SPAN: Span = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  child: () => NOOP_SPAN,
  setAttributes: () => {},
  recordError: () => {},
  end: () => {},
  traceparent: () => '',
};

export function noopTracer(): Tracer {
  return {
    startSpan: () => NOOP_SPAN,
    flush: async () => {},
  };
}

export { NOOP_SPAN };
