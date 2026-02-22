import {
  buildPublishSigningMessage,
  buildRotateSigningMessage,
  canonicalizeJson,
  isLikelyBase64Url,
  sha256Hex,
  verifyEd25519Signature,
} from './signing.ts';

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
}

interface PublishAuthHeaders {
  publicKey: string;
  signature: string;
  timestampSec: number;
  nonce: string;
}

interface PresenceRecord {
  participantId: string;
  status: string;
  metadata: JsonValue;
  lastHeartbeat: number; // epoch seconds
}

interface RoomState {
  messages: Envelope[];
  acksByConsumer: Map<string, Set<string>>;
  sessions: Set<WebSocket>;
  presenceByParticipant: Map<string, PresenceRecord>;
}

interface SnapshotPresenceRecord {
  participant_id: string;
  status: string;
  metadata: JsonValue;
  last_heartbeat: number;
}

interface SnapshotRoom {
  messages: Envelope[];
  acks_by_consumer: Record<string, string[]>;
  presence?: SnapshotPresenceRecord[];
}

interface SnapshotKeyRecord {
  public_key: string;
  status: KeyStatus;
  first_seen_at: number;
  last_seen_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

export interface RelaySnapshot {
  rooms: Record<string, SnapshotRoom>;
  keys_by_sender: Record<string, SnapshotKeyRecord>;
  nonces_by_sender: Record<string, Record<string, number>>;
}

export interface MemoryRelayOptions {
  authToken?: string;
  maxMessagesPerRoom?: number;
  publishPayloadMaxBytes?: number;
  publishLimitPerWindow?: number;
  publishWindowMs?: number;
  roomTokens?: Record<string, string>;
  maxWsSessions?: number;
  requireSignatures?: boolean;
  maxClockSkewSec?: number;
  nonceTtlSec?: number;
  maxNoncesPerSender?: number;
  presenceTtlSec?: number;
}

export interface MemoryRelayService {
  fetch(request: Request): Promise<Response>;
  snapshot(): RelaySnapshot;
  restore(snapshot: RelaySnapshot): void;
}

const DEFAULT_ROOM = 'main';
const DEFAULT_PRESENCE_TTL_SEC = 60;
const DEFAULT_MAX_MESSAGES_PER_ROOM = 1000;
const DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES = 64 * 1024;
const DEFAULT_PUBLISH_LIMIT_PER_WINDOW = 30;
const DEFAULT_PUBLISH_WINDOW_MS = 60_000;
const DEFAULT_MAX_WS_SESSIONS = 100;
const DEFAULT_REQUIRE_SIGNATURES = true;
const DEFAULT_MAX_CLOCK_SKEW_SEC = 300;
const DEFAULT_NONCE_TTL_SEC = 600;
const DEFAULT_MAX_NONCES_PER_SENDER = 2048;
const ROOM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WS_OPEN_STATE = 1;

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

function isValidRoomName(room: string): boolean {
  return ROOM_NAME_PATTERN.test(room);
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
    sessions: new Set(),
    presenceByParticipant: new Map(),
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
  if (topic !== 'notify') {
    return {
      status: 400,
      body: { ok: false, error: `unsupported topic: ${topic}` },
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

function subscribeSocket(roomState: RoomState, socket: WebSocket): void {
  roomState.sessions.add(socket);
  socket.send(JSON.stringify({ type: 'ready' }));

  socket.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(String(event.data));
      if (parsed?.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
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
    type: 'notify',
    room,
    cursor,
    envelope: sanitizeEnvelope(envelope),
  });
  for (const socket of roomState.sessions) {
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
  for (const socket of roomState.sessions) {
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

  const rooms = new Map<string, RoomState>();
  const senderRateCounts = new Map<string, RateCounter>();
  const keyRegistry = new Map<string, KeyRecord>();
  const noncesBySender = new Map<string, Map<string, number>>();

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

  function handleWebSocket(request: Request, room: string): Response {
    const roomState = getOrCreateRoomState(rooms, room);

    const expectedRoomToken = roomTokens.get(room);
    if (expectedRoomToken) {
      const provided = readRoomToken(request);
      if (provided.length === 0 || !timingSafeEqual(provided, expectedRoomToken)) {
        return toErrorResponse('forbidden', 403);
      }
    }

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
      subscribeSocket(roomState, server);
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
      subscribeSocket(roomState, socket);
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

  async function fetch(request: Request): Promise<Response> {
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
      const topic = (url.searchParams.get('topic') ?? 'notify').trim() || 'notify';
      const id = (url.searchParams.get('id') ?? crypto.randomUUID()).trim() || crypto.randomUUID();
      const signatureFromQuery = (url.searchParams.get('sig') ?? '').trim();

      const now = Date.now();
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
            if (Object.prototype.hasOwnProperty.call(parsed, 'metadata') && isJsonValue(parsed.metadata)) {
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
      broadcastPresenceChange(roomState, room, participant, status, metadata, isNew ? 'joined' : 'updated');
      return Response.json({ ok: true, participant, status, event: isNew ? 'joined' : 'updated' }, { status: 200 });
    }

    if (pathname === '/api/v1/presence') {
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!isValidRoomName(room)) {
        return invalidRoomResponse();
      }

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
      snapshotRooms[room] = {
        messages: JSON.parse(JSON.stringify(roomState.messages)) as Envelope[],
        acks_by_consumer: acks,
        ...(presence.length > 0 ? { presence } : {}),
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

    return {
      rooms: snapshotRooms,
      keys_by_sender: keysBySender,
      nonces_by_sender: noncesSnapshot,
    };
  }

  function restore(snapshotData: RelaySnapshot): void {
    rooms.clear();
    keyRegistry.clear();
    noncesBySender.clear();

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

  return {
    fetch,
    snapshot,
    restore,
  };
}

export function createMemoryRelayHandler(
  options: MemoryRelayOptions = {},
): (request: Request) => Promise<Response> {
  const service = createMemoryRelayService(options);
  return (request: Request) => service.fetch(request);
}

export {
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
  healthResponse,
  isValidRoomName,
  normalizeAuthToken,
  parseRoomTokens,
};
