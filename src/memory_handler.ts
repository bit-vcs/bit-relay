export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

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
  changed: boolean;
}

interface RateCounter {
  count: number;
  windowStart: number;
}

interface RoomState {
  messages: Envelope[];
  acksByConsumer: Map<string, Set<string>>;
  sessions: Set<WebSocket>;
}

interface SnapshotRoom {
  messages: Envelope[];
  acks_by_consumer: Record<string, string[]>;
}

export interface RelaySnapshot {
  rooms: Record<string, SnapshotRoom>;
}

export interface MemoryRelayOptions {
  authToken?: string;
  maxMessagesPerRoom?: number;
  publishPayloadMaxBytes?: number;
  publishLimitPerWindow?: number;
  publishWindowMs?: number;
  roomTokens?: Record<string, string>;
  maxWsSessions?: number;
}

export interface MemoryRelayService {
  fetch(request: Request): Promise<Response>;
  snapshot(): RelaySnapshot;
  restore(snapshot: RelaySnapshot): void;
}

const DEFAULT_ROOM = 'main';
const DEFAULT_MAX_MESSAGES_PER_ROOM = 1000;
const DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES = 64 * 1024;
const DEFAULT_PUBLISH_LIMIT_PER_WINDOW = 30;
const DEFAULT_PUBLISH_WINDOW_MS = 60_000;
const DEFAULT_MAX_WS_SESSIONS = 100;
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
  const hasKind = typeof asObject.kind === 'string';
  const keys = Object.keys(asObject);
  if (!hasKind || (keys.length === 1 && keys[0] === 'payload')) {
    return payload;
  }
  return parsed;
}

function sanitizeEnvelope(envelope: Envelope): JsonObject {
  const out: JsonObject = {
    room: envelope.room,
    id: envelope.id,
    sender: envelope.sender,
    topic: envelope.topic,
    payload: envelope.payload,
  };
  return out;
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
      changed: false,
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
    changed: newlyAcked > 0,
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

  const rooms = new Map<string, RoomState>();
  const senderRateCounts = new Map<string, RateCounter>();

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
      (globalThis as { WebSocketPair?: new () => { 0: WebSocket; 1: WebSocket } })
        .WebSocketPair;
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

    const maybeDeno = (globalThis as { Deno?: typeof Deno }).Deno;
    if (maybeDeno && typeof maybeDeno.upgradeWebSocket === 'function') {
      const { response, socket } = maybeDeno.upgradeWebSocket(request);
      subscribeSocket(roomState, socket);
      return response;
    }

    return toErrorResponse('websocket unsupported in this runtime', 501);
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
      const signature = (url.searchParams.get('sig') ?? '').trim();

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
      const roomState = getOrCreateRoomState(rooms, room);
      const result = publishIntoRoom(
        roomState,
        room,
        sender,
        topic,
        id,
        signature,
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

    return notFoundResponse();
  }

  function snapshot(): RelaySnapshot {
    const snapshotRooms: Record<string, SnapshotRoom> = {};
    for (const [room, roomState] of rooms.entries()) {
      const acks: Record<string, string[]> = {};
      for (const [consumer, ids] of roomState.acksByConsumer.entries()) {
        acks[consumer] = Array.from(ids.values());
      }
      snapshotRooms[room] = {
        messages: JSON.parse(JSON.stringify(roomState.messages)) as Envelope[],
        acks_by_consumer: acks,
      };
    }
    return { rooms: snapshotRooms };
  }

  function restore(snapshotData: RelaySnapshot): void {
    rooms.clear();

    if (!isObjectRecord(snapshotData) || !isObjectRecord(snapshotData.rooms)) {
      return;
    }

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
      rooms.set(room, roomState);
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
  DEFAULT_MAX_MESSAGES_PER_ROOM,
  DEFAULT_MAX_WS_SESSIONS,
  DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
  DEFAULT_PUBLISH_WINDOW_MS,
  DEFAULT_ROOM,
  healthResponse,
  isValidRoomName,
  normalizeAuthToken,
  parseRoomTokens,
};
