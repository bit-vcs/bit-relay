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

function writeJson(payload: Record<string, unknown>, sink: LogSink): void {
  sink(JSON.stringify(payload));
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
