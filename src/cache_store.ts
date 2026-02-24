export type CacheStoreKind = 'object' | 'pack' | 'ref' | 'issue';

const VALID_KINDS: ReadonlySet<CacheStoreKind> = new Set(['object', 'pack', 'ref', 'issue']);
const DEFAULT_LIST_LIMIT = 100;
const R2_METADATA_KIND = 'kind';
const R2_METADATA_KEY = 'key';
const R2_METADATA_ROOM = 'room';
const R2_METADATA_REF = 'ref';
const R2_METADATA_HASH = 'content_hash';
const R2_METADATA_UPDATED_AT = 'updated_at';

export interface CacheStorePutRequest {
  kind: CacheStoreKind;
  key: string;
  body: Uint8Array;
  room?: string;
  ref?: string;
  contentHash?: string;
  contentType?: string;
  updatedAt?: number;
}

export interface CacheStoreMetadata {
  kind: CacheStoreKind;
  key: string;
  size: number;
  updatedAt: number;
  room?: string;
  ref?: string;
  contentHash?: string;
  contentType?: string;
}

export interface CacheStoreObject {
  body: Uint8Array;
  metadata: CacheStoreMetadata;
}

export interface CacheStoreListQuery {
  kind?: CacheStoreKind;
  prefix?: string;
  room?: string;
  limit?: number;
  cursor?: string;
}

export interface CacheStoreListResult {
  entries: CacheStoreMetadata[];
  cursor: string | null;
}

export interface CacheStore {
  put(request: CacheStorePutRequest): Promise<void>;
  get(kind: CacheStoreKind, key: string): Promise<CacheStoreObject | null>;
  delete(kind: CacheStoreKind, key: string): Promise<boolean>;
  list(query?: CacheStoreListQuery): Promise<CacheStoreListResult>;
}

export interface R2ObjectBodyLike {
  size?: number;
  uploaded?: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListedObjectLike {
  key: string;
  size: number;
  uploaded?: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    objects: R2ListedObjectLike[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface R2CacheStoreOptions {
  bucket: R2BucketLike;
  prefix?: string;
}

interface StoredRecord {
  body: Uint8Array;
  metadata: CacheStoreMetadata;
}

function normalizeLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.trunc(raw));
}

function normalizeOffset(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '0', 10);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function cloneBytes(input: Uint8Array): Uint8Array {
  return new Uint8Array(input);
}

function isValidKind(value: string): value is CacheStoreKind {
  return VALID_KINDS.has(value as CacheStoreKind);
}

function normalizeKind(kind: CacheStoreKind): CacheStoreKind {
  if (!isValidKind(kind)) {
    throw new Error(`invalid cache store kind: ${kind}`);
  }
  return kind;
}

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error('cache store key must not be empty');
  }
  return trimmed;
}

function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

function toStorageKey(kind: CacheStoreKind, key: string): string {
  return `${kind}/${key}`;
}

function fromStorageKey(storageKey: string): { kind: CacheStoreKind; key: string } | null {
  const slash = storageKey.indexOf('/');
  if (slash <= 0) return null;
  const kindRaw = storageKey.slice(0, slash);
  const key = storageKey.slice(slash + 1);
  if (!isValidKind(kindRaw)) return null;
  if (key.length === 0) return null;
  return { kind: kindRaw, key };
}

function metadataMatchesQuery(metadata: CacheStoreMetadata, query: CacheStoreListQuery): boolean {
  if (query.kind && metadata.kind !== query.kind) return false;
  if (query.prefix && !metadata.key.startsWith(query.prefix)) return false;
  if (query.room && metadata.room !== query.room) return false;
  return true;
}

function paginateMetadata(
  entries: CacheStoreMetadata[],
  query: CacheStoreListQuery,
): CacheStoreListResult {
  const sorted = [...entries].sort((a, b) => {
    if (a.kind === b.kind) return a.key.localeCompare(b.key);
    return a.kind.localeCompare(b.kind);
  });

  const limit = normalizeLimit(query.limit);
  const start = normalizeOffset(query.cursor);
  const page = sorted.slice(start, start + limit);
  const next = start + page.length;
  return {
    entries: page,
    cursor: next < sorted.length ? String(next) : null,
  };
}

export function createMemoryCacheStore(): CacheStore {
  const records = new Map<string, StoredRecord>();

  async function put(request: CacheStorePutRequest): Promise<void> {
    const kind = normalizeKind(request.kind);
    const key = normalizeKey(request.key);
    const body = cloneBytes(request.body);
    const metadata: CacheStoreMetadata = {
      kind,
      key,
      size: body.byteLength,
      updatedAt: typeof request.updatedAt === 'number' && Number.isFinite(request.updatedAt)
        ? Math.max(0, Math.trunc(request.updatedAt))
        : nowEpochSec(),
      ...(request.room ? { room: request.room } : {}),
      ...(request.ref ? { ref: request.ref } : {}),
      ...(request.contentHash ? { contentHash: request.contentHash } : {}),
      ...(request.contentType ? { contentType: request.contentType } : {}),
    };
    records.set(toStorageKey(kind, key), { body, metadata });
  }

  async function get(kind: CacheStoreKind, key: string): Promise<CacheStoreObject | null> {
    const normalizedKind = normalizeKind(kind);
    const normalizedKey = normalizeKey(key);
    const found = records.get(toStorageKey(normalizedKind, normalizedKey));
    if (!found) return null;
    return {
      body: cloneBytes(found.body),
      metadata: { ...found.metadata },
    };
  }

  async function remove(kind: CacheStoreKind, key: string): Promise<boolean> {
    const normalizedKind = normalizeKind(kind);
    const normalizedKey = normalizeKey(key);
    return records.delete(toStorageKey(normalizedKind, normalizedKey));
  }

  async function list(query: CacheStoreListQuery = {}): Promise<CacheStoreListResult> {
    const entries: CacheStoreMetadata[] = [];
    for (const record of records.values()) {
      if (!metadataMatchesQuery(record.metadata, query)) continue;
      entries.push({ ...record.metadata });
    }
    return paginateMetadata(entries, query);
  }

  return {
    put,
    get,
    delete: remove,
    list,
  };
}

function normalizeR2Prefix(prefix: string | undefined): string {
  const raw = (prefix ?? '').trim();
  if (raw.length === 0) return '';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function toR2Key(prefix: string, kind: CacheStoreKind, key: string): string {
  return `${prefix}${kind}/${key}`;
}

function parseR2Key(prefix: string, r2Key: string): { kind: CacheStoreKind; key: string } | null {
  if (!r2Key.startsWith(prefix)) return null;
  return fromStorageKey(r2Key.slice(prefix.length));
}

function parseUpdatedAt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function toR2Metadata(request: CacheStorePutRequest): Record<string, string> {
  const metadata: Record<string, string> = {
    [R2_METADATA_KIND]: request.kind,
    [R2_METADATA_KEY]: request.key,
    [R2_METADATA_UPDATED_AT]: String(
      typeof request.updatedAt === 'number' && Number.isFinite(request.updatedAt)
        ? Math.max(0, Math.trunc(request.updatedAt))
        : nowEpochSec(),
    ),
  };
  if (request.room) metadata[R2_METADATA_ROOM] = request.room;
  if (request.ref) metadata[R2_METADATA_REF] = request.ref;
  if (request.contentHash) metadata[R2_METADATA_HASH] = request.contentHash;
  return metadata;
}

function toMetadataFromR2Object(
  fallbackKind: CacheStoreKind,
  fallbackKey: string,
  size: number,
  uploadedAt: Date | undefined,
  contentType: string | undefined,
  customMetadata: Record<string, string> | undefined,
): CacheStoreMetadata {
  const updatedFallback = uploadedAt
    ? Math.max(0, Math.trunc(uploadedAt.getTime() / 1000))
    : nowEpochSec();
  const kindRaw = customMetadata?.[R2_METADATA_KIND];
  const keyRaw = customMetadata?.[R2_METADATA_KEY];
  const kind = kindRaw && isValidKind(kindRaw) ? kindRaw : fallbackKind;
  const key = keyRaw && keyRaw.length > 0 ? keyRaw : fallbackKey;
  const updatedAt = parseUpdatedAt(customMetadata?.[R2_METADATA_UPDATED_AT], updatedFallback);

  return {
    kind,
    key,
    size,
    updatedAt,
    ...(customMetadata?.[R2_METADATA_ROOM] ? { room: customMetadata[R2_METADATA_ROOM] } : {}),
    ...(customMetadata?.[R2_METADATA_REF] ? { ref: customMetadata[R2_METADATA_REF] } : {}),
    ...(customMetadata?.[R2_METADATA_HASH]
      ? { contentHash: customMetadata[R2_METADATA_HASH] }
      : {}),
    ...(contentType ? { contentType } : {}),
  };
}

export function createR2CacheStore(options: R2CacheStoreOptions): CacheStore {
  const bucket = options.bucket;
  const prefix = normalizeR2Prefix(options.prefix);

  async function put(request: CacheStorePutRequest): Promise<void> {
    const kind = normalizeKind(request.kind);
    const key = normalizeKey(request.key);
    const body = cloneBytes(request.body);
    await bucket.put(toR2Key(prefix, kind, key), body, {
      httpMetadata: request.contentType ? { contentType: request.contentType } : undefined,
      customMetadata: toR2Metadata({ ...request, kind, key }),
    });
  }

  async function get(kind: CacheStoreKind, key: string): Promise<CacheStoreObject | null> {
    const normalizedKind = normalizeKind(kind);
    const normalizedKey = normalizeKey(key);
    const found = await bucket.get(toR2Key(prefix, normalizedKind, normalizedKey));
    if (!found) return null;
    const body = new Uint8Array(await found.arrayBuffer());
    return {
      body,
      metadata: toMetadataFromR2Object(
        normalizedKind,
        normalizedKey,
        typeof found.size === 'number' && Number.isFinite(found.size)
          ? found.size
          : body.byteLength,
        found.uploaded,
        found.httpMetadata?.contentType,
        found.customMetadata,
      ),
    };
  }

  async function remove(kind: CacheStoreKind, key: string): Promise<boolean> {
    const existing = await get(kind, key);
    if (!existing) return false;
    await bucket.delete(toR2Key(prefix, normalizeKind(kind), normalizeKey(key)));
    return true;
  }

  async function list(query: CacheStoreListQuery = {}): Promise<CacheStoreListResult> {
    const entries: CacheStoreMetadata[] = [];
    let cursor: string | undefined;
    while (true) {
      const page = await bucket.list({ prefix, limit: 1000, cursor });
      for (const object of page.objects) {
        const parsed = parseR2Key(prefix, object.key);
        if (!parsed) continue;
        const metadata = toMetadataFromR2Object(
          parsed.kind,
          parsed.key,
          object.size,
          object.uploaded,
          object.httpMetadata?.contentType,
          object.customMetadata,
        );
        if (!metadataMatchesQuery(metadata, query)) continue;
        entries.push(metadata);
      }
      if (!page.truncated || !page.cursor) break;
      cursor = page.cursor;
    }
    return paginateMetadata(entries, query);
  }

  return {
    put,
    get,
    delete: remove,
    list,
  };
}
