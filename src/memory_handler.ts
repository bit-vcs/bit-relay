import {
  buildPublishSigningMessage,
  buildReviewSigningMessage,
  buildRotateSigningMessage,
  canonicalizeJson,
  isLikelyBase64Url,
  sha256Hex,
  verifyEd25519Signature,
} from './signing.ts';
import { fetchGitHubEd25519Keys, matchesGitHubKey } from './github_keys.ts';
import type { CacheStore, CacheStoreListResult, CacheStoreObject } from './cache_store.ts';
import {
  type CacheExchangeRecord,
  classifyCacheExchangeCollision,
  parseIncomingCacheExchangeEntry,
  selectCacheExchangeEntries,
} from './cache_exchange.ts';
import { createIssueSyncEngine } from './issue_sync_engine.ts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };
type KeyStatus = 'active' | 'revoked';

export interface Envelope {
  room: string;
  id: string;
  sender: string;
  topic: string;
  payload: JsonValue;
  signature: string | null;
}

interface PublishResult {
  status: number;
  body: JsonObject;
  changed: boolean;
  envelope: Envelope | null;
}

interface AckResult {
  status: number;
  body: JsonObject;
}

interface RateCounter {
  count: number;
  windowStart: number;
}

interface KeyRecord {
  publicKey: string;
  status: KeyStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  githubUsername: string | null;
  githubVerifiedAt: number | null;
}

interface PublishAuthHeaders {
  publicKey: string;
  signature: string;
  timestampSec: number;
  nonce: string;
}

type ReviewVerdict = 'approve' | 'deny';

interface ReviewRecord {
  sender: string;
  verdict: ReviewVerdict;
  submittedAt: number;
  updatedAt: number;
}

interface PresenceRecord {
  participantId: string;
  status: string;
  metadata: JsonValue;
  lastHeartbeat: number; // epoch seconds
}

interface WsSessionMeta {
  lastActive: number; // epoch ms
}

interface RoomState {
  messages: Envelope[];
  acksByConsumer: Map<string, Set<string>>;
  sessions: Map<WebSocket, WsSessionMeta>;
  presenceByParticipant: Map<string, PresenceRecord>;
  reviewsByPr: Map<string, Map<string, ReviewRecord>>;
}

interface SnapshotPresenceRecord {
  participant_id: string;
  status: string;
  metadata: JsonValue;
  last_heartbeat: number;
}

interface SnapshotReviewRecord {
  sender: string;
  verdict: string;
  pr_id: string;
  submitted_at: number;
  updated_at: number;
}

interface SnapshotRoom {
  messages: Envelope[];
  acks_by_consumer: Record<string, string[]>;
  presence?: SnapshotPresenceRecord[];
  reviews?: SnapshotReviewRecord[];
}

interface SnapshotKeyRecord {
  public_key: string;
  status: KeyStatus;
  first_seen_at: number;
  last_seen_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
  github_username: string | null;
  github_verified_at: number | null;
}

type CacheExchangeRejectionReason =
  | 'invalid_room'
  | 'invalid_topic'
  | 'loop_origin'
  | 'max_hops_reached';

interface SnapshotCacheExchangeRecord {
  cursor: number;
  envelope: Envelope;
  origin: string;
  hop_count: number;
  max_hops: number;
}

interface SnapshotCacheExchangeState {
  cursor: number;
  records: SnapshotCacheExchangeRecord[];
}

interface SnapshotGitHubWebhookDlqEntry {
  delivery_id: string;
  event: string;
  body: string;
  created_at: number;
  updated_at: number;
  retry_count: number;
  next_retry_at: number;
  last_error: string;
}

interface SnapshotGitHubWebhookState {
  deliveries: Record<string, number>;
  dlq: SnapshotGitHubWebhookDlqEntry[];
}

interface IssueCacheEventRecord {
  version: 1;
  kind: 'issue_event';
  room: string;
  cursor: number;
  issue_id: string;
  action: string;
  envelope: Envelope;
  source_updated_at_ms: number | null;
  updated_at: number;
}

interface IssueCacheSnapshotRecord {
  version: 1;
  kind: 'issue_snapshot';
  room: string;
  issue_id: string;
  last_cursor: number;
  envelope: Envelope;
  source_updated_at_ms: number | null;
  updated_at: number;
}

interface IssueCacheCursorRecord {
  version: 1;
  kind: 'issue_cursor';
  room: string;
  cursor: number;
  updated_at: number;
}

export interface RelaySnapshot {
  rooms: Record<string, SnapshotRoom>;
  keys_by_sender: Record<string, SnapshotKeyRecord>;
  nonces_by_sender: Record<string, Record<string, number>>;
  cache_exchange?: SnapshotCacheExchangeState;
  issue_cursors?: Record<string, number>;
  github_webhook?: SnapshotGitHubWebhookState;
}

export interface IdentitySnapshot {
  keys_by_sender: Record<string, SnapshotKeyRecord>;
  nonces_by_sender: Record<string, Record<string, number>>;
}

export interface MemoryRelayOptions {
  authToken?: string;
  maxMessagesPerRoom?: number;
  publishPayloadMaxBytes?: number;
  publishLimitPerWindow?: number;
  publishWindowMs?: number;
  ipPublishLimitPerWindow?: number;
  roomPublishLimitPerWindow?: number;
  roomTokens?: Record<string, string>;
  maxWsSessions?: number;
  requireSignatures?: boolean;
  maxClockSkewSec?: number;
  nonceTtlSec?: number;
  maxNoncesPerSender?: number;
  presenceTtlSec?: number;
  wsPingIntervalMs?: number;
  wsIdleTimeoutMs?: number;
  relayNodeId?: string;
  peerRelayUrls?: string[];
  cacheExchangeMaxHops?: number;
  cacheExchangeMaxRecords?: number;
  cacheStore?: CacheStore;
  githubWebhookSecret?: string;
  fetchFn?: typeof globalThis.fetch;
}

export interface MemoryRelayService {
  fetch(request: Request): Promise<Response>;
  snapshot(): RelaySnapshot;
  restore(snapshot: RelaySnapshot): void;
  identitySnapshot(): IdentitySnapshot;
  restoreIdentity(snapshot: IdentitySnapshot): void;
  close(): void;
}

const DEFAULT_ROOM = 'main';
const DEFAULT_PRESENCE_TTL_SEC = 60;
const DEFAULT_MAX_MESSAGES_PER_ROOM = 1000;
const DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES = 64 * 1024;
const DEFAULT_PUBLISH_LIMIT_PER_WINDOW = 30;
const DEFAULT_PUBLISH_WINDOW_MS = 60_000;
const DEFAULT_IP_PUBLISH_LIMIT_PER_WINDOW = 60;
const DEFAULT_ROOM_PUBLISH_LIMIT_PER_WINDOW = 60;
const DEFAULT_MAX_WS_SESSIONS = 100;
const DEFAULT_REQUIRE_SIGNATURES = true;
const DEFAULT_MAX_CLOCK_SKEW_SEC = 300;
const DEFAULT_NONCE_TTL_SEC = 600;
const DEFAULT_MAX_NONCES_PER_SENDER = 2048;
const DEFAULT_WS_PING_INTERVAL_MS = 30_000;
const DEFAULT_WS_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_CACHE_EXCHANGE_MAX_HOPS = 3;
const DEFAULT_CACHE_EXCHANGE_MAX_RECORDS = 10_000;
const MAX_GITHUB_WEBHOOK_DELIVERY_IDS = 10_000;
const MAX_GITHUB_WEBHOOK_DLQ_ENTRIES = 10_000;
const GITHUB_WEBHOOK_RETRY_BASE_SEC = 30;
const INCOMING_TRIGGER_REF_PREFIX = 'refs/relay/incoming/';
const ISSUE_EVENT_KEY_PREFIX = 'issue/events/';
const ISSUE_SNAPSHOT_KEY_PREFIX = 'issue/snapshots/';
const ISSUE_CURSOR_KEY_PREFIX = 'issue/cursors/';
const ISSUE_CURSOR_PAD_WIDTH = 12;
const ROOM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOPIC_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const PR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VALID_VERDICTS: ReadonlySet<string> = new Set(['approve', 'deny']);
const WS_OPEN_STATE = 1;

function extractClientIp(request: Request): string {
  const cfIp = (request.headers.get('cf-connecting-ip') ?? '').trim();
  if (cfIp.length > 0) return cfIp;
  const xff = (request.headers.get('x-forwarded-for') ?? '').trim();
  if (xff.length > 0) {
    const first = xff.split(',')[0].trim();
    if (first.length > 0) return first;
  }
  const realIp = (request.headers.get('x-real-ip') ?? '').trim();
  if (realIp.length > 0) return realIp;
  return '';
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

function parseIntOr(raw: string | null, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeLimit(raw: string | null, fallback: number): number {
  return Math.max(1, parseIntOr(raw, fallback));
}

function normalizeAfter(raw: string | null, fallback: number): number {
  return Math.max(0, parseIntOr(raw, fallback));
}

function normalizeRoom(raw: string | null): string {
  return (raw ?? DEFAULT_ROOM).trim();
}

function deriveRoomFromIncomingRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(INCOMING_TRIGGER_REF_PREFIX)) {
    return DEFAULT_ROOM;
  }
  const suffix = trimmed.slice(INCOMING_TRIGGER_REF_PREFIX.length).trim();
  if (suffix.length === 0) return DEFAULT_ROOM;
  const first = suffix.split('/')[0].trim();
  if (!isValidRoomName(first)) return DEFAULT_ROOM;
  return first;
}

function generateRelayNodeId(): string {
  const prefix = 'relay-';
  const random = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  return `${prefix}${random}`;
}

function normalizeRelayNodeId(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value.length > 0 && NODE_ID_PATTERN.test(value)) {
    return value;
  }
  return generateRelayNodeId();
}

function normalizePeerRelayUrls(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const dedupe = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    dedupe.add(trimmed);
  }
  return [...dedupe];
}

function isValidRoomName(room: string): boolean {
  return ROOM_NAME_PATTERN.test(room);
}

function isValidTopic(topic: string): boolean {
  return TOPIC_PATTERN.test(topic);
}

function invalidRoomResponse(): Response {
  return Response.json({ ok: false, error: 'invalid room' }, { status: 400 });
}

function healthResponse(): Response {
  return Response.json({ status: 'ok', service: 'bit-relay' }, { status: 200 });
}

function notFoundResponse(): Response {
  return Response.json({ ok: false, error: 'not found' }, { status: 404 });
}

function methodNotAllowedResponse(): Response {
  return Response.json({ ok: false, error: 'method not allowed' }, { status: 405 });
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer',
    },
  });
}

function toErrorResponse(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function normalizeAuthToken(raw: string | undefined): string {
  return (raw ?? '').trim();
}

function extractPresentedToken(request: Request): string {
  const auth = (request.headers.get('authorization') ?? '').trim();
  if (auth.length === 0) return '';
  if (/^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, '').trim();
  }
  return auth;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function shouldRequireAuth(pathname: string): boolean {
  if (pathname === '/api/v1/github/webhook') return false;
  return pathname === '/ws' || pathname.startsWith('/api/v1/');
}

function parseRoomTokens(raw: Record<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const [room, token] of Object.entries(raw)) {
    const normalizedRoom = room.trim();
    const normalizedToken = token.trim();
    if (!isValidRoomName(normalizedRoom)) continue;
    if (normalizedToken.length === 0) continue;
    out.set(normalizedRoom, normalizedToken);
  }
  return out;
}

function readRoomToken(request: Request): string {
  const url = new URL(request.url);
  const query = (url.searchParams.get('room_token') ?? '').trim();
  if (query.length > 0) return query;
  return (request.headers.get('x-room-token') ?? '').trim();
}

function normalizePublishPayload(parsed: JsonValue): JsonValue {
  if (!isObjectRecord(parsed)) return parsed;
  const asObject = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(asObject, 'payload')) {
    return parsed;
  }
  const payload = asObject.payload;
  if (!isJsonValue(payload)) {
    return parsed;
  }
  const keys = Object.keys(asObject).filter((key) => key !== 'auth');
  const hasKind = typeof asObject.kind === 'string';
  if (!hasKind || (keys.length === 1 && keys[0] === 'payload')) {
    return payload;
  }
  return parsed;
}

function sanitizeEnvelope(envelope: Envelope): JsonObject {
  return {
    room: envelope.room,
    id: envelope.id,
    sender: envelope.sender,
    topic: envelope.topic,
    payload: envelope.payload,
  };
}

function isIssueTopic(topic: string): boolean {
  return topic === 'issue' || topic.startsWith('issue.');
}

function parseEnvelopeRecord(parsed: unknown): Envelope | null {
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
  if (!isValidRoomName(room)) return null;
  if (!isValidTopic(topic)) return null;
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

function parseCachedIssueEnvelope(value: CacheStoreObject): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(value.body));
  } catch {
    return null;
  }
  return parseEnvelopeRecord(parsed);
}

function issueEventStorageKey(room: string, cursor: number, envelopeId: string): string {
  const padded = String(Math.max(0, Math.trunc(cursor))).padStart(ISSUE_CURSOR_PAD_WIDTH, '0');
  return `${ISSUE_EVENT_KEY_PREFIX}${room}/${padded}-${envelopeId}`;
}

function issueSnapshotStorageKey(room: string, issueId: string): string {
  return `${ISSUE_SNAPSHOT_KEY_PREFIX}${room}/${issueId}`;
}

function issueCursorStorageKey(room: string): string {
  return `${ISSUE_CURSOR_KEY_PREFIX}${room}`;
}

function parseIssueEventCursorFromKey(room: string, key: string): number | null {
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

function extractIssueIdFromEnvelope(envelope: Envelope): string {
  const fromPayload = parseIssuePayloadIssueId(envelope.payload);
  if (fromPayload) return fromPayload;
  return envelope.id;
}

function deriveIssueAction(envelope: Envelope): string {
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

function parseIssueCacheEventRecord(value: CacheStoreObject): IssueCacheEventRecord | null {
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
  const envelope = parseEnvelopeRecord(parsed.envelope);
  if (!envelope) return null;
  if (!isValidRoomName(room)) return null;
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

function parseIssueCacheSnapshotRecord(value: CacheStoreObject): IssueCacheSnapshotRecord | null {
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
  const envelope = parseEnvelopeRecord(parsed.envelope);
  if (!envelope) return null;
  if (!isValidRoomName(room)) return null;
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

function parseIssueCacheCursorRecord(value: CacheStoreObject): IssueCacheCursorRecord | null {
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)),
  );
  return bytesToHex(signature);
}

function parseGitHubSignatureHeader(value: string): string | null {
  const trimmed = value.trim();
  const matched = trimmed.match(/^sha256=([a-fA-F0-9]{64})$/);
  if (!matched) return null;
  return matched[1].toLowerCase();
}

function normalizeGitHubRoomName(repositoryFullName: string | null): string {
  const normalized = (repositoryFullName ?? '').trim().replaceAll('/', '-');
  if (isValidRoomName(normalized)) return normalized;
  return DEFAULT_ROOM;
}

function readGitHubRepositoryFullName(payload: Record<string, unknown>): string | null {
  if (!isObjectRecord(payload.repository)) return null;
  const fullName = typeof payload.repository.full_name === 'string'
    ? payload.repository.full_name.trim()
    : '';
  return fullName.length > 0 ? fullName : null;
}

function readGitHubIssueNumber(payload: Record<string, unknown>): number | null {
  if (!isObjectRecord(payload.issue)) return null;
  const raw = payload.issue.number;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const value = Math.trunc(raw);
  return value > 0 ? value : null;
}

function readGitHubIssueUpdatedAtMs(payload: Record<string, unknown>): number | null {
  if (!isObjectRecord(payload.issue)) return null;
  if (typeof payload.issue.updated_at !== 'string') return null;
  const updatedAt = payload.issue.updated_at.trim();
  if (updatedAt.length === 0) return null;
  const epochMs = Date.parse(updatedAt);
  if (!Number.isFinite(epochMs)) return null;
  const normalized = Math.trunc(epochMs);
  return normalized >= 0 ? normalized : null;
}

function readGitHubSender(payload: Record<string, unknown>): string {
  if (isObjectRecord(payload.sender) && typeof payload.sender.login === 'string') {
    const login = payload.sender.login.trim();
    if (login.length > 0) return `github:${login}`;
  }
  return 'github:webhook';
}

function mapGitHubWebhookTopic(event: string, action: string): string | null {
  if (event === 'issues') {
    if (action === 'opened' || action === 'reopened') {
      return action === 'opened' ? 'issue' : 'issue.reopened';
    }
    if (action === 'edited') return 'issue.updated';
    if (action === 'closed') return 'issue.closed';
    if (action === 'labeled' || action === 'unlabeled') return 'issue.label';
    if (action.length > 0) {
      const candidate = `issue.${action.toLowerCase().replaceAll(/[^a-z0-9._-]/g, '_')}`;
      return isValidTopic(candidate) ? candidate : null;
    }
    return 'issue';
  }

  if (event === 'issue_comment') {
    const suffix = (action.length > 0 ? action : 'created').toLowerCase().replaceAll(
      /[^a-z0-9._-]/g,
      '_',
    );
    const candidate = `issue.comment.${suffix}`;
    return isValidTopic(candidate) ? candidate : null;
  }

  if (event === 'label') {
    return 'issue.label';
  }

  return null;
}

function buildGitHubIssueId(
  repositoryFullName: string | null,
  issueNumber: number | null,
  deliveryId: string,
): string {
  if (repositoryFullName && issueNumber) {
    return `${repositoryFullName}#${issueNumber}`;
  }
  if (issueNumber) {
    return `issue#${issueNumber}`;
  }
  return `delivery:${deliveryId}`;
}

function buildGitHubIssuePayload(args: {
  deliveryId: string;
  event: string;
  action: string;
  issueId: string;
  repositoryFullName: string | null;
  parsed: Record<string, unknown>;
}): JsonObject {
  const payload: JsonObject = {
    source: 'github',
    delivery_id: args.deliveryId,
    event: args.event,
    action: args.action,
    issue_id: args.issueId,
    repository: args.repositoryFullName ?? '',
  };

  if (isObjectRecord(args.parsed.issue)) {
    const issue = args.parsed.issue;
    payload.issue = {
      number: typeof issue.number === 'number' ? Math.trunc(issue.number) : 0,
      title: typeof issue.title === 'string' ? issue.title : '',
      state: typeof issue.state === 'string' ? issue.state : '',
      html_url: typeof issue.html_url === 'string' ? issue.html_url : '',
      updated_at: typeof issue.updated_at === 'string' ? issue.updated_at : '',
    };
  }

  if (isObjectRecord(args.parsed.comment)) {
    const comment = args.parsed.comment;
    payload.comment = {
      id: typeof comment.id === 'number' ? Math.trunc(comment.id) : 0,
      body: typeof comment.body === 'string' ? comment.body : '',
      html_url: typeof comment.html_url === 'string' ? comment.html_url : '',
    };
  }

  if (isObjectRecord(args.parsed.label)) {
    const label = args.parsed.label;
    payload.label = {
      name: typeof label.name === 'string' ? label.name : '',
      color: typeof label.color === 'string' ? label.color : '',
    };
  }

  return payload;
}

function parseIssueSourceUpdatedAtMs(payload: JsonValue): number | null {
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

function parseAckIds(
  requestText: string,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestText);
  } catch {
    return { ok: false, error: 'invalid json payload' };
  }
  if (!isObjectRecord(parsed)) {
    return { ok: false, error: 'invalid json payload' };
  }

  const ids: string[] = [];
  const single = parsed.id;
  if (typeof single === 'string') {
    const trimmed = single.trim();
    if (trimmed.length > 0) {
      ids.push(trimmed);
    }
  }

  const many = parsed.ids;
  if (Array.isArray(many)) {
    for (const item of many) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed.length === 0) continue;
      if (!ids.includes(trimmed)) {
        ids.push(trimmed);
      }
    }
  }

  if (ids.length === 0) {
    return { ok: false, error: 'missing field: ids' };
  }
  return { ok: true, ids };
}

function parsePublishAuthHeaders(
  request: Request,
): { ok: true; auth: PublishAuthHeaders | null } | { ok: false; status: number; error: string } {
  const publicKey = (request.headers.get('x-relay-public-key') ?? '').trim();
  const signature = (request.headers.get('x-relay-signature') ?? '').trim();
  const timestampRaw = (request.headers.get('x-relay-timestamp') ?? '').trim();
  const nonce = (request.headers.get('x-relay-nonce') ?? '').trim();

  const hasAny = publicKey.length > 0 || signature.length > 0 || timestampRaw.length > 0 ||
    nonce.length > 0;
  if (!hasAny) {
    return { ok: true, auth: null };
  }

  if (
    publicKey.length === 0 ||
    signature.length === 0 ||
    timestampRaw.length === 0 ||
    nonce.length === 0
  ) {
    return { ok: false, status: 400, error: 'incomplete signature headers' };
  }

  if (!isLikelyBase64Url(publicKey) || !isLikelyBase64Url(signature)) {
    return { ok: false, status: 400, error: 'invalid signature headers' };
  }

  const timestampSec = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
    return { ok: false, status: 400, error: 'invalid signature timestamp' };
  }

  if (nonce.length > 256) {
    return { ok: false, status: 400, error: 'invalid nonce' };
  }

  return {
    ok: true,
    auth: {
      publicKey,
      signature,
      timestampSec,
      nonce,
    },
  };
}

function fallbackRateLimit(
  entry: RateCounter | undefined,
  now: number,
  max: number,
  windowMs: number,
): { next: RateCounter; allowed: boolean } {
  const shouldReset = !entry || now - entry.windowStart >= windowMs;
  const next = shouldReset
    ? { count: 1, windowStart: now }
    : { count: entry.count + 1, windowStart: entry.windowStart };
  return { next, allowed: next.count <= max };
}

function jsonByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function createRoomState(): RoomState {
  return {
    messages: [],
    acksByConsumer: new Map(),
    sessions: new Map(),
    presenceByParticipant: new Map(),
    reviewsByPr: new Map(),
  };
}

function getOrCreateRoomState(rooms: Map<string, RoomState>, room: string): RoomState {
  const found = rooms.get(room);
  if (found) return found;
  const created = createRoomState();
  rooms.set(room, created);
  return created;
}

function publishIntoRoom(
  roomState: RoomState,
  room: string,
  sender: string,
  topic: string,
  id: string,
  signature: string,
  payload: JsonValue,
  maxMessagesPerRoom: number,
): PublishResult {
  if (!isValidTopic(topic)) {
    return {
      status: 400,
      body: { ok: false, error: `invalid topic: ${topic}` },
      changed: false,
      envelope: null,
    };
  }

  if (roomState.messages.some((item) => item.id === id)) {
    return {
      status: 200,
      body: { ok: true, accepted: false, cursor: roomState.messages.length },
      changed: false,
      envelope: null,
    };
  }

  const envelope: Envelope = {
    room,
    id,
    sender,
    topic,
    payload,
    signature: signature.trim().length > 0 ? signature.trim() : null,
  };
  roomState.messages.push(envelope);

  if (roomState.messages.length > maxMessagesPerRoom) {
    const overflow = roomState.messages.length - maxMessagesPerRoom;
    roomState.messages.splice(0, overflow);
  }

  return {
    status: 200,
    body: { ok: true, accepted: true, cursor: roomState.messages.length },
    changed: true,
    envelope,
  };
}

function pollFromRoom(
  roomState: RoomState,
  room: string,
  after: number,
  limit: number,
): JsonObject {
  const page = roomState.messages.slice(after, after + limit).map((item) => sanitizeEnvelope(item));
  return {
    ok: true,
    room,
    next_cursor: after + page.length,
    envelopes: page,
  };
}

function findEnvelopeById(roomState: RoomState, id: string): Envelope | null {
  for (const item of roomState.messages) {
    if (item.id === id) return item;
  }
  return null;
}

function toCacheExchangeEntryEnvelope(entry: {
  room: string;
  id: string;
  sender: string;
  topic: string;
  payload: JsonValue;
  signature: string | null;
}): Envelope {
  return {
    room: entry.room,
    id: entry.id,
    sender: entry.sender,
    topic: entry.topic,
    payload: entry.payload,
    signature: entry.signature,
  };
}

function inboxPendingFromRoom(
  roomState: RoomState,
  room: string,
  consumer: string,
  limit: number,
): JsonObject {
  const acked = roomState.acksByConsumer.get(consumer) ?? new Set<string>();
  const pending = roomState.messages.filter((item) => !acked.has(item.id));
  const page = pending.slice(0, limit).map((item) => sanitizeEnvelope(item));
  return {
    ok: true,
    room,
    consumer,
    pending_count: pending.length,
    returned_count: page.length,
    envelopes: page,
  };
}

function ackIntoRoom(
  roomState: RoomState,
  room: string,
  consumer: string,
  requestText: string,
): AckResult {
  const parsed = parseAckIds(requestText);
  if (!parsed.ok) {
    return {
      status: 400,
      body: { ok: false, error: parsed.error },
    };
  }

  let ackSet = roomState.acksByConsumer.get(consumer);
  if (!ackSet) {
    ackSet = new Set<string>();
    roomState.acksByConsumer.set(consumer, ackSet);
  }

  let newlyAcked = 0;
  for (const id of parsed.ids) {
    if (ackSet.has(id)) continue;
    ackSet.add(id);
    newlyAcked += 1;
  }

  return {
    status: 200,
    body: {
      ok: true,
      room,
      consumer,
      newly_acked: newlyAcked,
      acked_total: ackSet.size,
      requested_count: parsed.ids.length,
    },
  };
}

function subscribeSocket(
  roomState: RoomState,
  socket: WebSocket,
  wsPingIntervalMs: number,
  wsIdleTimeoutMs: number,
): void {
  roomState.sessions.set(socket, { lastActive: Date.now() });

  const readyMessage = JSON.stringify({
    type: 'ready',
    keepalive: {
      ping_interval_ms: wsPingIntervalMs,
      idle_timeout_ms: wsIdleTimeoutMs,
    },
  });

  if (socket.readyState === WS_OPEN_STATE) {
    socket.send(readyMessage);
  } else {
    socket.addEventListener('open', () => {
      socket.send(readyMessage);
    }, { once: true });
  }

  socket.addEventListener('message', (event) => {
    const meta = roomState.sessions.get(socket);
    if (meta) {
      meta.lastActive = Date.now();
    }
    try {
      const parsed = JSON.parse(String(event.data));
      if (parsed?.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
      // 'pong' responses from client are handled implicitly via lastActive update above
    } catch {
      // ignore malformed client payloads
    }
  });

  socket.addEventListener('close', () => {
    roomState.sessions.delete(socket);
  });
  socket.addEventListener('error', () => {
    roomState.sessions.delete(socket);
  });
}

function broadcastPublish(
  roomState: RoomState,
  room: string,
  envelope: Envelope,
  cursor: number,
): void {
  const message = JSON.stringify({
    type: envelope.topic,
    room,
    cursor,
    envelope: sanitizeEnvelope(envelope),
  });
  for (const socket of roomState.sessions.keys()) {
    if (socket.readyState !== WS_OPEN_STATE) continue;
    try {
      socket.send(message);
    } catch {
      roomState.sessions.delete(socket);
    }
  }
}

function prunePresence(roomState: RoomState, nowSec: number, ttlSec: number): void {
  for (const [id, record] of roomState.presenceByParticipant.entries()) {
    if (nowSec - record.lastHeartbeat >= ttlSec) {
      roomState.presenceByParticipant.delete(id);
    }
  }
}

function broadcastPresenceChange(
  roomState: RoomState,
  room: string,
  participant: string,
  status: string,
  metadata: JsonValue,
  event: string,
): void {
  const message = JSON.stringify({
    type: 'presence',
    room,
    participant,
    status,
    metadata,
    event,
  });
  for (const socket of roomState.sessions.keys()) {
    if (socket.readyState !== WS_OPEN_STATE) continue;
    try {
      socket.send(message);
    } catch {
      roomState.sessions.delete(socket);
    }
  }
}

function computeReviewStatus(
  reviews: Map<string, ReviewRecord>,
): { approve_count: number; deny_count: number; total: number; resolved: boolean } {
  let approve_count = 0;
  let deny_count = 0;
  for (const record of reviews.values()) {
    if (record.verdict === 'approve') approve_count++;
    else deny_count++;
  }
  const total = approve_count + deny_count;
  const resolved = total > 0 && approve_count / total >= 0.5;
  return { approve_count, deny_count, total, resolved };
}

function broadcastReviewChange(
  roomState: RoomState,
  room: string,
  prId: string,
  sender: string,
  verdict: string,
  event: string,
  resolved: boolean,
  approve_count: number,
  deny_count: number,
): void {
  const message = JSON.stringify({
    type: 'review',
    room,
    pr_id: prId,
    sender,
    verdict,
    event,
    resolved,
    approve_count,
    deny_count,
  });
  for (const socket of roomState.sessions.keys()) {
    if (socket.readyState !== WS_OPEN_STATE) continue;
    try {
      socket.send(message);
    } catch {
      roomState.sessions.delete(socket);
    }
  }
}

function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

function parseBoolOrDefault(raw: boolean | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'boolean') return fallback;
  return raw;
}

export function createMemoryRelayService(options: MemoryRelayOptions = {}): MemoryRelayService {
  const authToken = normalizeAuthToken(options.authToken);
  const roomTokens = parseRoomTokens(options.roomTokens);
  const maxMessagesPerRoom = Math.max(
    1,
    Math.trunc(options.maxMessagesPerRoom ?? DEFAULT_MAX_MESSAGES_PER_ROOM),
  );
  const publishPayloadMaxBytes = Math.max(
    1,
    Math.trunc(options.publishPayloadMaxBytes ?? DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES),
  );
  const publishLimitPerWindow = Math.max(
    1,
    Math.trunc(options.publishLimitPerWindow ?? DEFAULT_PUBLISH_LIMIT_PER_WINDOW),
  );
  const publishWindowMs = Math.max(
    1,
    Math.trunc(options.publishWindowMs ?? DEFAULT_PUBLISH_WINDOW_MS),
  );
  const ipPublishLimitPerWindow = Math.max(
    1,
    Math.trunc(options.ipPublishLimitPerWindow ?? DEFAULT_IP_PUBLISH_LIMIT_PER_WINDOW),
  );
  const roomPublishLimitPerWindow = Math.max(
    1,
    Math.trunc(options.roomPublishLimitPerWindow ?? DEFAULT_ROOM_PUBLISH_LIMIT_PER_WINDOW),
  );
  const maxWsSessions = Math.max(1, Math.trunc(options.maxWsSessions ?? DEFAULT_MAX_WS_SESSIONS));
  const requireSignatures = parseBoolOrDefault(
    options.requireSignatures,
    DEFAULT_REQUIRE_SIGNATURES,
  );
  const maxClockSkewSec = Math.max(
    1,
    Math.trunc(options.maxClockSkewSec ?? DEFAULT_MAX_CLOCK_SKEW_SEC),
  );
  const nonceTtlSec = Math.max(1, Math.trunc(options.nonceTtlSec ?? DEFAULT_NONCE_TTL_SEC));
  const maxNoncesPerSender = Math.max(
    1,
    Math.trunc(options.maxNoncesPerSender ?? DEFAULT_MAX_NONCES_PER_SENDER),
  );
  const presenceTtlSec = Math.max(
    1,
    Math.trunc(options.presenceTtlSec ?? DEFAULT_PRESENCE_TTL_SEC),
  );
  const wsPingIntervalMs = Math.max(
    1000,
    Math.trunc(options.wsPingIntervalMs ?? DEFAULT_WS_PING_INTERVAL_MS),
  );
  const wsIdleTimeoutMs = Math.max(
    wsPingIntervalMs + 1000,
    Math.trunc(options.wsIdleTimeoutMs ?? DEFAULT_WS_IDLE_TIMEOUT_MS),
  );
  const relayNodeId = normalizeRelayNodeId(options.relayNodeId);
  const peerRelayUrls = normalizePeerRelayUrls(options.peerRelayUrls);
  const cacheExchangeMaxHops = Math.max(
    1,
    Math.trunc(options.cacheExchangeMaxHops ?? DEFAULT_CACHE_EXCHANGE_MAX_HOPS),
  );
  const cacheExchangeMaxRecords = Math.max(
    1,
    Math.trunc(options.cacheExchangeMaxRecords ?? DEFAULT_CACHE_EXCHANGE_MAX_RECORDS),
  );
  const cacheStore = options.cacheStore ?? null;
  const githubWebhookSecret = (options.githubWebhookSecret ?? '').trim();
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const rooms = new Map<string, RoomState>();
  const senderRateCounts = new Map<string, RateCounter>();
  const ipRateCounts = new Map<string, RateCounter>();
  const roomRateCounts = new Map<string, RateCounter>();
  const keyRegistry = new Map<string, KeyRecord>();
  const noncesBySender = new Map<string, Map<string, number>>();
  const cacheExchangeRecords: CacheExchangeRecord[] = [];
  const issueCursorByRoom = new Map<string, number>();
  let cacheExchangeCursor = 0;
  let lastReapAt = Date.now();

  function appendCacheExchangeRecord(record: CacheExchangeRecord): void {
    cacheExchangeRecords.push(record);
    if (cacheExchangeRecords.length > cacheExchangeMaxRecords) {
      const overflow = cacheExchangeRecords.length - cacheExchangeMaxRecords;
      cacheExchangeRecords.splice(0, overflow);
    }
  }

  function recordCacheExchange(
    envelope: Envelope,
    origin: string,
    hopCount: number,
    maxHops: number,
  ): void {
    cacheExchangeCursor += 1;
    appendCacheExchangeRecord({
      cursor: cacheExchangeCursor,
      envelope,
      origin,
      hopCount,
      maxHops,
    });
  }
  const githubIssueSync = createIssueSyncEngine({
    maxDeliveryIds: MAX_GITHUB_WEBHOOK_DELIVERY_IDS,
    maxDlqEntries: MAX_GITHUB_WEBHOOK_DLQ_ENTRIES,
    retryBaseSec: GITHUB_WEBHOOK_RETRY_BASE_SEC,
    nowSec: nowEpochSec,
  });

  async function putCacheJsonObject(args: {
    kind: 'issue' | 'object';
    key: string;
    room: string;
    ref: string;
    value: unknown;
    updatedAt: number;
  }): Promise<void> {
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
    const parsed = parseIssueCacheCursorRecord(cached);
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
    envelope: Envelope,
    roomCursorHint?: number,
  ): Promise<void> {
    if (!cacheStore) return;
    const issueId = extractIssueIdFromEnvelope(envelope);
    const issueCursor = await nextIssueCursor(envelope.room, roomCursorHint);
    const updatedAt = nowEpochSec();
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
        const parsed = parseIssueCacheSnapshotRecord(existing);
        if (
          parsed &&
          parsed.source_updated_at_ms !== null &&
          sourceUpdatedAtMs !== null &&
          sourceUpdatedAtMs < parsed.source_updated_at_ms
        ) {
          shouldUpdateSnapshot = false;
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

  async function persistEnvelopeToCache(
    envelope: Envelope,
    roomCursorHint?: number,
  ): Promise<void> {
    if (!cacheStore) return;
    const kind = isIssueTopic(envelope.topic) ? 'issue' : 'object';
    const key = `${envelope.room}/${envelope.id}`;
    const updatedAt = nowEpochSec();
    try {
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
    } catch {
      // Cache failures should not affect relay publish availability.
    }
  }

  function reapDeadConnections(): void {
    const now = Date.now();
    const pingMessage = JSON.stringify({ type: 'ping' });
    for (const roomState of rooms.values()) {
      for (const [socket, meta] of roomState.sessions.entries()) {
        if (socket.readyState !== WS_OPEN_STATE) {
          roomState.sessions.delete(socket);
          continue;
        }
        if (now - meta.lastActive >= wsIdleTimeoutMs) {
          try {
            socket.close(1001, 'idle timeout');
          } catch {
            // ignore
          }
          roomState.sessions.delete(socket);
          continue;
        }
        try {
          socket.send(pingMessage);
        } catch {
          roomState.sessions.delete(socket);
        }
      }
    }
    lastReapAt = now;
  }

  const enableReapInterval = options.wsPingIntervalMs !== undefined &&
    typeof setInterval !== 'undefined';
  const reapIntervalId = enableReapInterval
    ? setInterval(reapDeadConnections, wsPingIntervalMs)
    : null;

  function pruneSenderNonces(sender: string, nowSec: number): Map<string, number> {
    const map = noncesBySender.get(sender) ?? new Map<string, number>();
    if (!noncesBySender.has(sender)) {
      noncesBySender.set(sender, map);
    }
    for (const [nonce, ts] of map.entries()) {
      if (nowSec - ts > nonceTtlSec) {
        map.delete(nonce);
      }
    }
    while (map.size > maxNoncesPerSender) {
      const first = map.keys().next();
      if (first.done) break;
      map.delete(first.value);
    }
    return map;
  }

  function isReplayNonce(sender: string, nonce: string, nowSec: number): boolean {
    const map = pruneSenderNonces(sender, nowSec);
    return map.has(nonce);
  }

  function rememberNonce(sender: string, nonce: string, ts: number, nowSec: number): void {
    const map = pruneSenderNonces(sender, nowSec);
    map.set(nonce, ts);
    while (map.size > maxNoncesPerSender) {
      const first = map.keys().next();
      if (first.done) break;
      map.delete(first.value);
    }
  }

  function ensureTofuKey(sender: string, publicKey: string, nowSec: number): Response | null {
    const record = keyRegistry.get(sender);
    if (!record) {
      keyRegistry.set(sender, {
        publicKey,
        status: 'active',
        firstSeenAt: nowSec,
        lastSeenAt: nowSec,
        rotatedAt: null,
        revokedAt: null,
        githubUsername: null,
        githubVerifiedAt: null,
      });
      return null;
    }

    if (record.status !== 'active') {
      return toErrorResponse('sender key revoked', 403);
    }

    if (!timingSafeEqual(record.publicKey, publicKey)) {
      return toErrorResponse('sender key mismatch', 409);
    }

    record.lastSeenAt = nowSec;
    return null;
  }

  async function handleSignatureVerification(args: {
    request: Request;
    sender: string;
    room: string;
    id: string;
    topic: string;
    payload: JsonValue;
  }): Promise<Response | { signature: string | null }> {
    const authParsed = parsePublishAuthHeaders(args.request);
    if (!authParsed.ok) {
      return toErrorResponse(authParsed.error, authParsed.status);
    }

    if (!authParsed.auth) {
      if (requireSignatures) {
        return toErrorResponse('missing signature headers', 401);
      }
      return { signature: null };
    }

    const auth = authParsed.auth;
    const nowSec = nowEpochSec();
    if (Math.abs(nowSec - auth.timestampSec) > maxClockSkewSec) {
      return toErrorResponse('stale signature timestamp', 401);
    }

    if (isReplayNonce(args.sender, auth.nonce, nowSec)) {
      return toErrorResponse('replayed nonce', 409);
    }

    const payloadHash = await sha256Hex(canonicalizeJson(args.payload));
    const signingMessage = buildPublishSigningMessage({
      sender: args.sender,
      room: args.room,
      id: args.id,
      topic: args.topic,
      ts: auth.timestampSec,
      nonce: auth.nonce,
      payloadHash,
    });

    const verified = await verifyEd25519Signature(
      auth.publicKey,
      signingMessage,
      auth.signature,
    );
    if (!verified) {
      return toErrorResponse('invalid signature', 401);
    }

    const tofuError = ensureTofuKey(args.sender, auth.publicKey, nowSec);
    if (tofuError) {
      return tofuError;
    }

    rememberNonce(args.sender, auth.nonce, auth.timestampSec, nowSec);
    return { signature: auth.signature };
  }

  function checkRoomToken(request: Request, room: string): Response | null {
    const expected = roomTokens.get(room);
    if (!expected) return null;
    const provided = readRoomToken(request);
    if (provided.length === 0 || !timingSafeEqual(provided, expected)) {
      return toErrorResponse('forbidden', 403);
    }
    return null;
  }

  function handleCacheExchangeDiscovery(request: Request): Response {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse();
    }
    return Response.json({
      ok: true,
      protocol: 'cache.exchange.v1',
      node_id: relayNodeId,
      peers: peerRelayUrls,
      max_hops: cacheExchangeMaxHops,
    }, { status: 200 });
  }

  function handleCacheExchangePull(request: Request, url: URL): Response {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse();
    }
    const after = normalizeAfter(url.searchParams.get('after'), 0);
    const limit = normalizeLimit(url.searchParams.get('limit'), 100);
    const peerRaw = (url.searchParams.get('peer') ?? '').trim();
    const peer = peerRaw.length > 0 ? peerRaw : null;
    const roomRaw = (url.searchParams.get('room') ?? '').trim();
    const room = roomRaw.length > 0 ? roomRaw : null;
    if (room && !isValidRoomName(room)) {
      return invalidRoomResponse();
    }
    if (room) {
      const roomTokenError = checkRoomToken(request, room);
      if (roomTokenError) return roomTokenError;
    }

    const result = selectCacheExchangeEntries(cacheExchangeRecords, {
      after,
      limit,
      peer,
      room,
    });

    return Response.json(
      {
        ok: true,
        protocol: 'cache.exchange.v1',
        node_id: relayNodeId,
        next_cursor: result.nextCursor,
        returned_count: result.entries.length,
        entries: result.entries,
      },
      { status: 200 },
    );
  }

  async function handleCacheExchangePush(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return methodNotAllowedResponse();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      return toErrorResponse('invalid json payload', 400);
    }
    if (!isObjectRecord(parsed)) {
      return toErrorResponse('invalid json payload', 400);
    }
    if (!Array.isArray(parsed.entries)) {
      return toErrorResponse('missing field: entries', 400);
    }

    let accepted = 0;
    let duplicates = 0;
    let conflicts = 0;
    let rejected = 0;
    const rejectionCounts: Partial<Record<CacheExchangeRejectionReason, number>> = {};

    const reject = (reason: CacheExchangeRejectionReason): void => {
      rejected += 1;
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    };

    for (let i = 0; i < parsed.entries.length; i += 1) {
      const entryResult = parseIncomingCacheExchangeEntry(parsed.entries[i], cacheExchangeMaxHops);
      if (!entryResult.ok) {
        return toErrorResponse(`invalid entry at index ${i}: ${entryResult.error}`, 400);
      }
      const incoming = entryResult.entry;
      if (!isValidRoomName(incoming.room)) {
        reject('invalid_room');
        continue;
      }
      if (!isValidTopic(incoming.topic)) {
        reject('invalid_topic');
        continue;
      }
      const roomTokenError = checkRoomToken(request, incoming.room);
      if (roomTokenError) {
        return roomTokenError;
      }
      if (incoming.origin === relayNodeId) {
        reject('loop_origin');
        continue;
      }
      if (incoming.hopCount >= incoming.maxHops) {
        reject('max_hops_reached');
        continue;
      }

      const roomState = getOrCreateRoomState(rooms, incoming.room);
      const existing = findEnvelopeById(roomState, incoming.id);
      const incomingEnvelope = toCacheExchangeEntryEnvelope({
        room: incoming.room,
        id: incoming.id,
        sender: incoming.sender,
        topic: incoming.topic,
        payload: incoming.payload,
        signature: incoming.signature,
      });

      if (existing) {
        const collision = classifyCacheExchangeCollision(existing, incomingEnvelope);
        if (collision === 'duplicate') duplicates += 1;
        else conflicts += 1;
        continue;
      }

      const result = publishIntoRoom(
        roomState,
        incoming.room,
        incoming.sender,
        incoming.topic,
        incoming.id,
        incoming.signature ?? '',
        incoming.payload,
        maxMessagesPerRoom,
      );

      if (
        result.changed &&
        result.status === 200 &&
        result.envelope &&
        result.body.accepted === true &&
        typeof result.body.cursor === 'number'
      ) {
        accepted += 1;
        broadcastPublish(roomState, incoming.room, result.envelope, result.body.cursor as number);
        recordCacheExchange(result.envelope, incoming.origin, incoming.hopCount, incoming.maxHops);
        await persistEnvelopeToCache(result.envelope, result.body.cursor as number);
        continue;
      }

      if (result.status === 200) {
        duplicates += 1;
      } else {
        reject('invalid_topic');
      }
    }

    return Response.json(
      {
        ok: true,
        protocol: 'cache.exchange.v1',
        node_id: relayNodeId,
        accepted,
        duplicates,
        conflicts,
        rejected,
        rejection_counts: rejectionCounts,
        next_cursor: cacheExchangeCursor,
      },
      { status: 200 },
    );
  }

  async function loadIssueEventsFromCache(
    room: string,
    after: number,
    limit: number,
  ): Promise<{ events: IssueCacheEventRecord[]; nextCursor: number }> {
    if (!cacheStore) {
      return { events: [], nextCursor: after };
    }
    const prefix = `${ISSUE_EVENT_KEY_PREFIX}${room}/`;
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
        const record = parseIssueCacheEventRecord(cached);
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
    const prefix = `${ISSUE_SNAPSHOT_KEY_PREFIX}${room}/`;
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
        const record = parseIssueCacheSnapshotRecord(cached);
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

  async function handleCacheIssueSync(request: Request, url: URL): Promise<Response> {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse();
    }
    const room = normalizeRoom(url.searchParams.get('room'));
    if (!isValidRoomName(room)) {
      return invalidRoomResponse();
    }
    const roomTokenError = checkRoomToken(request, room);
    if (roomTokenError) return roomTokenError;

    const after = normalizeAfter(url.searchParams.get('after'), 0);
    const limit = normalizeLimit(url.searchParams.get('limit'), 100);
    const snapshotLimit = normalizeLimit(url.searchParams.get('snapshot_limit'), 100);
    if (!cacheStore) {
      return Response.json({
        ok: true,
        room,
        next_cursor: after,
        room_cursor: after,
        events: [],
        snapshots: [],
      }, { status: 200 });
    }

    try {
      const eventsResult = await loadIssueEventsFromCache(room, after, limit);
      const snapshots = await loadIssueSnapshotsFromCache(room, snapshotLimit);
      const roomCursor = await currentIssueCursor(room);
      return Response.json({
        ok: true,
        room,
        next_cursor: eventsResult.nextCursor,
        room_cursor: roomCursor,
        events: eventsResult.events.map((record) => ({
          cursor: record.cursor,
          issue_id: record.issue_id,
          action: record.action,
          source_updated_at_ms: record.source_updated_at_ms,
          updated_at: record.updated_at,
          envelope: sanitizeEnvelope(record.envelope),
        })),
        snapshots: snapshots.map((record) => ({
          issue_id: record.issue_id,
          last_cursor: record.last_cursor,
          source_updated_at_ms: record.source_updated_at_ms,
          updated_at: record.updated_at,
          envelope: sanitizeEnvelope(record.envelope),
        })),
      }, { status: 200 });
    } catch {
      return Response.json({
        ok: true,
        room,
        next_cursor: after,
        room_cursor: after,
        events: [],
        snapshots: [],
      }, { status: 200 });
    }
  }

  async function handleCacheIssuePull(request: Request, url: URL): Promise<Response> {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse();
    }
    const room = normalizeRoom(url.searchParams.get('room'));
    if (!isValidRoomName(room)) {
      return invalidRoomResponse();
    }
    const roomTokenError = checkRoomToken(request, room);
    if (roomTokenError) return roomTokenError;

    const after = normalizeAfter(url.searchParams.get('after'), 0);
    const limit = normalizeLimit(url.searchParams.get('limit'), 100);
    if (!cacheStore) {
      return Response.json({
        ok: true,
        room,
        next_cursor: after,
        envelopes: [],
      }, { status: 200 });
    }

    let listed: CacheStoreListResult;
    try {
      listed = await cacheStore.list({
        kind: 'issue',
        room,
        limit,
        cursor: String(after),
      });
    } catch {
      return Response.json({
        ok: true,
        room,
        next_cursor: after,
        envelopes: [],
      }, { status: 200 });
    }

    const envelopes: JsonObject[] = [];
    for (const entry of listed.entries) {
      let cached;
      try {
        cached = await cacheStore.get('issue', entry.key);
      } catch {
        continue;
      }
      if (!cached) continue;
      const envelope = parseCachedIssueEnvelope(cached);
      if (!envelope) continue;
      if (envelope.room !== room) continue;
      if (!isIssueTopic(envelope.topic)) continue;
      envelopes.push(sanitizeEnvelope(envelope));
    }

    const nextCursor = listed.cursor === null
      ? after + listed.entries.length
      : Number.parseInt(listed.cursor, 10);
    return Response.json({
      ok: true,
      room,
      next_cursor: Number.isFinite(nextCursor) ? nextCursor : after + listed.entries.length,
      envelopes,
    }, { status: 200 });
  }

  function handleWebSocket(request: Request, room: string): Response {
    const roomState = getOrCreateRoomState(rooms, room);

    const roomTokenError = checkRoomToken(request, room);
    if (roomTokenError) return roomTokenError;

    if (roomState.sessions.size >= maxWsSessions) {
      return toErrorResponse('too many connections', 503);
    }

    if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const maybePairCtor =
      (globalThis as { WebSocketPair?: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair;
    if (typeof maybePairCtor === 'function') {
      const pair = new maybePairCtor();
      const client = pair[0];
      const server = pair[1] as WebSocket & { accept(): void };
      server.accept();
      subscribeSocket(roomState, server, wsPingIntervalMs, wsIdleTimeoutMs);
      return new Response(
        null,
        { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket },
      );
    }

    type DenoLike = {
      upgradeWebSocket: (request: Request) => { response: Response; socket: WebSocket };
    };
    const maybeDeno = (globalThis as { Deno?: DenoLike }).Deno;
    if (maybeDeno && typeof maybeDeno.upgradeWebSocket === 'function') {
      const { response, socket } = maybeDeno.upgradeWebSocket(request);
      subscribeSocket(roomState, socket, wsPingIntervalMs, wsIdleTimeoutMs);
      return response;
    }

    return toErrorResponse('websocket unsupported in this runtime', 501);
  }

  function handleKeyInfo(request: Request): Response {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse();
    }
    const sender = (new URL(request.url).searchParams.get('sender') ?? '').trim();
    if (sender.length === 0) {
      return toErrorResponse('missing query: sender', 400);
    }
    const record = keyRegistry.get(sender);
    if (!record) {
      return toErrorResponse('sender key not found', 404);
    }
    return Response.json(
      {
        ok: true,
        sender,
        key: {
          public_key: record.publicKey,
          status: record.status,
          first_seen_at: record.firstSeenAt,
          last_seen_at: record.lastSeenAt,
          rotated_at: record.rotatedAt,
          revoked_at: record.revokedAt,
          github_username: record.githubUsername,
          github_verified_at: record.githubVerifiedAt,
        },
      },
      { status: 200 },
    );
  }

  async function handleKeyRotate(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return methodNotAllowedResponse();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      return toErrorResponse('invalid json payload', 400);
    }
    if (!isObjectRecord(parsed)) {
      return toErrorResponse('invalid json payload', 400);
    }

    const sender = (typeof parsed.sender === 'string' ? parsed.sender : '').trim();
    const newPublicKey = (typeof parsed.new_public_key === 'string' ? parsed.new_public_key : '')
      .trim();
    const ts = typeof parsed.ts === 'number'
      ? Math.trunc(parsed.ts)
      : typeof parsed.ts === 'string'
      ? Number.parseInt(parsed.ts, 10)
      : Number.NaN;
    const nonce = (typeof parsed.nonce === 'string' ? parsed.nonce : '').trim();
    const oldSignature = (typeof parsed.old_signature === 'string' ? parsed.old_signature : '')
      .trim();
    const newSignature = (typeof parsed.new_signature === 'string' ? parsed.new_signature : '')
      .trim();

    if (sender.length === 0) {
      return toErrorResponse('missing field: sender', 400);
    }
    if (newPublicKey.length === 0 || !isLikelyBase64Url(newPublicKey)) {
      return toErrorResponse('invalid field: new_public_key', 400);
    }
    if (!Number.isFinite(ts) || ts <= 0) {
      return toErrorResponse('invalid field: ts', 400);
    }
    if (nonce.length === 0 || nonce.length > 256) {
      return toErrorResponse('invalid field: nonce', 400);
    }
    if (
      oldSignature.length === 0 ||
      newSignature.length === 0 ||
      !isLikelyBase64Url(oldSignature) ||
      !isLikelyBase64Url(newSignature)
    ) {
      return toErrorResponse('invalid signature payload', 400);
    }

    const nowSec = nowEpochSec();
    if (Math.abs(nowSec - ts) > maxClockSkewSec) {
      return toErrorResponse('stale signature timestamp', 401);
    }
    if (isReplayNonce(sender, nonce, nowSec)) {
      return toErrorResponse('replayed nonce', 409);
    }

    const record = keyRegistry.get(sender);
    if (!record) {
      return toErrorResponse('sender key not found', 404);
    }
    if (record.status !== 'active') {
      return toErrorResponse('sender key revoked', 403);
    }

    const message = buildRotateSigningMessage({ sender, newPublicKey, ts, nonce });
    const [verifiedOld, verifiedNew] = await Promise.all([
      verifyEd25519Signature(record.publicKey, message, oldSignature),
      verifyEd25519Signature(newPublicKey, message, newSignature),
    ]);
    if (!verifiedOld) {
      return toErrorResponse('invalid old signature', 401);
    }
    if (!verifiedNew) {
      return toErrorResponse('invalid new signature', 401);
    }

    record.publicKey = newPublicKey;
    record.rotatedAt = nowSec;
    record.lastSeenAt = nowSec;
    record.githubUsername = null;
    record.githubVerifiedAt = null;
    rememberNonce(sender, nonce, ts, nowSec);

    return Response.json(
      {
        ok: true,
        sender,
        public_key: newPublicKey,
        rotated_at: nowSec,
      },
      { status: 200 },
    );
  }

  async function handleKeyVerifyGitHub(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return methodNotAllowedResponse();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      return toErrorResponse('invalid json payload', 400);
    }
    if (!isObjectRecord(parsed)) {
      return toErrorResponse('invalid json payload', 400);
    }

    const sender = (typeof parsed.sender === 'string' ? parsed.sender : '').trim();
    const githubUsername =
      (typeof parsed.github_username === 'string' ? parsed.github_username : '').trim();

    if (sender.length === 0) {
      return toErrorResponse('missing field: sender', 400);
    }
    if (githubUsername.length === 0) {
      return toErrorResponse('missing field: github_username', 400);
    }
    if (sender !== githubUsername) {
      return toErrorResponse('sender must match github_username', 400);
    }

    const record = keyRegistry.get(sender);
    if (!record) {
      return toErrorResponse('sender key not found', 404);
    }

    const fetchResult = await fetchGitHubEd25519Keys(githubUsername, fetchFn);
    if (!fetchResult.ok) {
      return toErrorResponse(
        `github key fetch failed: ${fetchResult.error}`,
        502,
      );
    }

    const matched = matchesGitHubKey(record.publicKey, fetchResult.keys);
    if (!matched) {
      return Response.json(
        {
          ok: false,
          verified: false,
          error: 'key not found in github keys',
          sender,
          github_username: githubUsername,
        },
        { status: 200 },
      );
    }

    const nowSec = nowEpochSec();
    record.githubUsername = githubUsername;
    record.githubVerifiedAt = nowSec;

    return Response.json(
      {
        ok: true,
        verified: true,
        sender,
        github_username: githubUsername,
        github_verified_at: nowSec,
      },
      { status: 200 },
    );
  }

  type GitHubWebhookApplyResult =
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

  async function applyGitHubWebhookDelivery(args: {
    event: string;
    deliveryId: string;
    requestBody: string;
  }): Promise<GitHubWebhookApplyResult> {
    const event = args.event.trim().toLowerCase();
    const deliveryId = args.deliveryId.trim();
    if (event.length === 0) {
      return { ok: false, deliveryId, event, error: 'missing github event' };
    }
    const applied = await githubIssueSync.applyDelivery({
      event,
      deliveryId,
      requestBody: args.requestBody,
      map(input) {
        const action = (typeof input.parsed.action === 'string' ? input.parsed.action : '')
          .trim()
          .toLowerCase();
        const topic = mapGitHubWebhookTopic(event, action);
        if (!topic || !isValidTopic(topic)) {
          return { ok: false, error: 'unsupported github webhook event/action' };
        }

        const repositoryFullName = readGitHubRepositoryFullName(input.parsed);
        const room = normalizeGitHubRoomName(repositoryFullName);
        const issueNumber = readGitHubIssueNumber(input.parsed);
        const issueId = buildGitHubIssueId(repositoryFullName, issueNumber, input.deliveryId);
        const issueUpdatedAtMs = readGitHubIssueUpdatedAtMs(input.parsed);
        const envelopePayload = buildGitHubIssuePayload({
          deliveryId: input.deliveryId,
          event,
          action,
          issueId,
          repositoryFullName,
          parsed: input.parsed,
        });
        if (issueUpdatedAtMs !== null) {
          envelopePayload.source_updated_at_ms = issueUpdatedAtMs;
        }
        const sender = readGitHubSender(input.parsed);
        return {
          ok: true,
          mapped: {
            room,
            sender,
            topic,
            issueId,
            action,
            envelopeId: `gh-${input.deliveryId}`,
            payload: envelopePayload,
          },
        };
      },
      async publish(mapped) {
        if (!isJsonValue(mapped.payload)) {
          return { status: 400, accepted: false, cursor: null };
        }
        const roomState = getOrCreateRoomState(rooms, mapped.room);
        const result = publishIntoRoom(
          roomState,
          mapped.room,
          mapped.sender,
          mapped.topic,
          mapped.envelopeId,
          '',
          mapped.payload,
          maxMessagesPerRoom,
        );

        if (
          result.changed &&
          result.status === 200 &&
          result.envelope &&
          result.body.accepted === true &&
          typeof result.body.cursor === 'number'
        ) {
          broadcastPublish(roomState, mapped.room, result.envelope, result.body.cursor as number);
          recordCacheExchange(result.envelope, relayNodeId, 0, cacheExchangeMaxHops);
          await persistEnvelopeToCache(result.envelope, result.body.cursor as number);
        }

        return {
          status: result.status,
          accepted: result.body.accepted === true,
          cursor: typeof result.body.cursor === 'number' ? result.body.cursor : null,
        };
      },
    });
    return applied;
  }

  async function handleGitHubWebhook(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return methodNotAllowedResponse();
    }

    if (githubWebhookSecret.length === 0) {
      return toErrorResponse('github webhook secret is not configured', 503);
    }

    const event = (request.headers.get('x-github-event') ?? '').trim().toLowerCase();
    const deliveryId = (request.headers.get('x-github-delivery') ?? '').trim();
    if (deliveryId.length === 0) {
      return toErrorResponse('missing github delivery id', 400);
    }
    const signatureHex = parseGitHubSignatureHeader(
      request.headers.get('x-hub-signature-256') ?? '',
    );
    if (!signatureHex) {
      return toErrorResponse('invalid github webhook signature', 401);
    }

    const requestBody = await request.text();
    const expectedSignatureHex = await hmacSha256Hex(githubWebhookSecret, requestBody);
    if (!timingSafeEqual(expectedSignatureHex, signatureHex)) {
      return toErrorResponse('invalid github webhook signature', 401);
    }

    const result = await applyGitHubWebhookDelivery({ event, deliveryId, requestBody });
    if (!result.ok) {
      const queued = githubIssueSync.enqueueDlq({
        deliveryId,
        event,
        body: requestBody,
        error: result.error,
        incrementRetry: false,
      });
      return Response.json(
        {
          ok: false,
          queued: true,
          delivery_id: deliveryId,
          event,
          error: result.error,
          retry_count: queued.retry_count,
          next_retry_at: queued.next_retry_at,
        },
        { status: 202 },
      );
    }

    return Response.json(
      {
        ok: true,
        accepted: result.accepted,
        duplicate: result.duplicate,
        delivery_id: result.deliveryId,
        event: result.event,
        action: result.action,
        topic: result.topic,
        room: result.room,
        issue_id: result.issueId,
        cursor: result.cursor,
      },
      { status: 200 },
    );
  }

  function handleGitHubWebhookDlqList(request: Request, url: URL): Response {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse();
    }
    const after = normalizeAfter(url.searchParams.get('after'), 0);
    const limit = normalizeLimit(url.searchParams.get('limit'), 100);
    const listed = githubIssueSync.listDlq(after, limit);
    return Response.json(
      {
        ok: true,
        next_cursor: listed.nextCursor,
        entries: listed.entries.map((entry) => ({
          delivery_id: entry.delivery_id,
          event: entry.event,
          retry_count: entry.retry_count,
          created_at: entry.created_at,
          updated_at: entry.updated_at,
          next_retry_at: entry.next_retry_at,
          last_error: entry.last_error,
        })),
      },
      { status: 200 },
    );
  }

  async function handleGitHubWebhookDlqRetry(request: Request, url: URL): Promise<Response> {
    if (request.method !== 'POST') {
      return methodNotAllowedResponse();
    }
    const deliveryId = (url.searchParams.get('delivery_id') ?? '').trim();
    if (deliveryId.length === 0) {
      return toErrorResponse('missing query: delivery_id', 400);
    }
    const found = githubIssueSync.getDlqEntry(deliveryId);
    if (!found) {
      return toErrorResponse('delivery_id not found in dlq', 404);
    }

    const result = await applyGitHubWebhookDelivery({
      event: found.event,
      deliveryId: found.delivery_id,
      requestBody: found.body,
    });
    if (result.ok) {
      githubIssueSync.removeDlq(deliveryId);
      return Response.json(
        {
          ok: true,
          queued: false,
          accepted: result.accepted,
          duplicate: result.duplicate,
          delivery_id: result.deliveryId,
          event: result.event,
          topic: result.topic,
          room: result.room,
          issue_id: result.issueId,
          cursor: result.cursor,
        },
        { status: 200 },
      );
    }

    const queued = githubIssueSync.enqueueDlq({
      deliveryId: found.delivery_id,
      event: found.event,
      body: found.body,
      error: result.error,
      incrementRetry: true,
    });
    return Response.json(
      {
        ok: true,
        queued: true,
        accepted: false,
        delivery_id: queued.delivery_id,
        event: queued.event,
        error: queued.last_error,
        retry_count: queued.retry_count,
        next_retry_at: queued.next_retry_at,
      },
      { status: 200 },
    );
  }

  async function handleTriggerCallback(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return methodNotAllowedResponse();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      return toErrorResponse('invalid json payload', 400);
    }
    if (!isObjectRecord(parsed)) {
      return toErrorResponse('invalid json payload', 400);
    }

    const ref = (typeof parsed.ref === 'string' ? parsed.ref : '').trim();
    if (ref.length === 0) {
      return toErrorResponse('missing field: ref', 400);
    }
    const status = (typeof parsed.status === 'string' ? parsed.status : '').trim().toLowerCase();
    if (status.length === 0) {
      return toErrorResponse('missing field: status', 400);
    }

    const requestedRoom = (typeof parsed.room === 'string' ? parsed.room : '').trim();
    const room = requestedRoom.length > 0 ? requestedRoom : deriveRoomFromIncomingRef(ref);
    if (!isValidRoomName(room)) {
      return invalidRoomResponse();
    }
    const roomTokenError = checkRoomToken(request, room);
    if (roomTokenError) return roomTokenError;

    const logsUrl = typeof parsed.logs_url === 'string' ? parsed.logs_url : '';
    const artifactUrl = typeof parsed.artifact_url === 'string' ? parsed.artifact_url : '';
    const externalId = typeof parsed.external_id === 'string' ? parsed.external_id : '';
    const provider = typeof parsed.provider === 'string' ? parsed.provider : '';
    const callbackId = (typeof parsed.id === 'string' ? parsed.id : '').trim();
    const envelopeId = callbackId.length > 0
      ? callbackId
      : externalId.trim().length > 0
      ? `ci-${externalId.trim()}`
      : `ci-${crypto.randomUUID()}`;
    const receivedAt = nowEpochSec();

    const payload: JsonObject = {
      source: 'ci',
      ref,
      status,
      logs_url: logsUrl,
      artifact_url: artifactUrl,
      external_id: externalId,
      provider,
      received_at: receivedAt,
    };

    const roomState = getOrCreateRoomState(rooms, room);
    const result = publishIntoRoom(
      roomState,
      room,
      'ci:callback',
      'ci.result',
      envelopeId,
      '',
      payload,
      maxMessagesPerRoom,
    );

    if (
      result.changed &&
      result.status === 200 &&
      result.envelope &&
      result.body.accepted === true &&
      typeof result.body.cursor === 'number'
    ) {
      broadcastPublish(roomState, room, result.envelope, result.body.cursor as number);
      recordCacheExchange(result.envelope, relayNodeId, 0, cacheExchangeMaxHops);
      await persistEnvelopeToCache(result.envelope, result.body.cursor as number);
    }

    return Response.json(
      {
        ok: result.status === 200,
        accepted: result.body.accepted === true,
        room,
        topic: 'ci.result',
        id: envelopeId,
        ref,
        status,
        cursor: typeof result.body.cursor === 'number' ? result.body.cursor : null,
      },
      { status: result.status },
    );
  }

  function handleTriggerResults(request: Request, url: URL): Response {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse();
    }
    const room = normalizeRoom(url.searchParams.get('room'));
    if (!isValidRoomName(room)) {
      return invalidRoomResponse();
    }
    const roomTokenError = checkRoomToken(request, room);
    if (roomTokenError) return roomTokenError;

    const after = normalizeAfter(url.searchParams.get('after'), 0);
    const limit = normalizeLimit(url.searchParams.get('limit'), 100);
    const roomState = getOrCreateRoomState(rooms, room);
    const results: JsonObject[] = [];
    let nextCursor = after;

    for (let i = after; i < roomState.messages.length; i += 1) {
      const envelope = roomState.messages[i];
      nextCursor = i + 1;
      if (envelope.topic !== 'ci.result') continue;
      results.push({
        cursor: i + 1,
        ...sanitizeEnvelope(envelope),
      });
      if (results.length >= limit) break;
    }

    return Response.json(
      {
        ok: true,
        room,
        next_cursor: results.length > 0 ? nextCursor : after,
        results,
      },
      { status: 200 },
    );
  }

  async function fetch(request: Request): Promise<Response> {
    if (Date.now() - lastReapAt >= wsPingIntervalMs) {
      reapDeadConnections();
    }

    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/health') {
      return healthResponse();
    }
    if (pathname === '/') {
      return new Response('bit-relay', { status: 200 });
    }

    if (authToken.length > 0 && shouldRequireAuth(pathname)) {
      const presented = extractPresentedToken(request);
      if (presented.length === 0 || !timingSafeEqual(presented, authToken)) {
        return unauthorizedResponse();
      }
    }

    if (pathname === '/api/v1/key/info') {
      return handleKeyInfo(request);
    }
    if (pathname === '/api/v1/key/rotate') {
      return handleKeyRotate(request);
    }

    if (pathname === '/api/v1/key/verify-github') {
      return handleKeyVerifyGitHub(request);
    }

    if (pathname === '/api/v1/github/webhook') {
      return handleGitHubWebhook(request);
    }

    if (pathname === '/api/v1/github/webhook/dlq') {
      return handleGitHubWebhookDlqList(request, url);
    }

    if (pathname === '/api/v1/github/webhook/dlq/retry') {
      return handleGitHubWebhookDlqRetry(request, url);
    }

    if (pathname === '/api/v1/trigger/callback') {
      return handleTriggerCallback(request);
    }

    if (pathname === '/api/v1/trigger/results') {
      return handleTriggerResults(request, url);
    }

    if (pathname === '/api/v1/cache/exchange/discovery') {
      return handleCacheExchangeDiscovery(request);
    }

    if (pathname === '/api/v1/cache/exchange/pull') {
      return handleCacheExchangePull(request, url);
    }

    if (pathname === '/api/v1/cache/exchange/push') {
      return handleCacheExchangePush(request);
    }

    if (pathname === '/api/v1/cache/issues/pull') {
      return handleCacheIssuePull(request, url);
    }

    if (pathname === '/api/v1/cache/issues/sync') {
      return handleCacheIssueSync(request, url);
    }

    if (pathname === '/ws') {
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!isValidRoomName(room)) {
        return invalidRoomResponse();
      }
      return handleWebSocket(request, room);
    }

    if (pathname === '/api/v1/publish') {
      if (request.method !== 'POST') {
        return methodNotAllowedResponse();
      }

      const sender = (url.searchParams.get('sender') ?? '').trim();
      if (sender.length === 0) {
        return toErrorResponse('missing query: sender', 400);
      }

      const room = normalizeRoom(url.searchParams.get('room'));
      if (!isValidRoomName(room)) {
        return invalidRoomResponse();
      }
      const publishRoomTokenError = checkRoomToken(request, room);
      if (publishRoomTokenError) return publishRoomTokenError;
      const topic = (url.searchParams.get('topic') ?? 'notify').trim() || 'notify';
      const id = (url.searchParams.get('id') ?? crypto.randomUUID()).trim() || crypto.randomUUID();
      const signatureFromQuery = (url.searchParams.get('sig') ?? '').trim();

      const now = Date.now();
      const clientIp = extractClientIp(request);
      if (clientIp.length > 0) {
        const ipRate = fallbackRateLimit(
          ipRateCounts.get(clientIp),
          now,
          ipPublishLimitPerWindow,
          publishWindowMs,
        );
        ipRateCounts.set(clientIp, ipRate.next);
        if (!ipRate.allowed) {
          return toErrorResponse('ip rate limit exceeded', 429);
        }
      }

      const rate = fallbackRateLimit(
        senderRateCounts.get(sender),
        now,
        publishLimitPerWindow,
        publishWindowMs,
      );
      senderRateCounts.set(sender, rate.next);
      if (!rate.allowed) {
        return toErrorResponse('sender rate limit exceeded', 429);
      }

      const roomRate = fallbackRateLimit(
        roomRateCounts.get(room),
        now,
        roomPublishLimitPerWindow,
        publishWindowMs,
      );
      roomRateCounts.set(room, roomRate.next);
      if (!roomRate.allowed) {
        return toErrorResponse('room rate limit exceeded', 429);
      }

      const contentLength = Number(request.headers.get('content-length') ?? '');
      if (Number.isFinite(contentLength) && contentLength > publishPayloadMaxBytes) {
        return toErrorResponse('payload too large', 413);
      }

      const requestBody = await request.text();
      if (jsonByteLength(requestBody) > publishPayloadMaxBytes) {
        return toErrorResponse('payload too large', 413);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(requestBody);
      } catch {
        return toErrorResponse('invalid json payload', 400);
      }

      if (!isJsonValue(parsed)) {
        return toErrorResponse('invalid json payload', 400);
      }

      const payload = normalizePublishPayload(parsed);
      const verifyResult = await handleSignatureVerification({
        request,
        sender,
        room,
        id,
        topic,
        payload,
      });
      if (verifyResult instanceof Response) {
        return verifyResult;
      }

      const roomState = getOrCreateRoomState(rooms, room);
      const result = publishIntoRoom(
        roomState,
        room,
        sender,
        topic,
        id,
        verifyResult.signature ?? signatureFromQuery,
        payload,
        maxMessagesPerRoom,
      );

      if (
        result.changed &&
        result.status === 200 &&
        result.envelope &&
        result.body.accepted === true &&
        typeof result.body.cursor === 'number'
      ) {
        broadcastPublish(roomState, room, result.envelope, result.body.cursor as number);
        recordCacheExchange(result.envelope, relayNodeId, 0, cacheExchangeMaxHops);
        await persistEnvelopeToCache(result.envelope, result.body.cursor as number);
      }
      return Response.json(result.body, { status: result.status });
    }

    if (pathname === '/api/v1/poll') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse();
      }
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!isValidRoomName(room)) {
        return invalidRoomResponse();
      }
      const pollRoomTokenError = checkRoomToken(request, room);
      if (pollRoomTokenError) return pollRoomTokenError;
      const after = normalizeAfter(url.searchParams.get('after'), 0);
      const limit = normalizeLimit(url.searchParams.get('limit'), 100);
      const roomState = getOrCreateRoomState(rooms, room);
      return Response.json(pollFromRoom(roomState, room, after, limit), { status: 200 });
    }

    if (pathname === '/api/v1/inbox/pending') {
      if (request.method !== 'GET') {
        return methodNotAllowedResponse();
      }
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!isValidRoomName(room)) {
        return invalidRoomResponse();
      }
      const inboxPendingRoomTokenError = checkRoomToken(request, room);
      if (inboxPendingRoomTokenError) return inboxPendingRoomTokenError;
      const consumer = (url.searchParams.get('consumer') ?? '').trim();
      if (consumer.length === 0) {
        return toErrorResponse('missing query: consumer', 400);
      }
      const limit = normalizeLimit(url.searchParams.get('limit'), 100);
      const roomState = getOrCreateRoomState(rooms, room);
      return Response.json(inboxPendingFromRoom(roomState, room, consumer, limit), { status: 200 });
    }

    if (pathname === '/api/v1/inbox/ack') {
      if (request.method !== 'POST') {
        return methodNotAllowedResponse();
      }
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!isValidRoomName(room)) {
        return invalidRoomResponse();
      }
      const ackRoomTokenError = checkRoomToken(request, room);
      if (ackRoomTokenError) return ackRoomTokenError;
      const consumer = (url.searchParams.get('consumer') ?? '').trim();
      if (consumer.length === 0) {
        return toErrorResponse('missing query: consumer', 400);
      }
      const requestBody = await request.text();
      const roomState = getOrCreateRoomState(rooms, room);
      const result = ackIntoRoom(roomState, room, consumer, requestBody);
      return Response.json(result.body, { status: result.status });
    }

    if (pathname === '/api/v1/presence/heartbeat') {
      if (request.method !== 'POST') {
        return methodNotAllowedResponse();
      }
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!isValidRoomName(room)) {
        return invalidRoomResponse();
      }
      const heartbeatRoomTokenError = checkRoomToken(request, room);
      if (heartbeatRoomTokenError) return heartbeatRoomTokenError;
      const participant = (url.searchParams.get('participant') ?? '').trim();
      if (participant.length === 0) {
        return toErrorResponse('missing query: participant', 400);
      }
      let status = 'online';
      let metadata: JsonValue = null;
      const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('application/json')) {
        try {
          const parsed = JSON.parse(await request.text());
          if (isObjectRecord(parsed)) {
            if (typeof parsed.status === 'string') {
              status = parsed.status;
            }
            if (
              Object.prototype.hasOwnProperty.call(parsed, 'metadata') &&
              isJsonValue(parsed.metadata)
            ) {
              metadata = parsed.metadata as JsonValue;
            }
          }
        } catch {
          return toErrorResponse('invalid json payload', 400);
        }
      }
      const nowSec = nowEpochSec();
      const roomState = getOrCreateRoomState(rooms, room);
      const isNew = !roomState.presenceByParticipant.has(participant);
      roomState.presenceByParticipant.set(participant, {
        participantId: participant,
        status,
        metadata,
        lastHeartbeat: nowSec,
      });
      broadcastPresenceChange(
        roomState,
        room,
        participant,
        status,
        metadata,
        isNew ? 'joined' : 'updated',
      );
      return Response.json({ ok: true, participant, status, event: isNew ? 'joined' : 'updated' }, {
        status: 200,
      });
    }

    if (pathname === '/api/v1/presence') {
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!isValidRoomName(room)) {
        return invalidRoomResponse();
      }
      const presenceRoomTokenError = checkRoomToken(request, room);
      if (presenceRoomTokenError) return presenceRoomTokenError;

      if (request.method === 'GET') {
        const nowSec = nowEpochSec();
        const roomState = getOrCreateRoomState(rooms, room);
        prunePresence(roomState, nowSec, presenceTtlSec);
        const participants: JsonValue[] = [];
        for (const record of roomState.presenceByParticipant.values()) {
          participants.push({
            participant_id: record.participantId,
            status: record.status,
            metadata: record.metadata,
            last_heartbeat: record.lastHeartbeat,
          });
        }
        return Response.json({ ok: true, room, participants }, { status: 200 });
      }

      if (request.method === 'DELETE') {
        const participant = (url.searchParams.get('participant') ?? '').trim();
        if (participant.length === 0) {
          return toErrorResponse('missing query: participant', 400);
        }
        const roomState = getOrCreateRoomState(rooms, room);
        const removed = roomState.presenceByParticipant.delete(participant);
        if (removed) {
          broadcastPresenceChange(roomState, room, participant, 'offline', null, 'left');
        }
        return Response.json({ ok: true, participant, removed }, { status: 200 });
      }

      return methodNotAllowedResponse();
    }

    if (pathname === '/api/v1/review') {
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!isValidRoomName(room)) {
        return invalidRoomResponse();
      }
      const reviewRoomTokenError = checkRoomToken(request, room);
      if (reviewRoomTokenError) return reviewRoomTokenError;

      if (request.method === 'GET') {
        const prId = (url.searchParams.get('pr_id') ?? '').trim();
        if (prId.length === 0) {
          return toErrorResponse('missing query: pr_id', 400);
        }
        if (!PR_ID_PATTERN.test(prId)) {
          return toErrorResponse('invalid pr_id', 400);
        }
        const roomState = getOrCreateRoomState(rooms, room);
        const reviewMap = roomState.reviewsByPr.get(prId) ?? new Map<string, ReviewRecord>();
        const status = computeReviewStatus(reviewMap);
        const reviews: JsonValue[] = [];
        for (const record of reviewMap.values()) {
          reviews.push({
            sender: record.sender,
            verdict: record.verdict,
            submitted_at: record.submittedAt,
            updated_at: record.updatedAt,
          });
        }
        return Response.json({
          ok: true,
          room,
          pr_id: prId,
          resolved: status.resolved,
          approve_count: status.approve_count,
          deny_count: status.deny_count,
          reviews,
        }, { status: 200 });
      }

      if (request.method === 'POST') {
        const sender = (url.searchParams.get('sender') ?? '').trim();
        if (sender.length === 0) {
          return toErrorResponse('missing query: sender', 400);
        }
        const prId = (url.searchParams.get('pr_id') ?? '').trim();
        if (prId.length === 0) {
          return toErrorResponse('missing query: pr_id', 400);
        }
        if (!PR_ID_PATTERN.test(prId)) {
          return toErrorResponse('invalid pr_id', 400);
        }
        const verdict = (url.searchParams.get('verdict') ?? '').trim();
        if (!VALID_VERDICTS.has(verdict)) {
          return toErrorResponse('invalid verdict', 400);
        }

        // Signature is always required for review (attestation)
        const authParsed = parsePublishAuthHeaders(request);
        if (!authParsed.ok) {
          return toErrorResponse(authParsed.error, authParsed.status);
        }
        if (!authParsed.auth) {
          return toErrorResponse('missing signature headers', 401);
        }

        const auth = authParsed.auth;
        const nowSec = nowEpochSec();
        if (Math.abs(nowSec - auth.timestampSec) > maxClockSkewSec) {
          return toErrorResponse('stale signature timestamp', 401);
        }
        if (isReplayNonce(sender, auth.nonce, nowSec)) {
          return toErrorResponse('replayed nonce', 409);
        }

        const signingMessage = buildReviewSigningMessage({
          sender,
          room,
          prId,
          verdict,
          ts: auth.timestampSec,
          nonce: auth.nonce,
        });
        const verified = await verifyEd25519Signature(
          auth.publicKey,
          signingMessage,
          auth.signature,
        );
        if (!verified) {
          return toErrorResponse('invalid signature', 401);
        }

        const tofuError = ensureTofuKey(sender, auth.publicKey, nowSec);
        if (tofuError) return tofuError;
        rememberNonce(sender, auth.nonce, auth.timestampSec, nowSec);

        const roomState = getOrCreateRoomState(rooms, room);
        let prReviews = roomState.reviewsByPr.get(prId);
        if (!prReviews) {
          prReviews = new Map<string, ReviewRecord>();
          roomState.reviewsByPr.set(prId, prReviews);
        }

        const existing = prReviews.get(sender);
        const event = existing ? 'updated' : 'submitted';
        const submittedAt = existing ? existing.submittedAt : nowSec;
        prReviews.set(sender, {
          sender,
          verdict: verdict as ReviewVerdict,
          submittedAt,
          updatedAt: nowSec,
        });

        const reviewStatus = computeReviewStatus(prReviews);
        broadcastReviewChange(
          roomState,
          room,
          prId,
          sender,
          verdict,
          event,
          reviewStatus.resolved,
          reviewStatus.approve_count,
          reviewStatus.deny_count,
        );

        return Response.json({
          ok: true,
          room,
          pr_id: prId,
          sender,
          verdict,
          event,
          resolved: reviewStatus.resolved,
          approve_count: reviewStatus.approve_count,
          deny_count: reviewStatus.deny_count,
        }, { status: 200 });
      }

      return methodNotAllowedResponse();
    }

    return notFoundResponse();
  }

  function snapshot(): RelaySnapshot {
    const snapshotRooms: Record<string, SnapshotRoom> = {};
    for (const [room, roomState] of rooms.entries()) {
      const acks: Record<string, string[]> = {};
      for (const [consumer, ids] of roomState.acksByConsumer.entries()) {
        acks[consumer] = Array.from(ids.values());
      }
      const presence: SnapshotPresenceRecord[] = [];
      for (const record of roomState.presenceByParticipant.values()) {
        presence.push({
          participant_id: record.participantId,
          status: record.status,
          metadata: record.metadata,
          last_heartbeat: record.lastHeartbeat,
        });
      }
      const reviews: SnapshotReviewRecord[] = [];
      for (const [prId, senderMap] of roomState.reviewsByPr.entries()) {
        for (const record of senderMap.values()) {
          reviews.push({
            sender: record.sender,
            verdict: record.verdict,
            pr_id: prId,
            submitted_at: record.submittedAt,
            updated_at: record.updatedAt,
          });
        }
      }
      snapshotRooms[room] = {
        messages: JSON.parse(JSON.stringify(roomState.messages)) as Envelope[],
        acks_by_consumer: acks,
        ...(presence.length > 0 ? { presence } : {}),
        ...(reviews.length > 0 ? { reviews } : {}),
      };
    }

    const keysBySender: Record<string, SnapshotKeyRecord> = {};
    for (const [sender, key] of keyRegistry.entries()) {
      keysBySender[sender] = {
        public_key: key.publicKey,
        status: key.status,
        first_seen_at: key.firstSeenAt,
        last_seen_at: key.lastSeenAt,
        rotated_at: key.rotatedAt,
        revoked_at: key.revokedAt,
        github_username: key.githubUsername,
        github_verified_at: key.githubVerifiedAt,
      };
    }

    const noncesSnapshot: Record<string, Record<string, number>> = {};
    for (const [sender, nonces] of noncesBySender.entries()) {
      const senderNonces: Record<string, number> = {};
      for (const [nonce, ts] of nonces.entries()) {
        senderNonces[nonce] = ts;
      }
      noncesSnapshot[sender] = senderNonces;
    }

    const cacheExchangeSnapshot: SnapshotCacheExchangeState = {
      cursor: cacheExchangeCursor,
      records: cacheExchangeRecords.map((record) => ({
        cursor: record.cursor,
        envelope: JSON.parse(JSON.stringify(record.envelope)) as Envelope,
        origin: record.origin,
        hop_count: record.hopCount,
        max_hops: record.maxHops,
      })),
    };

    const issueCursorSnapshot: Record<string, number> = {};
    for (const [room, cursor] of issueCursorByRoom.entries()) {
      if (!isValidRoomName(room)) continue;
      if (!Number.isFinite(cursor)) continue;
      const normalized = Math.max(0, Math.trunc(cursor));
      issueCursorSnapshot[room] = normalized;
    }

    const githubWebhookSnapshot = githubIssueSync.snapshot();

    return {
      rooms: snapshotRooms,
      keys_by_sender: keysBySender,
      nonces_by_sender: noncesSnapshot,
      ...(cacheExchangeSnapshot.records.length > 0 || cacheExchangeSnapshot.cursor > 0
        ? { cache_exchange: cacheExchangeSnapshot }
        : {}),
      ...(Object.keys(issueCursorSnapshot).length > 0
        ? { issue_cursors: issueCursorSnapshot }
        : {}),
      ...(Object.keys(githubWebhookSnapshot.deliveries).length > 0 ||
          githubWebhookSnapshot.dlq.length > 0
        ? {
          github_webhook: {
            deliveries: githubWebhookSnapshot.deliveries,
            dlq: githubWebhookSnapshot.dlq,
          },
        }
        : {}),
    };
  }

  function identitySnapshot(): IdentitySnapshot {
    const keysBySender: Record<string, SnapshotKeyRecord> = {};
    for (const [sender, key] of keyRegistry.entries()) {
      keysBySender[sender] = {
        public_key: key.publicKey,
        status: key.status,
        first_seen_at: key.firstSeenAt,
        last_seen_at: key.lastSeenAt,
        rotated_at: key.rotatedAt,
        revoked_at: key.revokedAt,
        github_username: key.githubUsername,
        github_verified_at: key.githubVerifiedAt,
      };
    }

    const noncesData: Record<string, Record<string, number>> = {};
    for (const [sender, nonces] of noncesBySender.entries()) {
      const senderNonces: Record<string, number> = {};
      for (const [nonce, ts] of nonces.entries()) {
        senderNonces[nonce] = ts;
      }
      noncesData[sender] = senderNonces;
    }

    return {
      keys_by_sender: keysBySender,
      nonces_by_sender: noncesData,
    };
  }

  function restoreIdentity(snapshotData: IdentitySnapshot): void {
    keyRegistry.clear();
    noncesBySender.clear();

    if (!isObjectRecord(snapshotData)) {
      return;
    }

    if (isObjectRecord(snapshotData.keys_by_sender)) {
      for (const [sender, value] of Object.entries(snapshotData.keys_by_sender)) {
        if (!isObjectRecord(value)) continue;
        const publicKey = (typeof value.public_key === 'string' ? value.public_key : '').trim();
        if (sender.trim().length === 0 || publicKey.length === 0) continue;
        const status: KeyStatus = value.status === 'revoked' ? 'revoked' : 'active';
        keyRegistry.set(sender, {
          publicKey,
          status,
          firstSeenAt: typeof value.first_seen_at === 'number'
            ? Math.trunc(value.first_seen_at)
            : 0,
          lastSeenAt: typeof value.last_seen_at === 'number' ? Math.trunc(value.last_seen_at) : 0,
          rotatedAt: typeof value.rotated_at === 'number' ? Math.trunc(value.rotated_at) : null,
          revokedAt: typeof value.revoked_at === 'number' ? Math.trunc(value.revoked_at) : null,
          githubUsername: typeof value.github_username === 'string' ? value.github_username : null,
          githubVerifiedAt: typeof value.github_verified_at === 'number'
            ? Math.trunc(value.github_verified_at)
            : null,
        });
      }
    }

    if (isObjectRecord(snapshotData.nonces_by_sender)) {
      const nowSec = nowEpochSec();
      for (const [sender, value] of Object.entries(snapshotData.nonces_by_sender)) {
        if (!isObjectRecord(value)) continue;
        const map = new Map<string, number>();
        for (const [nonce, tsRaw] of Object.entries(value)) {
          if (nonce.trim().length === 0) continue;
          if (typeof tsRaw !== 'number' || !Number.isFinite(tsRaw)) continue;
          const ts = Math.trunc(tsRaw);
          if (nowSec - ts > nonceTtlSec) continue;
          map.set(nonce, ts);
        }
        if (map.size > 0) {
          noncesBySender.set(sender, map);
        }
      }
    }
  }

  function restore(snapshotData: RelaySnapshot): void {
    rooms.clear();
    keyRegistry.clear();
    noncesBySender.clear();
    issueCursorByRoom.clear();
    githubIssueSync.restore({ deliveries: {}, dlq: [] });
    cacheExchangeRecords.splice(0, cacheExchangeRecords.length);
    cacheExchangeCursor = 0;

    if (!isObjectRecord(snapshotData)) {
      return;
    }

    if (isObjectRecord(snapshotData.rooms)) {
      for (const [room, value] of Object.entries(snapshotData.rooms)) {
        if (!isValidRoomName(room)) continue;
        if (!isObjectRecord(value)) continue;
        if (!Array.isArray(value.messages)) continue;
        if (!isObjectRecord(value.acks_by_consumer)) continue;

        const roomState = createRoomState();
        roomState.messages = [];
        for (const message of value.messages) {
          if (!isObjectRecord(message)) continue;
          const candidate: Envelope = {
            room: typeof message.room === 'string' ? message.room : room,
            id: typeof message.id === 'string' ? message.id : '',
            sender: typeof message.sender === 'string' ? message.sender : '',
            topic: typeof message.topic === 'string' ? message.topic : '',
            payload: isJsonValue(message.payload) ? message.payload : null,
            signature: typeof message.signature === 'string'
              ? message.signature
              : message.signature === null
              ? null
              : null,
          };
          if (
            candidate.id.length === 0 ||
            candidate.sender.length === 0 ||
            candidate.topic.length === 0
          ) {
            continue;
          }
          roomState.messages.push(candidate);
        }

        for (const [consumer, ids] of Object.entries(value.acks_by_consumer)) {
          if (!Array.isArray(ids)) continue;
          const set = new Set<string>();
          for (const id of ids) {
            if (typeof id !== 'string') continue;
            const trimmed = id.trim();
            if (trimmed.length === 0) continue;
            set.add(trimmed);
          }
          roomState.acksByConsumer.set(consumer, set);
        }

        if (roomState.messages.length > maxMessagesPerRoom) {
          roomState.messages = roomState.messages.slice(
            roomState.messages.length - maxMessagesPerRoom,
          );
        }

        if (Array.isArray(value.presence)) {
          const nowSec = nowEpochSec();
          for (const p of value.presence) {
            if (!isObjectRecord(p)) continue;
            const pid = (typeof p.participant_id === 'string' ? p.participant_id : '').trim();
            if (pid.length === 0) continue;
            const lastHb = typeof p.last_heartbeat === 'number' ? Math.trunc(p.last_heartbeat) : 0;
            if (nowSec - lastHb >= presenceTtlSec) continue;
            roomState.presenceByParticipant.set(pid, {
              participantId: pid,
              status: typeof p.status === 'string' ? p.status : 'online',
              metadata: isJsonValue(p.metadata) ? p.metadata as JsonValue : null,
              lastHeartbeat: lastHb,
            });
          }
        }

        if (Array.isArray(value.reviews)) {
          for (const r of value.reviews) {
            if (!isObjectRecord(r)) continue;
            const rSender = (typeof r.sender === 'string' ? r.sender : '').trim();
            const rPrId = (typeof r.pr_id === 'string' ? r.pr_id : '').trim();
            const rVerdict = typeof r.verdict === 'string' ? r.verdict : '';
            if (rSender.length === 0 || rPrId.length === 0) continue;
            if (!VALID_VERDICTS.has(rVerdict)) continue;
            if (!PR_ID_PATTERN.test(rPrId)) continue;
            const submittedAt = typeof r.submitted_at === 'number' ? Math.trunc(r.submitted_at) : 0;
            const updatedAt = typeof r.updated_at === 'number' ? Math.trunc(r.updated_at) : 0;
            let prReviews = roomState.reviewsByPr.get(rPrId);
            if (!prReviews) {
              prReviews = new Map<string, ReviewRecord>();
              roomState.reviewsByPr.set(rPrId, prReviews);
            }
            prReviews.set(rSender, {
              sender: rSender,
              verdict: rVerdict as ReviewVerdict,
              submittedAt,
              updatedAt,
            });
          }
        }

        rooms.set(room, roomState);
      }
    }

    if (isObjectRecord(snapshotData.keys_by_sender)) {
      for (const [sender, value] of Object.entries(snapshotData.keys_by_sender)) {
        if (!isObjectRecord(value)) continue;
        const publicKey = (typeof value.public_key === 'string' ? value.public_key : '').trim();
        if (sender.trim().length === 0 || publicKey.length === 0) continue;
        const status: KeyStatus = value.status === 'revoked' ? 'revoked' : 'active';
        keyRegistry.set(sender, {
          publicKey,
          status,
          firstSeenAt: typeof value.first_seen_at === 'number'
            ? Math.trunc(value.first_seen_at)
            : 0,
          lastSeenAt: typeof value.last_seen_at === 'number' ? Math.trunc(value.last_seen_at) : 0,
          rotatedAt: typeof value.rotated_at === 'number' ? Math.trunc(value.rotated_at) : null,
          revokedAt: typeof value.revoked_at === 'number' ? Math.trunc(value.revoked_at) : null,
          githubUsername: typeof value.github_username === 'string' ? value.github_username : null,
          githubVerifiedAt: typeof value.github_verified_at === 'number'
            ? Math.trunc(value.github_verified_at)
            : null,
        });
      }
    }

    if (isObjectRecord(snapshotData.nonces_by_sender)) {
      const nowSec = nowEpochSec();
      for (const [sender, value] of Object.entries(snapshotData.nonces_by_sender)) {
        if (!isObjectRecord(value)) continue;
        const map = new Map<string, number>();
        for (const [nonce, tsRaw] of Object.entries(value)) {
          if (nonce.trim().length === 0) continue;
          if (typeof tsRaw !== 'number' || !Number.isFinite(tsRaw)) continue;
          const ts = Math.trunc(tsRaw);
          if (nowSec - ts > nonceTtlSec) continue;
          map.set(nonce, ts);
        }
        if (map.size > 0) {
          noncesBySender.set(sender, map);
        }
      }
    }

    if (isObjectRecord(snapshotData.issue_cursors)) {
      for (const [room, cursorRaw] of Object.entries(snapshotData.issue_cursors)) {
        if (!isValidRoomName(room)) continue;
        if (typeof cursorRaw !== 'number' || !Number.isFinite(cursorRaw)) continue;
        issueCursorByRoom.set(room, Math.max(0, Math.trunc(cursorRaw)));
      }
    }

    if (isObjectRecord(snapshotData.github_webhook)) {
      githubIssueSync.restore(snapshotData.github_webhook);
    }

    let restoredCacheExchange = false;
    if (
      isObjectRecord(snapshotData.cache_exchange) &&
      Array.isArray(snapshotData.cache_exchange.records)
    ) {
      let maxCursor = 0;
      for (const value of snapshotData.cache_exchange.records) {
        if (!isObjectRecord(value)) continue;
        if (!isObjectRecord(value.envelope)) continue;
        const envelopeRecord = value.envelope;
        const room = typeof envelopeRecord.room === 'string' ? envelopeRecord.room : '';
        const id = typeof envelopeRecord.id === 'string' ? envelopeRecord.id : '';
        const sender = typeof envelopeRecord.sender === 'string' ? envelopeRecord.sender : '';
        const topic = typeof envelopeRecord.topic === 'string' ? envelopeRecord.topic : '';
        const payload = isJsonValue(envelopeRecord.payload) ? envelopeRecord.payload : null;
        const signature = typeof envelopeRecord.signature === 'string'
          ? envelopeRecord.signature
          : envelopeRecord.signature === null
          ? null
          : null;
        const cursor = typeof value.cursor === 'number' && Number.isFinite(value.cursor)
          ? Math.trunc(value.cursor)
          : 0;
        const origin = typeof value.origin === 'string' ? value.origin.trim() : '';
        const hopCount = typeof value.hop_count === 'number' && Number.isFinite(value.hop_count)
          ? Math.max(0, Math.trunc(value.hop_count))
          : 0;
        const maxHops = typeof value.max_hops === 'number' && Number.isFinite(value.max_hops)
          ? Math.max(1, Math.trunc(value.max_hops))
          : cacheExchangeMaxHops;

        if (cursor <= 0 || origin.length === 0) continue;
        if (!isValidRoomName(room)) continue;
        if (id.length === 0 || sender.length === 0) continue;
        if (!isValidTopic(topic)) continue;

        appendCacheExchangeRecord({
          cursor,
          envelope: {
            room,
            id,
            sender,
            topic,
            payload,
            signature,
          },
          origin,
          hopCount,
          maxHops,
        });
        if (cursor > maxCursor) maxCursor = cursor;
      }

      const snapshotCursor = typeof snapshotData.cache_exchange.cursor === 'number' &&
          Number.isFinite(snapshotData.cache_exchange.cursor)
        ? Math.max(0, Math.trunc(snapshotData.cache_exchange.cursor))
        : 0;
      cacheExchangeCursor = Math.max(snapshotCursor, maxCursor);
      restoredCacheExchange = true;
    }

    if (!restoredCacheExchange) {
      for (const roomState of rooms.values()) {
        for (const message of roomState.messages) {
          recordCacheExchange(message, relayNodeId, 0, cacheExchangeMaxHops);
        }
      }
    }
  }

  function close(): void {
    if (reapIntervalId !== null) {
      clearInterval(reapIntervalId);
    }
  }

  return {
    fetch,
    snapshot,
    restore,
    identitySnapshot,
    restoreIdentity,
    close,
  };
}

export function createMemoryRelayHandler(
  options: MemoryRelayOptions = {},
): (request: Request) => Promise<Response> {
  const service = createMemoryRelayService(options);
  return (request: Request) => service.fetch(request);
}

export {
  DEFAULT_CACHE_EXCHANGE_MAX_HOPS,
  DEFAULT_CACHE_EXCHANGE_MAX_RECORDS,
  DEFAULT_IP_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_MAX_CLOCK_SKEW_SEC,
  DEFAULT_MAX_MESSAGES_PER_ROOM,
  DEFAULT_MAX_NONCES_PER_SENDER,
  DEFAULT_MAX_WS_SESSIONS,
  DEFAULT_NONCE_TTL_SEC,
  DEFAULT_PRESENCE_TTL_SEC,
  DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
  DEFAULT_PUBLISH_WINDOW_MS,
  DEFAULT_REQUIRE_SIGNATURES,
  DEFAULT_ROOM,
  DEFAULT_ROOM_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_WS_IDLE_TIMEOUT_MS,
  DEFAULT_WS_PING_INTERVAL_MS,
  healthResponse,
  isValidRoomName,
  isValidTopic,
  normalizeAuthToken,
  parseRoomTokens,
};
