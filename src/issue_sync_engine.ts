export interface IssueSyncDlqEntry {
  delivery_id: string;
  event: string;
  body: string;
  created_at: number;
  updated_at: number;
  retry_count: number;
  next_retry_at: number;
  last_error: string;
}

export interface IssueSyncSnapshot {
  deliveries: Record<string, number>;
  dlq: IssueSyncDlqEntry[];
}

export interface IssueSyncMappedEnvelope {
  room: string;
  sender: string;
  topic: string;
  issueId: string;
  action: string;
  envelopeId: string;
  payload: unknown;
}

export interface IssueSyncMapInput {
  event: string;
  deliveryId: string;
  requestBody: string;
  parsed: Record<string, unknown>;
}

export type IssueSyncMapResult =
  | { ok: true; mapped: IssueSyncMappedEnvelope }
  | { ok: false; error: string };

export interface IssueSyncPublishResult {
  status: number;
  accepted: boolean;
  cursor: number | null;
}

export type IssueSyncApplyResult =
  | {
    ok: true;
    accepted: boolean;
    duplicate: boolean;
    deliveryId: string;
    event: string;
    action: string;
    topic: string | null;
    room: string | null;
    issueId: string | null;
    cursor: number | null;
  }
  | {
    ok: false;
    deliveryId: string;
    event: string;
    error: string;
  };

export interface IssueSyncEngineOptions {
  maxDeliveryIds?: number;
  maxDlqEntries?: number;
  retryBaseSec?: number;
  nowSec?: () => number;
}

const DEFAULT_MAX_DELIVERY_IDS = 10_000;
const DEFAULT_MAX_DLQ_ENTRIES = 10_000;
const DEFAULT_RETRY_BASE_SEC = 30;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePositiveInt(raw: number | undefined, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.trunc(raw);
}

export function createIssueSyncEngine(options: IssueSyncEngineOptions = {}) {
  const maxDeliveryIds = normalizePositiveInt(options.maxDeliveryIds, DEFAULT_MAX_DELIVERY_IDS);
  const maxDlqEntries = normalizePositiveInt(options.maxDlqEntries, DEFAULT_MAX_DLQ_ENTRIES);
  const retryBaseSec = normalizePositiveInt(options.retryBaseSec, DEFAULT_RETRY_BASE_SEC);
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));

  const deliveryIds = new Map<string, number>();
  const dlq = new Map<string, IssueSyncDlqEntry>();
  const dlqOrder: string[] = [];

  function hasDeliveryId(deliveryId: string): boolean {
    return deliveryIds.has(deliveryId);
  }

  function rememberDeliveryId(deliveryId: string, ts: number): void {
    deliveryIds.set(deliveryId, ts);
    if (deliveryIds.size <= maxDeliveryIds) return;
    const overflow = deliveryIds.size - maxDeliveryIds;
    let removed = 0;
    for (const key of deliveryIds.keys()) {
      deliveryIds.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  function computeNextRetryAt(currentSec: number, retryCount: number): number {
    const backoff = Math.min(3600, retryBaseSec * Math.max(1, 2 ** retryCount));
    return currentSec + backoff;
  }

  function enqueueDlq(args: {
    deliveryId: string;
    event: string;
    body: string;
    error: string;
    incrementRetry: boolean;
  }): IssueSyncDlqEntry {
    const currentSec = nowSec();
    const existing = dlq.get(args.deliveryId);
    const retryCount = existing
      ? existing.retry_count + (args.incrementRetry ? 1 : 0)
      : (args.incrementRetry ? 1 : 0);
    const entry: IssueSyncDlqEntry = {
      delivery_id: args.deliveryId,
      event: args.event,
      body: args.body,
      created_at: existing ? existing.created_at : currentSec,
      updated_at: currentSec,
      retry_count: retryCount,
      next_retry_at: computeNextRetryAt(currentSec, retryCount),
      last_error: args.error,
    };
    dlq.set(args.deliveryId, entry);
    if (!existing) {
      dlqOrder.push(args.deliveryId);
    }

    if (dlqOrder.length > maxDlqEntries) {
      const overflow = dlqOrder.length - maxDlqEntries;
      for (let i = 0; i < overflow; i += 1) {
        const removed = dlqOrder.shift();
        if (!removed) break;
        dlq.delete(removed);
      }
    }

    return entry;
  }

  function removeDlq(deliveryId: string): void {
    if (!dlq.delete(deliveryId)) return;
    const index = dlqOrder.indexOf(deliveryId);
    if (index >= 0) {
      dlqOrder.splice(index, 1);
    }
  }

  function getDlqEntry(deliveryId: string): IssueSyncDlqEntry | null {
    return dlq.get(deliveryId) ?? null;
  }

  function listDlq(after: number, limit: number): {
    entries: IssueSyncDlqEntry[];
    nextCursor: number;
  } {
    const pageIds = dlqOrder.slice(after, after + limit);
    const entries: IssueSyncDlqEntry[] = [];
    for (const deliveryId of pageIds) {
      const entry = dlq.get(deliveryId);
      if (entry) entries.push(entry);
    }
    const next = after + pageIds.length;
    return {
      entries,
      nextCursor: next < dlqOrder.length ? next : after + entries.length,
    };
  }

  async function applyDelivery(args: {
    event: string;
    deliveryId: string;
    requestBody: string;
    map: (input: IssueSyncMapInput) => IssueSyncMapResult;
    publish: (mapped: IssueSyncMappedEnvelope) => Promise<IssueSyncPublishResult>;
  }): Promise<IssueSyncApplyResult> {
    const event = args.event.trim().toLowerCase();
    const deliveryId = args.deliveryId.trim();
    if (event.length === 0) {
      return { ok: false, deliveryId, event, error: 'missing issue sync event' };
    }
    if (deliveryId.length === 0) {
      return { ok: false, deliveryId, event, error: 'missing issue sync delivery id' };
    }

    if (hasDeliveryId(deliveryId)) {
      return {
        ok: true,
        accepted: false,
        duplicate: true,
        deliveryId,
        event,
        action: '',
        topic: null,
        room: null,
        issueId: null,
        cursor: null,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(args.requestBody);
    } catch {
      return { ok: false, deliveryId, event, error: 'invalid json payload' };
    }
    if (!isObjectRecord(parsed)) {
      return { ok: false, deliveryId, event, error: 'invalid json payload' };
    }

    const mapped = args.map({
      event,
      deliveryId,
      requestBody: args.requestBody,
      parsed,
    });
    if (!mapped.ok) {
      return { ok: false, deliveryId, event, error: mapped.error };
    }

    const published = await args.publish(mapped.mapped);
    if (published.status !== 200) {
      return {
        ok: false,
        deliveryId,
        event,
        error: `publish failed: status=${published.status}`,
      };
    }

    rememberDeliveryId(deliveryId, nowSec());
    if (published.accepted) {
      removeDlq(deliveryId);
    }

    return {
      ok: true,
      accepted: published.accepted,
      duplicate: !published.accepted,
      deliveryId,
      event,
      action: mapped.mapped.action,
      topic: mapped.mapped.topic,
      room: mapped.mapped.room,
      issueId: mapped.mapped.issueId,
      cursor: published.cursor,
    };
  }

  function snapshot(): IssueSyncSnapshot {
    const deliveries: Record<string, number> = {};
    for (const [deliveryId, ts] of deliveryIds.entries()) {
      if (deliveryId.trim().length === 0) continue;
      if (!Number.isFinite(ts)) continue;
      deliveries[deliveryId] = Math.max(0, Math.trunc(ts));
    }

    const entries: IssueSyncDlqEntry[] = [];
    for (const deliveryId of dlqOrder) {
      const entry = dlq.get(deliveryId);
      if (!entry) continue;
      entries.push({
        delivery_id: entry.delivery_id,
        event: entry.event,
        body: entry.body,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        retry_count: entry.retry_count,
        next_retry_at: entry.next_retry_at,
        last_error: entry.last_error,
      });
    }

    return {
      deliveries,
      dlq: entries,
    };
  }

  function restore(snapshotData: unknown): void {
    deliveryIds.clear();
    dlq.clear();
    dlqOrder.splice(0, dlqOrder.length);

    if (!isObjectRecord(snapshotData)) return;
    if (isObjectRecord(snapshotData.deliveries)) {
      for (const [deliveryId, tsRaw] of Object.entries(snapshotData.deliveries)) {
        if (deliveryId.trim().length === 0) continue;
        if (typeof tsRaw !== 'number' || !Number.isFinite(tsRaw)) continue;
        deliveryIds.set(deliveryId, Math.max(0, Math.trunc(tsRaw)));
      }
    }

    if (Array.isArray(snapshotData.dlq)) {
      for (const value of snapshotData.dlq) {
        if (!isObjectRecord(value)) continue;
        const deliveryId = (typeof value.delivery_id === 'string' ? value.delivery_id : '').trim();
        if (deliveryId.length === 0) continue;
        const event = (typeof value.event === 'string' ? value.event : '').trim();
        const body = typeof value.body === 'string' ? value.body : '';
        const createdAt =
          typeof value.created_at === 'number' && Number.isFinite(value.created_at)
            ? Math.max(0, Math.trunc(value.created_at))
            : 0;
        const updatedAt =
          typeof value.updated_at === 'number' && Number.isFinite(value.updated_at)
            ? Math.max(0, Math.trunc(value.updated_at))
            : createdAt;
        const retryCount =
          typeof value.retry_count === 'number' && Number.isFinite(value.retry_count)
            ? Math.max(0, Math.trunc(value.retry_count))
            : 0;
        const nextRetryAt =
          typeof value.next_retry_at === 'number' && Number.isFinite(value.next_retry_at)
            ? Math.max(0, Math.trunc(value.next_retry_at))
            : computeNextRetryAt(nowSec(), retryCount);
        const lastError = typeof value.last_error === 'string' ? value.last_error : '';

        dlq.set(deliveryId, {
          delivery_id: deliveryId,
          event,
          body,
          created_at: createdAt,
          updated_at: updatedAt,
          retry_count: retryCount,
          next_retry_at: nextRetryAt,
          last_error: lastError,
        });
        dlqOrder.push(deliveryId);
        if (dlqOrder.length >= maxDlqEntries) break;
      }
    }
  }

  return {
    hasDeliveryId,
    enqueueDlq,
    removeDlq,
    getDlqEntry,
    listDlq,
    applyDelivery,
    snapshot,
    restore,
  };
}
