import type { CacheStore, CacheStoreListResult, CacheStoreObject } from './cache_store.ts';
import type { IssueSourceOfTruth } from './memory_handler.ts';
import { createCachePersistenceQueue } from './cache_persistence_queue.ts';
import { canonicalizeJson, sha256Hex } from './signing.ts';
import {
  deriveIssueAction,
  extractIssueIdFromEnvelope,
  isIssueTopic,
  type IssueCacheCursorRecord,
  type IssueCacheEventRecord,
  type IssueCacheSnapshotRecord,
  issueCursorStorageKey,
  issueEventStorageKey,
  type IssueProjectionEnvelope,
  issueSnapshotStorageKey,
  type JsonValue,
  parseCachedIssueEnvelope,
  parseIssueCacheCursorRecord,
  parseIssueCacheEventRecord,
  parseIssueCacheSnapshotRecord,
  parseIssueEventCursorFromKey,
  parseIssueSourceUpdatedAtMs,
} from './issue_projection.ts';
import { createRelayRequestMetricRecorder, logRelayMetric } from './relay_observability.ts';

type JsonObject = { [key: string]: JsonValue };

interface IssueProjectionValidators {
  isValidRoomName: (room: string) => boolean;
  isValidTopic: (topic: string) => boolean;
}

interface PutCacheJsonObjectArgs {
  kind: 'issue' | 'object';
  key: string;
  room: string;
  ref: string;
  value: unknown;
  updatedAt: number;
}

export interface RelayCacheAdapterOptions {
  cacheStore: CacheStore | null;
  isValidRoomName: (room: string) => boolean;
  isValidTopic: (topic: string) => boolean;
  issueSourceOfTruth?: IssueSourceOfTruth;
  nowSec?: () => number;
  cachePersistMaxRetries?: number;
  cachePersistRetryBaseDelayMs?: number;
  cachePersistRetryMaxDelayMs?: number;
}

export interface RelayCacheIssuePullResult {
  nextCursor: number;
  envelopes: IssueProjectionEnvelope[];
}

export interface RelayCacheIssueSyncResult {
  nextCursor: number;
  roomCursor: number;
  events: IssueCacheEventRecord[];
  snapshots: IssueCacheSnapshotRecord[];
}

export interface RelayCacheAdapter {
  persistEnvelope(envelope: IssueProjectionEnvelope, roomCursorHint?: number): Promise<void>;
  pullIssues(room: string, after: number, limit: number): Promise<RelayCacheIssuePullResult>;
  syncIssues(
    room: string,
    after: number,
    limit: number,
    snapshotLimit: number,
  ): Promise<RelayCacheIssueSyncResult>;
  snapshotIssueCursors(): Record<string, number>;
  restoreIssueCursors(snapshot: Record<string, unknown> | null | undefined): void;
}

const DEFAULT_CACHE_PERSIST_MAX_RETRIES = 2;
const DEFAULT_CACHE_PERSIST_RETRY_BASE_DELAY_MS = 20;
const DEFAULT_CACHE_PERSIST_RETRY_MAX_DELAY_MS = 500;
const DEFAULT_ISSUE_SOURCE_OF_TRUTH: IssueSourceOfTruth = 'last_write';

type NormalizedIssueSource = 'github' | 'bit' | null;

function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

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

function normalizeLimit(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.trunc(raw));
}

function normalizeOptionalNonNegativeInt(raw: number | undefined, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.trunc(raw));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeIssueSourceOfTruth(raw: IssueSourceOfTruth | undefined): IssueSourceOfTruth {
  return raw === 'github' || raw === 'bit' ? raw : DEFAULT_ISSUE_SOURCE_OF_TRUTH;
}

function parseIssueSource(payload: JsonValue): NormalizedIssueSource {
  if (!isObjectRecord(payload)) return null;
  if (typeof payload.source !== 'string') return null;
  const source = payload.source.trim().toLowerCase();
  if (source === 'github') return 'github';
  if (source === 'bit') return 'bit';
  return null;
}

function isOlderByTimestamp(
  incomingSourceUpdatedAtMs: number | null,
  existingSourceUpdatedAtMs: number | null,
): boolean {
  return incomingSourceUpdatedAtMs !== null &&
    existingSourceUpdatedAtMs !== null &&
    incomingSourceUpdatedAtMs < existingSourceUpdatedAtMs;
}

function shouldUpdateSnapshotBySourcePolicy(args: {
  policy: IssueSourceOfTruth;
  incomingSource: NormalizedIssueSource;
  existingSource: NormalizedIssueSource;
  incomingSourceUpdatedAtMs: number | null;
  existingSourceUpdatedAtMs: number | null;
}): boolean {
  if (isOlderByTimestamp(args.incomingSourceUpdatedAtMs, args.existingSourceUpdatedAtMs)) {
    return false;
  }
  if (args.policy === 'last_write') {
    return true;
  }

  const preferred = args.policy;
  if (args.existingSource === preferred && args.incomingSource !== preferred) {
    return false;
  }
  if (args.existingSource !== preferred && args.incomingSource === preferred) {
    return true;
  }
  return true;
}

export function createRelayCacheAdapter(options: RelayCacheAdapterOptions): RelayCacheAdapter {
  const cacheStore = options.cacheStore;
  const isValidRoomName = options.isValidRoomName;
  const isValidTopic = options.isValidTopic;
  const nowSec = options.nowSec ?? nowEpochSec;
  const issueSourceOfTruth = normalizeIssueSourceOfTruth(options.issueSourceOfTruth);
  const issueProjectionValidators: IssueProjectionValidators = {
    isValidRoomName,
    isValidTopic,
  };
  const issueCursorByRoom = new Map<string, number>();

  const cachePersistMaxRetries = normalizeOptionalNonNegativeInt(
    options.cachePersistMaxRetries,
    DEFAULT_CACHE_PERSIST_MAX_RETRIES,
  );
  const cachePersistRetryBaseDelayMs = normalizeOptionalNonNegativeInt(
    options.cachePersistRetryBaseDelayMs,
    DEFAULT_CACHE_PERSIST_RETRY_BASE_DELAY_MS,
  );
  const cachePersistRetryMaxDelayMs = Math.max(
    cachePersistRetryBaseDelayMs,
    normalizeOptionalNonNegativeInt(
      options.cachePersistRetryMaxDelayMs,
      DEFAULT_CACHE_PERSIST_RETRY_MAX_DELAY_MS,
    ),
  );
  const cachePersistRequestMetrics = createRelayRequestMetricRecorder();

  const persistenceQueue = cacheStore
    ? createCachePersistenceQueue({
      maxRetries: cachePersistMaxRetries,
      retryBaseDelayMs: cachePersistRetryBaseDelayMs,
      retryMaxDelayMs: cachePersistRetryMaxDelayMs,
      onRetry(entry) {
        logRelayMetric({
          metric: 'relay.cache.persist.retry',
          occurredAt: nowSec(),
          value: 1,
          unit: 'count',
          target: 'cache.persist',
          detail: {
            retry_count: entry.retryCount,
            delay_ms: entry.delayMs,
            error: describeError(entry.error),
          },
        });
      },
      onSettled(entry) {
        cachePersistRequestMetrics.record({
          operation: 'cache.persist',
          occurredAt: nowSec(),
          status: entry.success ? 200 : 500,
          latencyMs: entry.durationMs,
          retryCount: entry.retryCount,
        });
      },
    })
    : null;

  async function putCacheJsonObject(args: PutCacheJsonObjectArgs): Promise<void> {
    if (!cacheStore) return;
    const bodyText = JSON.stringify(args.value);
    const hashInput = isJsonValue(args.value) ? canonicalizeJson(args.value) : bodyText;
    const contentHash = await sha256Hex(hashInput);
    await cacheStore.put({
      kind: args.kind,
      key: args.key,
      body: new TextEncoder().encode(bodyText),
      room: args.room,
      ref: args.ref,
      contentHash,
      contentType: 'application/json',
      updatedAt: args.updatedAt,
    });
  }

  async function readIssueCursorFromCache(room: string): Promise<number> {
    if (!cacheStore) return 0;
    const cached = await cacheStore.get('object', issueCursorStorageKey(room));
    if (!cached) return 0;
    const parsed = parseIssueCacheCursorRecord(cached, isValidRoomName);
    if (!parsed) return 0;
    if (parsed.room !== room) return 0;
    return parsed.cursor;
  }

  async function currentIssueCursor(room: string): Promise<number> {
    const inMemory = issueCursorByRoom.get(room) ?? 0;
    if (!cacheStore) return inMemory;
    let persisted = 0;
    try {
      persisted = await readIssueCursorFromCache(room);
    } catch {
      persisted = 0;
    }
    const current = Math.max(inMemory, persisted);
    issueCursorByRoom.set(room, current);
    return current;
  }

  async function nextIssueCursor(room: string, roomCursorHint?: number): Promise<number> {
    const current = await currentIssueCursor(room);
    const hint = typeof roomCursorHint === 'number' && Number.isFinite(roomCursorHint)
      ? Math.max(0, Math.trunc(roomCursorHint) - 1)
      : 0;
    const next = Math.max(current, hint) + 1;
    issueCursorByRoom.set(room, next);
    return next;
  }

  async function persistIssueProjectionToCache(
    envelope: IssueProjectionEnvelope,
    roomCursorHint?: number,
  ): Promise<void> {
    if (!cacheStore) return;
    const issueId = extractIssueIdFromEnvelope(envelope);
    const issueCursor = await nextIssueCursor(envelope.room, roomCursorHint);
    const updatedAt = nowSec();
    const action = deriveIssueAction(envelope);
    const sourceUpdatedAtMs = parseIssueSourceUpdatedAtMs(envelope.payload);

    const issueEvent: IssueCacheEventRecord = {
      version: 1,
      kind: 'issue_event',
      room: envelope.room,
      cursor: issueCursor,
      issue_id: issueId,
      action,
      envelope,
      source_updated_at_ms: sourceUpdatedAtMs,
      updated_at: updatedAt,
    };
    await putCacheJsonObject({
      kind: 'object',
      key: issueEventStorageKey(envelope.room, issueCursor, envelope.id),
      room: envelope.room,
      ref: `issue_event:${issueId}`,
      value: issueEvent,
      updatedAt,
    });

    let shouldUpdateSnapshot = true;
    try {
      const existing = await cacheStore.get(
        'object',
        issueSnapshotStorageKey(envelope.room, issueId),
      );
      if (existing) {
        const parsed = parseIssueCacheSnapshotRecord(existing, issueProjectionValidators);
        if (parsed) {
          const existingSource = parseIssueSource(parsed.envelope.payload);
          const incomingSource = parseIssueSource(envelope.payload);
          shouldUpdateSnapshot = shouldUpdateSnapshotBySourcePolicy({
            policy: issueSourceOfTruth,
            incomingSource,
            existingSource,
            incomingSourceUpdatedAtMs: sourceUpdatedAtMs,
            existingSourceUpdatedAtMs: parsed.source_updated_at_ms,
          });
        }
      }
    } catch {
      shouldUpdateSnapshot = true;
    }

    if (shouldUpdateSnapshot) {
      const issueSnapshot: IssueCacheSnapshotRecord = {
        version: 1,
        kind: 'issue_snapshot',
        room: envelope.room,
        issue_id: issueId,
        last_cursor: issueCursor,
        envelope,
        source_updated_at_ms: sourceUpdatedAtMs,
        updated_at: updatedAt,
      };
      await putCacheJsonObject({
        kind: 'object',
        key: issueSnapshotStorageKey(envelope.room, issueId),
        room: envelope.room,
        ref: 'issue_snapshot',
        value: issueSnapshot,
        updatedAt,
      });
    }

    const issueCursorRecord: IssueCacheCursorRecord = {
      version: 1,
      kind: 'issue_cursor',
      room: envelope.room,
      cursor: issueCursor,
      updated_at: updatedAt,
    };
    await putCacheJsonObject({
      kind: 'object',
      key: issueCursorStorageKey(envelope.room),
      room: envelope.room,
      ref: 'issue_cursor',
      value: issueCursorRecord,
      updatedAt,
    });
  }

  async function persistEnvelope(
    envelope: IssueProjectionEnvelope,
    roomCursorHint?: number,
  ): Promise<void> {
    if (!persistenceQueue) return;
    try {
      await persistenceQueue.enqueue(async () => {
        const kind = isIssueTopic(envelope.topic) ? 'issue' : 'object';
        const key = `${envelope.room}/${envelope.id}`;
        const updatedAt = nowSec();
        await putCacheJsonObject({
          kind,
          key,
          room: envelope.room,
          ref: envelope.topic,
          value: envelope,
          updatedAt,
        });
        if (kind === 'issue') {
          await persistIssueProjectionToCache(envelope, roomCursorHint);
        }
      });
    } catch {
      // Cache failures should not affect relay publish availability.
    }
  }

  async function loadIssueEventsFromCache(
    room: string,
    after: number,
    limit: number,
  ): Promise<{ events: IssueCacheEventRecord[]; nextCursor: number }> {
    if (!cacheStore) {
      return { events: [], nextCursor: after };
    }
    const prefix = `issue/events/${room}/`;
    const pageSize = Math.max(100, limit * 2);
    let listCursor: string | undefined;
    const events: IssueCacheEventRecord[] = [];

    while (events.length < limit) {
      const listed = await cacheStore.list({
        kind: 'object',
        room,
        prefix,
        limit: pageSize,
        ...(listCursor ? { cursor: listCursor } : {}),
      });
      for (const entry of listed.entries) {
        const keyCursor = parseIssueEventCursorFromKey(room, entry.key);
        if (!keyCursor || keyCursor <= after) continue;
        let cached: CacheStoreObject | null;
        try {
          cached = await cacheStore.get('object', entry.key);
        } catch {
          continue;
        }
        if (!cached) continue;
        const record = parseIssueCacheEventRecord(cached, issueProjectionValidators);
        if (!record) continue;
        if (record.room !== room || record.cursor <= after) continue;
        events.push(record);
        if (events.length >= limit) break;
      }

      if (events.length >= limit || listed.cursor === null) {
        break;
      }
      listCursor = listed.cursor;
    }

    events.sort((a, b) => a.cursor - b.cursor);
    const nextCursor = events.length > 0 ? events[events.length - 1].cursor : after;
    return { events, nextCursor };
  }

  async function loadIssueSnapshotsFromCache(
    room: string,
    limit: number,
  ): Promise<IssueCacheSnapshotRecord[]> {
    if (!cacheStore) return [];
    const prefix = `issue/snapshots/${room}/`;
    const pageSize = Math.max(100, limit);
    let listCursor: string | undefined;
    const snapshots: IssueCacheSnapshotRecord[] = [];

    while (snapshots.length < limit) {
      const listed = await cacheStore.list({
        kind: 'object',
        room,
        prefix,
        limit: pageSize,
        ...(listCursor ? { cursor: listCursor } : {}),
      });
      for (const entry of listed.entries) {
        let cached: CacheStoreObject | null;
        try {
          cached = await cacheStore.get('object', entry.key);
        } catch {
          continue;
        }
        if (!cached) continue;
        const record = parseIssueCacheSnapshotRecord(cached, issueProjectionValidators);
        if (!record) continue;
        if (record.room !== room) continue;
        snapshots.push(record);
        if (snapshots.length >= limit) break;
      }

      if (snapshots.length >= limit || listed.cursor === null) {
        break;
      }
      listCursor = listed.cursor;
    }

    snapshots.sort((a, b) => a.issue_id.localeCompare(b.issue_id));
    return snapshots;
  }

  async function syncIssues(
    room: string,
    after: number,
    limit: number,
    snapshotLimit: number,
  ): Promise<RelayCacheIssueSyncResult> {
    const normalizedAfter = Math.max(0, Math.trunc(after));
    const normalizedLimit = normalizeLimit(limit);
    const normalizedSnapshotLimit = normalizeLimit(snapshotLimit);

    if (!cacheStore) {
      return {
        nextCursor: normalizedAfter,
        roomCursor: normalizedAfter,
        events: [],
        snapshots: [],
      };
    }

    try {
      const eventsResult = await loadIssueEventsFromCache(room, normalizedAfter, normalizedLimit);
      const snapshots = await loadIssueSnapshotsFromCache(room, normalizedSnapshotLimit);
      const roomCursor = await currentIssueCursor(room);
      return {
        nextCursor: eventsResult.nextCursor,
        roomCursor,
        events: eventsResult.events,
        snapshots,
      };
    } catch {
      return {
        nextCursor: normalizedAfter,
        roomCursor: normalizedAfter,
        events: [],
        snapshots: [],
      };
    }
  }

  async function pullIssues(
    room: string,
    after: number,
    limit: number,
  ): Promise<RelayCacheIssuePullResult> {
    const normalizedAfter = Math.max(0, Math.trunc(after));
    const normalizedLimit = normalizeLimit(limit);

    if (!cacheStore) {
      return {
        nextCursor: normalizedAfter,
        envelopes: [],
      };
    }

    let listed: CacheStoreListResult;
    try {
      listed = await cacheStore.list({
        kind: 'issue',
        room,
        limit: normalizedLimit,
        cursor: String(normalizedAfter),
      });
    } catch {
      return {
        nextCursor: normalizedAfter,
        envelopes: [],
      };
    }

    const envelopes: IssueProjectionEnvelope[] = [];
    for (const entry of listed.entries) {
      let cached;
      try {
        cached = await cacheStore.get('issue', entry.key);
      } catch {
        continue;
      }
      if (!cached) continue;
      const envelope = parseCachedIssueEnvelope(cached, issueProjectionValidators);
      if (!envelope) continue;
      if (envelope.room !== room) continue;
      if (!isIssueTopic(envelope.topic)) continue;
      envelopes.push(envelope);
    }

    const nextCursor = listed.cursor === null
      ? normalizedAfter + listed.entries.length
      : Number.parseInt(listed.cursor, 10);
    return {
      nextCursor: Number.isFinite(nextCursor)
        ? nextCursor
        : normalizedAfter + listed.entries.length,
      envelopes,
    };
  }

  function snapshotIssueCursors(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const [room, cursor] of issueCursorByRoom.entries()) {
      if (!isValidRoomName(room)) continue;
      if (!Number.isFinite(cursor)) continue;
      snapshot[room] = Math.max(0, Math.trunc(cursor));
    }
    return snapshot;
  }

  function restoreIssueCursors(snapshot: Record<string, unknown> | null | undefined): void {
    issueCursorByRoom.clear();
    if (!isObjectRecord(snapshot)) return;
    for (const [room, cursorRaw] of Object.entries(snapshot)) {
      if (!isValidRoomName(room)) continue;
      if (typeof cursorRaw !== 'number' || !Number.isFinite(cursorRaw)) continue;
      issueCursorByRoom.set(room, Math.max(0, Math.trunc(cursorRaw)));
    }
  }

  return {
    persistEnvelope,
    pullIssues,
    syncIssues,
    snapshotIssueCursors,
    restoreIssueCursors,
  };
}
