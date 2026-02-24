import type { JsonValue } from './contracts.ts';
import { canonicalizeJson } from './signing.ts';

export interface CacheExchangeEnvelope {
  room: string;
  id: string;
  sender: string;
  topic: string;
  payload: JsonValue;
  signature: string | null;
}

export interface CacheExchangeRecord {
  cursor: number;
  envelope: CacheExchangeEnvelope;
  origin: string;
  hopCount: number;
  maxHops: number;
}

export interface CacheExchangeEntry {
  cursor: number;
  room: string;
  id: string;
  sender: string;
  topic: string;
  payload: JsonValue;
  signature: string | null;
  origin: string;
  hop_count: number;
  max_hops: number;
}

interface IncomingExchangeEntry {
  room: string;
  id: string;
  sender: string;
  topic: string;
  payload: JsonValue;
  signature: string | null;
  origin: string;
  hopCount: number;
  maxHops: number;
}

export type CacheExchangeCollision = 'duplicate' | 'conflict';

export type ParseIncomingExchangeEntryResult =
  | { ok: true; entry: IncomingExchangeEntry }
  | { ok: false; error: string };

export interface SelectExchangeEntriesArgs {
  after: number;
  limit: number;
  peer: string | null;
  room: string | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  if (truncated < 0) return null;
  return truncated;
}

function normalizeSignature(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  const object = asObject(value);
  if (!object) return false;
  return Object.values(object).every((item) => isJsonValue(item));
}

function envelopeCanonicalSignature(envelope: CacheExchangeEnvelope): string {
  return [
    envelope.sender,
    envelope.topic,
    canonicalizeJson(envelope.payload),
    envelope.signature ?? '',
  ].join('\n');
}

export function classifyCacheExchangeCollision(
  existing: CacheExchangeEnvelope,
  incoming: CacheExchangeEnvelope,
): CacheExchangeCollision {
  return envelopeCanonicalSignature(existing) === envelopeCanonicalSignature(incoming)
    ? 'duplicate'
    : 'conflict';
}

export function selectCacheExchangeEntries(
  records: CacheExchangeRecord[],
  args: SelectExchangeEntriesArgs,
): { entries: CacheExchangeEntry[]; nextCursor: number } {
  const limit = Math.max(1, Math.trunc(args.limit));
  const entries: CacheExchangeEntry[] = [];
  let nextCursor = Math.max(0, Math.trunc(args.after));

  for (const record of records) {
    if (record.cursor <= args.after) continue;
    nextCursor = record.cursor;

    if (args.room && record.envelope.room !== args.room) continue;
    if (args.peer && record.origin === args.peer) continue;
    if (record.hopCount >= record.maxHops) continue;

    entries.push({
      cursor: record.cursor,
      room: record.envelope.room,
      id: record.envelope.id,
      sender: record.envelope.sender,
      topic: record.envelope.topic,
      payload: record.envelope.payload,
      signature: record.envelope.signature,
      origin: record.origin,
      hop_count: record.hopCount + 1,
      max_hops: record.maxHops,
    });

    if (entries.length >= limit) {
      break;
    }
  }

  return { entries, nextCursor };
}

export function parseIncomingCacheExchangeEntry(
  value: unknown,
  defaultMaxHops: number,
): ParseIncomingExchangeEntryResult {
  const parsed = asObject(value);
  if (!parsed) return { ok: false, error: 'entry must be object' };

  const room = asString(parsed.room);
  if (!room) return { ok: false, error: 'invalid room' };
  const id = asString(parsed.id);
  if (!id) return { ok: false, error: 'invalid id' };
  const sender = asString(parsed.sender);
  if (!sender) return { ok: false, error: 'invalid sender' };
  const topic = asString(parsed.topic);
  if (!topic) return { ok: false, error: 'invalid topic' };
  if (!isJsonValue(parsed.payload)) return { ok: false, error: 'invalid payload' };
  const origin = asString(parsed.origin);
  if (!origin) return { ok: false, error: 'invalid origin' };

  const hopCount = asNonNegativeInt(parsed.hop_count);
  if (hopCount === null) return { ok: false, error: 'invalid hop_count' };

  const parsedMaxHops = asNonNegativeInt(parsed.max_hops);
  const maxHops = parsedMaxHops ?? defaultMaxHops;
  if (!Number.isFinite(maxHops) || maxHops < 1) {
    return { ok: false, error: 'invalid max_hops' };
  }

  return {
    ok: true,
    entry: {
      room,
      id,
      sender,
      topic,
      payload: parsed.payload,
      signature: normalizeSignature(parsed.signature),
      origin,
      hopCount,
      maxHops,
    },
  };
}
