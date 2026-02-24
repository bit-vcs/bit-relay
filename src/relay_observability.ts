import type { RelayEvent } from './contracts.ts';

export type LogSink = (line: string) => void;
type AuditDetailValue = string | number | boolean | null;

export interface RelayAuditLog {
  action: string;
  occurredAt: number;
  status: number;
  room?: string | null;
  sender?: string | null;
  target?: string | null;
  id?: string | null;
  detail?: Record<string, AuditDetailValue>;
}

export interface RelayMetricLog {
  metric: string;
  occurredAt: number;
  value: number;
  unit?: string | null;
  target?: string | null;
  detail?: Record<string, AuditDetailValue>;
}

export interface RelayRequestMetricInput {
  operation: string;
  occurredAt: number;
  status: number;
  latencyMs: number;
  retryCount?: number;
}

export interface RelayRequestMetricSnapshot {
  operation: string;
  totalCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatencyMs: number;
  retryCountTotal: number;
}

export interface RelayRequestMetricRecorder {
  record(input: RelayRequestMetricInput): RelayRequestMetricSnapshot;
  snapshot(operation: string): RelayRequestMetricSnapshot;
}

interface RelayRequestMetricState {
  totalCount: number;
  successCount: number;
  failureCount: number;
  latencyTotalMs: number;
  retryCountTotal: number;
}

function writeJson(payload: Record<string, unknown>, sink: LogSink): void {
  sink(JSON.stringify(payload));
}

function normalizeFiniteNumber(raw: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return raw;
}

function normalizeNonNegativeNumber(raw: number, fallback = 0): number {
  return Math.max(0, normalizeFiniteNumber(raw, fallback));
}

function normalizeInteger(raw: number, fallback = 0): number {
  return Math.trunc(normalizeFiniteNumber(raw, fallback));
}

function normalizeOperation(operation: string): string {
  const trimmed = operation.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

function buildRequestMetricSnapshot(
  operation: string,
  state: RelayRequestMetricState,
): RelayRequestMetricSnapshot {
  const totalCount = state.totalCount;
  const successRate = totalCount > 0 ? state.successCount / totalCount : 0;
  const avgLatencyMs = totalCount > 0 ? state.latencyTotalMs / totalCount : 0;
  return {
    operation,
    totalCount,
    successCount: state.successCount,
    failureCount: state.failureCount,
    successRate,
    avgLatencyMs,
    retryCountTotal: state.retryCountTotal,
  };
}

function emptyRequestMetricSnapshot(operation: string): RelayRequestMetricSnapshot {
  return {
    operation,
    totalCount: 0,
    successCount: 0,
    failureCount: 0,
    successRate: 0,
    avgLatencyMs: 0,
    retryCountTotal: 0,
  };
}

function toEventLogRecord(event: RelayEvent): Record<string, unknown> {
  const base = {
    kind: 'relay_event',
    type: event.type,
    event_id: event.eventId,
    occurred_at: event.occurredAt,
    room: event.room,
    source: event.source,
  } satisfies Record<string, unknown>;

  if (event.type === 'incoming_ref') {
    return {
      ...base,
      ref: event.ref,
      target: event.target,
    };
  }
  if (event.type === 'issue_synced') {
    return {
      ...base,
      provider: event.provider,
      action: event.action,
      issue_id: event.issueId,
    };
  }
  return {
    ...base,
    cache_key: event.cacheKey,
    from_node: event.fromNode,
    to_node: event.toNode,
    bytes: event.bytes,
  };
}

export function logRelayEvent(event: RelayEvent, sink: LogSink = console.log): void {
  writeJson(toEventLogRecord(event), sink);
}

export function logRelayAudit(entry: RelayAuditLog, sink: LogSink = console.log): void {
  const payload: Record<string, unknown> = {
    kind: 'relay_audit',
    action: entry.action,
    occurred_at: entry.occurredAt,
    status: entry.status,
    room: entry.room ?? null,
    sender: entry.sender ?? null,
    target: entry.target ?? null,
    id: entry.id ?? null,
  };
  if (entry.detail && Object.keys(entry.detail).length > 0) {
    payload.detail = entry.detail;
  }
  writeJson(payload, sink);
}

export function logRelayMetric(entry: RelayMetricLog, sink: LogSink = console.log): void {
  const payload: Record<string, unknown> = {
    kind: 'relay_metric',
    metric: entry.metric,
    occurred_at: normalizeInteger(entry.occurredAt),
    value: normalizeFiniteNumber(entry.value, 0),
    unit: entry.unit ?? null,
    target: entry.target ?? null,
  };
  if (entry.detail && Object.keys(entry.detail).length > 0) {
    payload.detail = entry.detail;
  }
  writeJson(payload, sink);
}

export function createRelayRequestMetricRecorder(
  sink: LogSink = console.log,
): RelayRequestMetricRecorder {
  const states = new Map<string, RelayRequestMetricState>();

  function getOrCreateState(operation: string): RelayRequestMetricState {
    let state = states.get(operation);
    if (state) return state;
    state = {
      totalCount: 0,
      successCount: 0,
      failureCount: 0,
      latencyTotalMs: 0,
      retryCountTotal: 0,
    };
    states.set(operation, state);
    return state;
  }

  function record(input: RelayRequestMetricInput): RelayRequestMetricSnapshot {
    const operation = normalizeOperation(input.operation);
    const status = normalizeInteger(input.status, 500);
    const latencyMs = normalizeNonNegativeNumber(input.latencyMs);
    const retryCount = normalizeInteger(input.retryCount ?? 0);

    const state = getOrCreateState(operation);
    state.totalCount += 1;
    if (isSuccessfulStatus(status)) {
      state.successCount += 1;
    } else {
      state.failureCount += 1;
    }
    state.latencyTotalMs += latencyMs;
    state.retryCountTotal += Math.max(0, retryCount);

    const metric = buildRequestMetricSnapshot(operation, state);
    logRelayMetric(
      {
        metric: 'relay.request.success_rate',
        occurredAt: normalizeInteger(input.occurredAt),
        value: metric.successRate,
        unit: 'ratio',
        target: operation,
        detail: {
          status,
          latency_ms: latencyMs,
          retry_count: Math.max(0, retryCount),
          total_count: metric.totalCount,
          success_count: metric.successCount,
          failure_count: metric.failureCount,
          average_latency_ms: metric.avgLatencyMs,
          retry_count_total: metric.retryCountTotal,
        },
      },
      sink,
    );

    return metric;
  }

  function snapshot(operation: string): RelayRequestMetricSnapshot {
    const normalizedOperation = normalizeOperation(operation);
    const state = states.get(normalizedOperation);
    if (!state) return emptyRequestMetricSnapshot(normalizedOperation);
    return buildRequestMetricSnapshot(normalizedOperation, state);
  }

  return {
    record,
    snapshot,
  };
}
