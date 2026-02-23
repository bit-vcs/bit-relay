import {
  createMemoryRelayService,
  DEFAULT_IP_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_MAX_MESSAGES_PER_ROOM,
  DEFAULT_MAX_WS_SESSIONS,
  DEFAULT_PRESENCE_TTL_SEC,
  DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
  DEFAULT_PUBLISH_WINDOW_MS,
  DEFAULT_ROOM,
  DEFAULT_ROOM_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_WS_IDLE_TIMEOUT_MS,
  DEFAULT_WS_PING_INTERVAL_MS,
  healthResponse,
  isValidRoomName,
  type MemoryRelayOptions,
  type MemoryRelayService,
  type RelaySnapshot,
} from './memory_handler.ts';
import { GitServeSession } from './git_serve_session.ts';

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
  RELAY_PRESENCE_TTL_SEC?: string;
  RELAY_IP_PUBLISH_LIMIT_PER_WINDOW?: string;
  RELAY_ROOM_PUBLISH_LIMIT_PER_WINDOW?: string;
  WS_PING_INTERVAL_SEC?: string;
  WS_IDLE_TIMEOUT_SEC?: string;
  GIT_SERVE_SESSION_TTL_SEC?: string;
}

const SNAPSHOT_KEY = 'relay_snapshot_v1';
let fallbackService: MemoryRelayService | null = null;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseRoomTokens(raw: string | undefined): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [room, token] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof token !== 'string') continue;
      out[room] = token;
    }
    return out;
  } catch {
    return {};
  }
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return fallback;
}

function buildOptions(env: RelayWorkerEnv): MemoryRelayOptions {
  return {
    authToken: env.BIT_RELAY_AUTH_TOKEN,
    maxMessagesPerRoom: parsePositiveInt(
      env.RELAY_MAX_MESSAGES_PER_ROOM,
      DEFAULT_MAX_MESSAGES_PER_ROOM,
    ),
    publishPayloadMaxBytes: parsePositiveInt(
      env.PUBLISH_PAYLOAD_MAX_BYTES,
      DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
    ),
    publishLimitPerWindow: parsePositiveInt(
      env.RELAY_PUBLISH_LIMIT_PER_WINDOW,
      DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
    ),
    publishWindowMs: parsePositiveInt(env.RELAY_PUBLISH_WINDOW_MS, DEFAULT_PUBLISH_WINDOW_MS),
    ipPublishLimitPerWindow: parsePositiveInt(
      env.RELAY_IP_PUBLISH_LIMIT_PER_WINDOW,
      DEFAULT_IP_PUBLISH_LIMIT_PER_WINDOW,
    ),
    roomPublishLimitPerWindow: parsePositiveInt(
      env.RELAY_ROOM_PUBLISH_LIMIT_PER_WINDOW,
      DEFAULT_ROOM_PUBLISH_LIMIT_PER_WINDOW,
    ),
    roomTokens: parseRoomTokens(env.RELAY_ROOM_TOKENS),
    maxWsSessions: parsePositiveInt(env.MAX_WS_SESSIONS, DEFAULT_MAX_WS_SESSIONS),
    requireSignatures: parseBoolean(env.RELAY_REQUIRE_SIGNATURE, true),
    maxClockSkewSec: parsePositiveInt(env.RELAY_MAX_CLOCK_SKEW_SEC, 300),
    nonceTtlSec: parsePositiveInt(env.RELAY_NONCE_TTL_SEC, 600),
    maxNoncesPerSender: parsePositiveInt(env.RELAY_MAX_NONCES_PER_SENDER, 2048),
    presenceTtlSec: parsePositiveInt(env.RELAY_PRESENCE_TTL_SEC, DEFAULT_PRESENCE_TTL_SEC),
    wsPingIntervalMs:
      parsePositiveInt(env.WS_PING_INTERVAL_SEC, DEFAULT_WS_PING_INTERVAL_MS / 1000) *
      1000,
    wsIdleTimeoutMs: parsePositiveInt(env.WS_IDLE_TIMEOUT_SEC, DEFAULT_WS_IDLE_TIMEOUT_MS / 1000) *
      1000,
  };
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
    return stub
      .fetch(new Request('http://do/register', { method: 'POST' }))
      .then(async (doRes) => {
        const body = (await doRes.json()) as Record<string, unknown>;
        if (body.ok) {
          return Response.json({ ...body, session_id: sessionId });
        }
        return Response.json(body, { status: doRes.status });
      });
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

export class RelayRoom {
  private readonly state: DurableObjectStateLike;
  private readonly service: MemoryRelayService;
  private readonly ready: Promise<void>;

  constructor(state: DurableObjectStateLike, env: RelayWorkerEnv) {
    this.state = state;
    this.service = createMemoryRelayService(buildOptions(env));
    const restore = async () => {
      const snapshot = await this.state.storage.get(SNAPSHOT_KEY);
      if (!snapshot || typeof snapshot !== 'object') {
        return;
      }
      this.service.restore(snapshot as RelaySnapshot);
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

    const pathname = new URL(request.url).pathname;
    if (
      pathname === '/api/v1/publish' ||
      pathname === '/api/v1/inbox/ack' ||
      pathname === '/api/v1/presence/heartbeat' ||
      pathname === '/api/v1/key/rotate' ||
      pathname === '/api/v1/key/verify-github' ||
      (pathname === '/api/v1/presence' && request.method === 'DELETE') ||
      (pathname === '/api/v1/review' && request.method === 'POST')
    ) {
      await this.state.storage.put(SNAPSHOT_KEY, this.service.snapshot());
    }
    return response;
  }
}

const worker = {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
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

    const room = (url.searchParams.get('room') ?? DEFAULT_ROOM).trim();
    if (!isValidRoomName(room)) {
      return invalidRoomResponse();
    }

    if (!env.RELAY_ROOM) {
      if (fallbackService === null) {
        fallbackService = createMemoryRelayService(buildOptions(env));
      }
      return fallbackService.fetch(request);
    }

    const id = env.RELAY_ROOM.idFromName(room);
    const stub = env.RELAY_ROOM.get(id);
    return stub.fetch(request);
  },
};

export { GitServeSession };
export default worker;
