import {
  createMemoryRelayService,
  DEFAULT_ROOM,
  healthResponse,
  type IdentitySnapshot,
  isValidRoomName,
  type MemoryRelayOptions,
  type MemoryRelayService,
} from './memory_handler.ts';
import { GitServeSession } from './git_serve_session.ts';
import { createRelayRequestMetricRecorder, logRelayAudit } from './relay_observability.ts';
import { parseMemoryRelayOptionsFromEnv } from './runtime_config.ts';
import { createAdminGitHubApi } from './admin_github_api.ts';

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

interface DurableObjectStorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile?(callback: () => Promise<void>): Promise<void>;
}

export interface RelayWorkerEnv {
  RELAY_ROOM?: DurableObjectNamespaceLike;
  GIT_SERVE_SESSION?: DurableObjectNamespaceLike;
  BIT_RELAY_AUTH_TOKEN?: string;
  RELAY_MAX_MESSAGES_PER_ROOM?: string;
  PUBLISH_PAYLOAD_MAX_BYTES?: string;
  RELAY_PUBLISH_LIMIT_PER_WINDOW?: string;
  RELAY_PUBLISH_WINDOW_MS?: string;
  RELAY_ROOM_TOKENS?: string;
  MAX_WS_SESSIONS?: string;
  RELAY_REQUIRE_SIGNATURE?: string;
  RELAY_MAX_CLOCK_SKEW_SEC?: string;
  RELAY_NONCE_TTL_SEC?: string;
  RELAY_MAX_NONCES_PER_SENDER?: string;
  RELAY_PEER_AUTH_TOKEN?: string;
  RELAY_PRESENCE_TTL_SEC?: string;
  RELAY_IP_PUBLISH_LIMIT_PER_WINDOW?: string;
  RELAY_ROOM_PUBLISH_LIMIT_PER_WINDOW?: string;
  WS_PING_INTERVAL_SEC?: string;
  WS_IDLE_TIMEOUT_SEC?: string;
  GIT_SERVE_SESSION_TTL_SEC?: string;
  RELAY_ADMIN_TOKEN?: string;
  RELAY_GITHUB_TOKEN?: string;
  RELAY_GITHUB_API_BASE_URL?: string;
  RELAY_GITHUB_WEBHOOK_SECRET?: string;
}

const IDENTITY_KEY = 'relay_identity_v1';
const INCOMING_TRIGGER_REF_PREFIX = 'refs/relay/incoming/';
let fallbackService: MemoryRelayService | null = null;
let adminGitHubApi: ReturnType<typeof createAdminGitHubApi> | null = null;
const requestMetrics = createRelayRequestMetricRecorder();

function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

function metricOperationForRequest(request: Request): string {
  const url = new URL(request.url);
  const pathname = url.pathname.startsWith('/git/') ? '/git/:session' : url.pathname;
  return `${request.method.toUpperCase()} ${pathname}`;
}

function buildOptions(env: RelayWorkerEnv): MemoryRelayOptions {
  return parseMemoryRelayOptionsFromEnv((key) => {
    const value = env[key as keyof RelayWorkerEnv];
    return typeof value === 'string' ? value : undefined;
  });
}

function getAdminGitHubApi(env: RelayWorkerEnv): ReturnType<typeof createAdminGitHubApi> {
  if (adminGitHubApi !== null) return adminGitHubApi;
  adminGitHubApi = createAdminGitHubApi({
    adminToken: env.RELAY_ADMIN_TOKEN ?? env.BIT_RELAY_AUTH_TOKEN,
    defaultGitHubToken: env.RELAY_GITHUB_TOKEN ?? null,
    apiBaseUrl: env.RELAY_GITHUB_API_BASE_URL ?? 'https://api.github.com',
    audit(entry) {
      logRelayAudit(entry);
    },
  });
  return adminGitHubApi;
}

function isRelayRoute(pathname: string): boolean {
  return pathname === '/' || pathname === '/ws' || pathname.startsWith('/api/v1/');
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,16}$/;
const NAMED_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id) || NAMED_SESSION_PATTERN.test(id);
}

function generateSessionId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

function getGitServeSessionStub(
  env: RelayWorkerEnv,
  sessionId: string,
): DurableObjectStubLike | null {
  if (!env.GIT_SERVE_SESSION) return null;
  const id = env.GIT_SERVE_SESSION.idFromName(sessionId);
  return env.GIT_SERVE_SESSION.get(id);
}

function extractSessionToken(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get('session_token') ??
    request.headers.get('x-session-token') ??
    '';
}

async function handleServeRoute(
  url: URL,
  request: Request,
  env: RelayWorkerEnv,
): Promise<Response> {
  const pathname = url.pathname;

  if (pathname === '/api/v1/serve/register' && request.method === 'POST') {
    const sender = url.searchParams.get('sender') ?? '';
    const repo = url.searchParams.get('repo') ?? '';
    let sessionId: string;

    if (sender && repo && env.RELAY_ROOM) {
      const relayRoomStub = env.RELAY_ROOM.get(
        env.RELAY_ROOM.idFromName('__default__'),
      );
      const keyInfoRes = await relayRoomStub.fetch(
        new Request(
          `http://do/api/v1/key/info?sender=${encodeURIComponent(sender)}`,
        ),
      );
      const keyInfo = (await keyInfoRes.json()) as Record<string, unknown>;
      const keyRecord = keyInfo.key as Record<string, unknown> | undefined;
      if (keyInfoRes.status === 200 && keyRecord?.github_verified_at) {
        sessionId = `${sender}/${repo}`;
      } else {
        sessionId = generateSessionId();
      }
    } else if (sender && repo) {
      // No RELAY_ROOM DO — use fallback service
      if (fallbackService === null) {
        fallbackService = createMemoryRelayService(buildOptions(env));
      }
      const keyInfoRes = await fallbackService.fetch(
        new Request(
          `http://localhost/api/v1/key/info?sender=${encodeURIComponent(sender)}`,
        ),
      );
      const keyInfo = (await keyInfoRes.json()) as Record<string, unknown>;
      const keyRecord = keyInfo.key as Record<string, unknown> | undefined;
      if (keyInfoRes.status === 200 && keyRecord?.github_verified_at) {
        sessionId = `${sender}/${repo}`;
      } else {
        sessionId = generateSessionId();
      }
    } else {
      sessionId = generateSessionId();
    }

    const stub = getGitServeSessionStub(env, sessionId);
    if (!stub) {
      return Response.json(
        { ok: false, error: 'git serve sessions not available' },
        { status: 503 },
      );
    }
    const doRes = await stub.fetch(new Request('http://do/register', { method: 'POST' }));
    const body = (await doRes.json()) as Record<string, unknown>;
    const status = body.ok ? 200 : doRes.status;
    logRelayAudit({
      action: status === 200 ? 'serve.registered' : 'serve.register_failed',
      occurredAt: nowEpochSec(),
      status,
      room: null,
      sender: sender || null,
      target: '/api/v1/serve/register',
      id: sessionId,
      detail: {
        named_session: sessionId.includes('/'),
      },
    });
    if (body.ok) {
      return Response.json({ ...body, session_id: sessionId });
    }
    return Response.json(body, { status: doRes.status });
  }

  const sessionParam = url.searchParams.get('session') ?? '';
  if (!isValidSessionId(sessionParam)) {
    return Response.json(
      { ok: false, error: 'invalid or missing session id' },
      { status: 400 },
    );
  }

  const stub = getGitServeSessionStub(env, sessionParam);
  if (!stub) {
    return Response.json(
      { ok: false, error: 'git serve sessions not available' },
      { status: 503 },
    );
  }

  if (pathname === '/api/v1/serve/poll' && request.method === 'GET') {
    const timeout = url.searchParams.get('timeout') ?? '30';
    const token = extractSessionToken(request);
    return stub.fetch(
      new Request(
        `http://do/poll?timeout=${encodeURIComponent(timeout)}&session_token=${
          encodeURIComponent(token)
        }`,
      ),
    );
  }

  if (pathname === '/api/v1/serve/respond' && request.method === 'POST') {
    const token = extractSessionToken(request);
    return stub.fetch(
      new Request(`http://do/respond?session_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
      }),
    );
  }

  if (pathname === '/api/v1/serve/info' && request.method === 'GET') {
    const token = extractSessionToken(request);
    return stub.fetch(
      new Request(`http://do/info?session_token=${encodeURIComponent(token)}`),
    );
  }

  return Response.json({ ok: false, error: 'not found' }, { status: 404 });
}

function handleGitRoute(
  sessionId: string,
  gitPath: string,
  request: Request,
  env: RelayWorkerEnv,
): Response | Promise<Response> {
  const stub = getGitServeSessionStub(env, sessionId);
  if (!stub) {
    return Response.json(
      { ok: false, error: 'git serve sessions not available' },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const doUrl = `http://do/git/${gitPath}${url.search}`;

  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  return stub.fetch(new Request(doUrl, init));
}

function invalidRoomResponse(): Response {
  return Response.json({ ok: false, error: 'invalid room' }, { status: 400 });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deriveRoomFromIncomingRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(INCOMING_TRIGGER_REF_PREFIX)) return DEFAULT_ROOM;
  const suffix = trimmed.slice(INCOMING_TRIGGER_REF_PREFIX.length).trim();
  if (suffix.length === 0) return DEFAULT_ROOM;
  const first = suffix.split('/')[0].trim();
  if (!isValidRoomName(first)) return DEFAULT_ROOM;
  return first;
}

function getRelayRoomStub(env: RelayWorkerEnv, room: string): DurableObjectStubLike | null {
  if (!env.RELAY_ROOM) return null;
  const id = env.RELAY_ROOM.idFromName(room);
  return env.RELAY_ROOM.get(id);
}

function buildForwardedRelayRequest(
  baseUrl: URL,
  request: Request,
  bodyText: string | null,
): Request {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD' && bodyText !== null) {
    init.body = bodyText;
  }
  return new Request(baseUrl.toString(), init);
}

function parseCacheExchangeEntriesByRoom(parsed: unknown): Map<string, unknown[]> | null {
  if (!isObjectRecord(parsed) || !Array.isArray(parsed.entries)) return null;
  const grouped = new Map<string, unknown[]>();
  for (const entry of parsed.entries) {
    if (!isObjectRecord(entry)) return null;
    const room = (typeof entry.room === 'string' ? entry.room : '').trim();
    if (!isValidRoomName(room)) return null;
    const list = grouped.get(room);
    if (list) {
      list.push(entry);
    } else {
      grouped.set(room, [entry]);
    }
  }
  return grouped;
}

async function routeCacheExchangePushByEntryRoom(
  url: URL,
  request: Request,
  env: RelayWorkerEnv,
): Promise<Response | null> {
  if (
    url.pathname !== '/api/v1/cache/exchange/push' ||
    request.method !== 'POST' ||
    !env.RELAY_ROOM
  ) {
    return null;
  }

  const queryRoom = (url.searchParams.get('room') ?? '').trim();
  if (queryRoom.length > 0) {
    return null;
  }

  const bodyText = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    const fallbackStub = getRelayRoomStub(env, DEFAULT_ROOM);
    if (!fallbackStub) {
      return Response.json({ ok: false, error: 'relay room not available' }, { status: 503 });
    }
    return fallbackStub.fetch(buildForwardedRelayRequest(url, request, bodyText));
  }

  const grouped = parseCacheExchangeEntriesByRoom(parsed);
  if (!grouped || grouped.size === 0) {
    const fallbackStub = getRelayRoomStub(env, DEFAULT_ROOM);
    if (!fallbackStub) {
      return Response.json({ ok: false, error: 'relay room not available' }, { status: 503 });
    }
    return fallbackStub.fetch(buildForwardedRelayRequest(url, request, bodyText));
  }

  if (grouped.size === 1) {
    const [singleRoom] = grouped.keys();
    const stub = getRelayRoomStub(env, singleRoom);
    if (!stub) {
      return Response.json({ ok: false, error: 'relay room not available' }, { status: 503 });
    }
    const singleUrl = new URL(url.toString());
    singleUrl.searchParams.set('room', singleRoom);
    return stub.fetch(buildForwardedRelayRequest(singleUrl, request, bodyText));
  }

  const aggregateRejectionCounts: Record<string, number> = {};
  let protocol = 'cache.exchange.v1';
  let nodeId = '';
  let nextCursor = 0;
  let accepted = 0;
  let duplicates = 0;
  let conflicts = 0;
  let rejected = 0;

  for (const [room, entries] of grouped.entries()) {
    const stub = getRelayRoomStub(env, room);
    if (!stub) {
      return Response.json({ ok: false, error: 'relay room not available' }, { status: 503 });
    }
    const roomUrl = new URL(url.toString());
    roomUrl.searchParams.set('room', room);
    const response = await stub.fetch(
      buildForwardedRelayRequest(
        roomUrl,
        request,
        JSON.stringify({ entries }),
      ),
    );
    if (response.status !== 200) {
      return response;
    }
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.protocol === 'string' && body.protocol.trim().length > 0) {
      protocol = body.protocol;
    }
    if (typeof body.node_id === 'string' && body.node_id.trim().length > 0) {
      nodeId = body.node_id;
    }
    if (typeof body.next_cursor === 'number' && Number.isFinite(body.next_cursor)) {
      nextCursor = Math.max(nextCursor, Math.trunc(body.next_cursor));
    }
    if (typeof body.accepted === 'number' && Number.isFinite(body.accepted)) {
      accepted += Math.max(0, Math.trunc(body.accepted));
    }
    if (typeof body.duplicates === 'number' && Number.isFinite(body.duplicates)) {
      duplicates += Math.max(0, Math.trunc(body.duplicates));
    }
    if (typeof body.conflicts === 'number' && Number.isFinite(body.conflicts)) {
      conflicts += Math.max(0, Math.trunc(body.conflicts));
    }
    if (typeof body.rejected === 'number' && Number.isFinite(body.rejected)) {
      rejected += Math.max(0, Math.trunc(body.rejected));
    }
    if (isObjectRecord(body.rejection_counts)) {
      for (const [reason, count] of Object.entries(body.rejection_counts)) {
        if (typeof count !== 'number' || !Number.isFinite(count)) continue;
        aggregateRejectionCounts[reason] = (aggregateRejectionCounts[reason] ?? 0) +
          Math.max(0, Math.trunc(count));
      }
    }
  }

  return Response.json({
    ok: true,
    protocol,
    node_id: nodeId,
    accepted,
    duplicates,
    conflicts,
    rejected,
    rejection_counts: aggregateRejectionCounts,
    next_cursor: nextCursor,
  }, { status: 200 });
}

async function resolveRelayRouteRoom(url: URL, request: Request): Promise<string> {
  const roomFromQuery = (url.searchParams.get('room') ?? '').trim();
  if (roomFromQuery.length > 0) {
    return roomFromQuery;
  }

  if (url.pathname === '/api/v1/trigger/callback' && request.method === 'POST') {
    try {
      const bodyText = await request.clone().text();
      const parsed = JSON.parse(bodyText);
      if (isObjectRecord(parsed)) {
        const roomFromBody = (typeof parsed.room === 'string' ? parsed.room : '').trim();
        if (roomFromBody.length > 0) {
          return roomFromBody;
        }
        const ref = (typeof parsed.ref === 'string' ? parsed.ref : '').trim();
        if (ref.length > 0) {
          return deriveRoomFromIncomingRef(ref);
        }
      }
    } catch {
      // keep default room fallback
    }
  }

  return DEFAULT_ROOM;
}

export class RelayRoom {
  private readonly state: DurableObjectStateLike;
  private readonly service: MemoryRelayService;
  private readonly ready: Promise<void>;

  constructor(state: DurableObjectStateLike, env: RelayWorkerEnv) {
    this.state = state;
    this.service = createMemoryRelayService(buildOptions(env));
    const restore = async () => {
      try {
        // Try identity-only snapshot first (v1), fall back to legacy full snapshot
        const identity = await this.state.storage.get(IDENTITY_KEY);
        if (identity && typeof identity === 'object') {
          this.service.restoreIdentity(identity as IdentitySnapshot);
          return;
        }
        // Legacy: migrate from full snapshot if present
        const legacy = await this.state.storage.get('relay_snapshot_v1');
        if (legacy && typeof legacy === 'object') {
          const legacyData = legacy as Record<string, unknown>;
          if (legacyData.keys_by_sender || legacyData.nonces_by_sender) {
            this.service.restoreIdentity(legacyData as unknown as IdentitySnapshot);
          }
          // Clean up legacy key
          await this.state.storage.delete('relay_snapshot_v1');
        }
      } catch {
        console.error('Failed to restore relay identity; starting fresh');
      }
    };
    if (typeof this.state.blockConcurrencyWhile === 'function') {
      this.ready = this.state.blockConcurrencyWhile(restore);
    } else {
      this.ready = restore();
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const response = await this.service.fetch(request);

    // Persist identity (keys + nonces) on operations that modify them.
    // Messages, acks, and presence are ephemeral — not persisted.
    const pathname = new URL(request.url).pathname;
    if (
      pathname === '/api/v1/publish' ||
      pathname === '/api/v1/key/rotate' ||
      pathname === '/api/v1/key/verify-github' ||
      (pathname === '/api/v1/review' && request.method === 'POST')
    ) {
      try {
        await this.state.storage.put(IDENTITY_KEY, this.service.identitySnapshot());
      } catch {
        console.error('Failed to persist relay identity');
      }
    }
    return response;
  }
}

async function handleWorkerRequest(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const adminResponse = await getAdminGitHubApi(env).handle(request);
  if (adminResponse) return adminResponse;
  if (url.pathname === '/health') {
    return healthResponse();
  }

  // Git serve session routes: /git/<session_id>/...
  // Both named (owner/repo/path) and random (randomId/path) patterns can
  // match the same URL (e.g. /git/AbCdEfGh/info/refs).  When ambiguous,
  // try named first; if that session isn't active, fall back to random.
  const namedGitMatch = url.pathname.match(
    /^\/git\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(.*)/,
  );
  const randomGitMatch = url.pathname.match(/^\/git\/([A-Za-z0-9]{6,16})\/(.*)/);

  if (namedGitMatch && env.GIT_SERVE_SESSION) {
    const candidateId = `${namedGitMatch[1]}/${namedGitMatch[2]}`;
    if (randomGitMatch) {
      // Ambiguous: could be named or random session.
      // Try named first, fall back to random if not active.
      const response = await handleGitRoute(candidateId, namedGitMatch[3], request, env);
      if (response.status !== 404) {
        return response;
      }
      return handleGitRoute(randomGitMatch[1], randomGitMatch[2], request, env);
    }
    return handleGitRoute(candidateId, namedGitMatch[3], request, env);
  }

  if (randomGitMatch) {
    return handleGitRoute(randomGitMatch[1], randomGitMatch[2], request, env);
  }

  // Serve API routes: /api/v1/serve/...
  if (url.pathname.startsWith('/api/v1/serve/')) {
    return handleServeRoute(url, request, env);
  }

  if (!isRelayRoute(url.pathname)) {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  const cacheExchangeRouted = await routeCacheExchangePushByEntryRoom(url, request, env);
  if (cacheExchangeRouted) {
    return cacheExchangeRouted;
  }

  const room = (await resolveRelayRouteRoom(url, request)).trim();
  if (!isValidRoomName(room)) {
    return invalidRoomResponse();
  }

  if (!env.RELAY_ROOM) {
    if (fallbackService === null) {
      fallbackService = createMemoryRelayService(buildOptions(env));
    }
    const response = await fallbackService.fetch(request);
    if (request.method === 'POST') {
      const sender = url.searchParams.get('sender') ?? '';
      if (url.pathname === '/api/v1/publish') {
        const topic = url.searchParams.get('topic') ?? 'notify';
        const id = url.searchParams.get('id') ?? '';
        logRelayAudit({
          action: response.status === 200 ? 'publish.accepted' : 'publish.rejected',
          occurredAt: nowEpochSec(),
          status: response.status,
          room,
          sender: sender || null,
          target: url.pathname,
          id: id || null,
          detail: { topic },
        });
      } else if (url.pathname === '/api/v1/review') {
        const prId = url.searchParams.get('pr_id') ?? '';
        const verdict = url.searchParams.get('verdict') ?? '';
        logRelayAudit({
          action: response.status === 200 ? 'review.recorded' : 'review.rejected',
          occurredAt: nowEpochSec(),
          status: response.status,
          room,
          sender: sender || null,
          target: url.pathname,
          id: prId || null,
          detail: { verdict },
        });
      }
    }
    return response;
  }

  const stub = getRelayRoomStub(env, room);
  if (!stub) {
    return Response.json(
      { ok: false, error: 'relay room not available' },
      { status: 503 },
    );
  }
  const response = await stub.fetch(request);
  if (request.method === 'POST') {
    const sender = url.searchParams.get('sender') ?? '';
    if (url.pathname === '/api/v1/publish') {
      const topic = url.searchParams.get('topic') ?? 'notify';
      const idValue = url.searchParams.get('id') ?? '';
      logRelayAudit({
        action: response.status === 200 ? 'publish.accepted' : 'publish.rejected',
        occurredAt: nowEpochSec(),
        status: response.status,
        room,
        sender: sender || null,
        target: url.pathname,
        id: idValue || null,
        detail: { topic },
      });
    } else if (url.pathname === '/api/v1/review') {
      const prId = url.searchParams.get('pr_id') ?? '';
      const verdict = url.searchParams.get('verdict') ?? '';
      logRelayAudit({
        action: response.status === 200 ? 'review.recorded' : 'review.rejected',
        occurredAt: nowEpochSec(),
        status: response.status,
        room,
        sender: sender || null,
        target: url.pathname,
        id: prId || null,
        detail: { verdict },
      });
    }
  }
  return response;
}

const worker = {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    const startedAtMs = Date.now();
    const operation = metricOperationForRequest(request);
    try {
      const response = await handleWorkerRequest(request, env);
      requestMetrics.record({
        operation,
        occurredAt: nowEpochSec(),
        status: response.status,
        latencyMs: Math.max(0, Date.now() - startedAtMs),
        retryCount: 0,
      });
      return response;
    } catch (error) {
      requestMetrics.record({
        operation,
        occurredAt: nowEpochSec(),
        status: 500,
        latencyMs: Math.max(0, Date.now() - startedAtMs),
        retryCount: 0,
      });
      throw error;
    }
  },
};

export { GitServeSession };
export default worker;
