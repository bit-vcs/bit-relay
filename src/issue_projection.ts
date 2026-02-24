import type { CacheStoreObject } from './cache_store.ts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface IssueProjectionEnvelope {
  room: string;
  id: string;
  sender: string;
  topic: string;
  payload: JsonValue;
  signature: string | null;
}

export interface IssueProjectionValidators {
  isValidRoomName: (room: string) => boolean;
  isValidTopic: (topic: string) => boolean;
}

export interface IssueCacheEventRecord {
  version: 1;
  kind: 'issue_event';
  room: string;
  cursor: number;
  issue_id: string;
  action: string;
  envelope: IssueProjectionEnvelope;
  source_updated_at_ms: number | null;
  updated_at: number;
}

export interface IssueCacheSnapshotRecord {
  version: 1;
  kind: 'issue_snapshot';
  room: string;
  issue_id: string;
  last_cursor: number;
  envelope: IssueProjectionEnvelope;
  source_updated_at_ms: number | null;
  updated_at: number;
}

export interface IssueCacheCursorRecord {
  version: 1;
  kind: 'issue_cursor';
  room: string;
  cursor: number;
  updated_at: number;
}

const ISSUE_EVENT_KEY_PREFIX = 'issue/events/';
const ISSUE_SNAPSHOT_KEY_PREFIX = 'issue/snapshots/';
const ISSUE_CURSOR_KEY_PREFIX = 'issue/cursors/';
const ISSUE_CURSOR_PAD_WIDTH = 12;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (!isObjectRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => isJsonValue(item));
}

function parseEnvelopeRecord(
  parsed: unknown,
  validators: IssueProjectionValidators,
): IssueProjectionEnvelope | null {
  if (!isObjectRecord(parsed)) return null;
  const room = typeof parsed.room === 'string' ? parsed.room : '';
  const id = typeof parsed.id === 'string' ? parsed.id : '';
  const sender = typeof parsed.sender === 'string' ? parsed.sender : '';
  const topic = typeof parsed.topic === 'string' ? parsed.topic : '';
  const signature = typeof parsed.signature === 'string'
    ? parsed.signature
    : parsed.signature === null
    ? null
    : null;
  if (!isJsonValue(parsed.payload)) return null;
  if (!validators.isValidRoomName(room)) return null;
  if (!validators.isValidTopic(topic)) return null;
  if (id.trim().length === 0 || sender.trim().length === 0) return null;
  return {
    room,
    id,
    sender,
    topic,
    payload: parsed.payload,
    signature,
  };
}

export function isIssueTopic(topic: string): boolean {
  return topic === 'issue' || topic.startsWith('issue.');
}

export function parseCachedIssueEnvelope(
  value: CacheStoreObject,
  validators: IssueProjectionValidators,
): IssueProjectionEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(value.body));
  } catch {
    return null;
  }
  return parseEnvelopeRecord(parsed, validators);
}

export function issueEventStorageKey(room: string, cursor: number, envelopeId: string): string {
  const padded = String(Math.max(0, Math.trunc(cursor))).padStart(ISSUE_CURSOR_PAD_WIDTH, '0');
  return `${ISSUE_EVENT_KEY_PREFIX}${room}/${padded}-${envelopeId}`;
}

export function issueSnapshotStorageKey(room: string, issueId: string): string {
  return `${ISSUE_SNAPSHOT_KEY_PREFIX}${room}/${issueId}`;
}

export function issueCursorStorageKey(room: string): string {
  return `${ISSUE_CURSOR_KEY_PREFIX}${room}`;
}

export function parseIssueEventCursorFromKey(room: string, key: string): number | null {
  const prefix = `${ISSUE_EVENT_KEY_PREFIX}${room}/`;
  if (!key.startsWith(prefix)) return null;
  const suffix = key.slice(prefix.length);
  const dash = suffix.indexOf('-');
  if (dash <= 0) return null;
  const value = Number.parseInt(suffix.slice(0, dash), 10);
  if (!Number.isFinite(value)) return null;
  const cursor = Math.trunc(value);
  return cursor > 0 ? cursor : null;
}

function parseIssuePayloadIssueId(payload: JsonValue): string | null {
  if (!isObjectRecord(payload)) return null;
  const direct = typeof payload.issue_id === 'string' ? payload.issue_id.trim() : '';
  if (direct.length > 0) return direct;
  const camel = typeof payload.issueId === 'string' ? payload.issueId.trim() : '';
  if (camel.length > 0) return camel;
  const issueObj = isObjectRecord(payload.issue) ? payload.issue : null;
  if (issueObj && typeof issueObj.id === 'string') {
    const nested = issueObj.id.trim();
    if (nested.length > 0) return nested;
  }
  const fallback = typeof payload.id === 'string' ? payload.id.trim() : '';
  return fallback.length > 0 ? fallback : null;
}

export function extractIssueIdFromEnvelope(envelope: IssueProjectionEnvelope): string {
  const fromPayload = parseIssuePayloadIssueId(envelope.payload);
  if (fromPayload) return fromPayload;
  return envelope.id;
}

export function deriveIssueAction(envelope: IssueProjectionEnvelope): string {
  if (envelope.topic.startsWith('issue.')) {
    const action = envelope.topic.slice('issue.'.length).trim();
    return action.length > 0 ? action : 'upsert';
  }
  if (isObjectRecord(envelope.payload) && typeof envelope.payload.kind === 'string') {
    const kind = envelope.payload.kind.trim();
    if (kind.startsWith('issue.')) {
      const action = kind.slice('issue.'.length).trim();
      if (action.length > 0) return action;
    } else if (kind.length > 0) {
      return kind;
    }
  }
  return 'upsert';
}

export function parseIssueCacheEventRecord(
  value: CacheStoreObject,
  validators: IssueProjectionValidators,
): IssueCacheEventRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(value.body));
  } catch {
    return null;
  }
  if (!isObjectRecord(parsed)) return null;
  if (parsed.kind !== 'issue_event') return null;
  if (parsed.version !== 1) return null;
  const room = typeof parsed.room === 'string' ? parsed.room : '';
  const issueId = typeof parsed.issue_id === 'string' ? parsed.issue_id.trim() : '';
  const action = typeof parsed.action === 'string' ? parsed.action.trim() : '';
  const cursorRaw = typeof parsed.cursor === 'number' ? parsed.cursor : NaN;
  const sourceUpdatedAtRaw = typeof parsed.source_updated_at_ms === 'number'
    ? parsed.source_updated_at_ms
    : parsed.source_updated_at_ms === null || parsed.source_updated_at_ms === undefined
    ? null
    : NaN;
  const updatedAtRaw = typeof parsed.updated_at === 'number' ? parsed.updated_at : NaN;
  const envelope = parseEnvelopeRecord(parsed.envelope, validators);
  if (!envelope) return null;
  if (!validators.isValidRoomName(room)) return null;
  if (issueId.length === 0) return null;
  if (action.length === 0) return null;
  if (envelope.room !== room) return null;
  const cursor = Math.trunc(cursorRaw);
  if (!Number.isFinite(cursor) || cursor <= 0) return null;
  let sourceUpdatedAtMs: number | null = null;
  if (sourceUpdatedAtRaw !== null) {
    const normalized = Math.trunc(sourceUpdatedAtRaw);
    if (!Number.isFinite(normalized) || normalized < 0) return null;
    sourceUpdatedAtMs = normalized;
  }
  const updatedAt = Math.trunc(updatedAtRaw);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  return {
    version: 1,
    kind: 'issue_event',
    room,
    cursor,
    issue_id: issueId,
    action,
    envelope,
    source_updated_at_ms: sourceUpdatedAtMs,
    updated_at: updatedAt,
  };
}

export function parseIssueCacheSnapshotRecord(
  value: CacheStoreObject,
  validators: IssueProjectionValidators,
): IssueCacheSnapshotRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(value.body));
  } catch {
    return null;
  }
  if (!isObjectRecord(parsed)) return null;
  if (parsed.kind !== 'issue_snapshot') return null;
  if (parsed.version !== 1) return null;
  const room = typeof parsed.room === 'string' ? parsed.room : '';
  const issueId = typeof parsed.issue_id === 'string' ? parsed.issue_id.trim() : '';
  const lastCursorRaw = typeof parsed.last_cursor === 'number' ? parsed.last_cursor : NaN;
  const sourceUpdatedAtRaw = typeof parsed.source_updated_at_ms === 'number'
    ? parsed.source_updated_at_ms
    : parsed.source_updated_at_ms === null || parsed.source_updated_at_ms === undefined
    ? null
    : NaN;
  const updatedAtRaw = typeof parsed.updated_at === 'number' ? parsed.updated_at : NaN;
  const envelope = parseEnvelopeRecord(parsed.envelope, validators);
  if (!envelope) return null;
  if (!validators.isValidRoomName(room)) return null;
  if (issueId.length === 0) return null;
  if (envelope.room !== room) return null;
  const lastCursor = Math.trunc(lastCursorRaw);
  if (!Number.isFinite(lastCursor) || lastCursor <= 0) return null;
  let sourceUpdatedAtMs: number | null = null;
  if (sourceUpdatedAtRaw !== null) {
    const normalized = Math.trunc(sourceUpdatedAtRaw);
    if (!Number.isFinite(normalized) || normalized < 0) return null;
    sourceUpdatedAtMs = normalized;
  }
  const updatedAt = Math.trunc(updatedAtRaw);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  return {
    version: 1,
    kind: 'issue_snapshot',
    room,
    issue_id: issueId,
    last_cursor: lastCursor,
    envelope,
    source_updated_at_ms: sourceUpdatedAtMs,
    updated_at: updatedAt,
  };
}

export function parseIssueCacheCursorRecord(
  value: CacheStoreObject,
  isValidRoomName: (room: string) => boolean,
): IssueCacheCursorRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(value.body));
  } catch {
    return null;
  }
  if (!isObjectRecord(parsed)) return null;
  if (parsed.kind !== 'issue_cursor') return null;
  if (parsed.version !== 1) return null;
  const room = typeof parsed.room === 'string' ? parsed.room : '';
  const cursorRaw = typeof parsed.cursor === 'number' ? parsed.cursor : NaN;
  const updatedAtRaw = typeof parsed.updated_at === 'number' ? parsed.updated_at : NaN;
  if (!isValidRoomName(room)) return null;
  const cursor = Math.trunc(cursorRaw);
  if (!Number.isFinite(cursor) || cursor < 0) return null;
  const updatedAt = Math.trunc(updatedAtRaw);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  return {
    version: 1,
    kind: 'issue_cursor',
    room,
    cursor,
    updated_at: updatedAt,
  };
}

export function parseIssueSourceUpdatedAtMs(payload: JsonValue): number | null {
  if (!isObjectRecord(payload)) return null;
  if (
    typeof payload.source_updated_at_ms === 'number' &&
    Number.isFinite(payload.source_updated_at_ms)
  ) {
    const normalized = Math.trunc(payload.source_updated_at_ms);
    if (normalized >= 0) return normalized;
  }
  if (!isObjectRecord(payload.issue)) return null;
  if (typeof payload.issue.updated_at !== 'string') return null;
  const raw = payload.issue.updated_at.trim();
  if (raw.length === 0) return null;
  const epochMs = Date.parse(raw);
  if (!Number.isFinite(epochMs)) return null;
  const normalized = Math.trunc(epochMs);
  return normalized >= 0 ? normalized : null;
}
