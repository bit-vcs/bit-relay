import {
  createMemoryRelayService,
  DEFAULT_IP_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_MAX_MESSAGES_PER_ROOM,
  DEFAULT_MAX_WS_SESSIONS,
  DEFAULT_PRESENCE_TTL_SEC,
  DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
  DEFAULT_PUBLISH_WINDOW_MS,
  DEFAULT_ROOM_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_WS_IDLE_TIMEOUT_MS,
  DEFAULT_WS_PING_INTERVAL_MS,
  type MemoryRelayOptions,
} from './memory_handler.ts';
import { createGitServeSession } from './git_serve_session.ts';

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

function optionsFromEnv(): MemoryRelayOptions {
  return {
    authToken: Deno.env.get('BIT_RELAY_AUTH_TOKEN') ?? undefined,
    maxMessagesPerRoom: parsePositiveInt(
      Deno.env.get('RELAY_MAX_MESSAGES_PER_ROOM') ?? undefined,
      DEFAULT_MAX_MESSAGES_PER_ROOM,
    ),
    publishPayloadMaxBytes: parsePositiveInt(
      Deno.env.get('PUBLISH_PAYLOAD_MAX_BYTES') ?? undefined,
      DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
    ),
    publishLimitPerWindow: parsePositiveInt(
      Deno.env.get('RELAY_PUBLISH_LIMIT_PER_WINDOW') ?? undefined,
      DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
    ),
    publishWindowMs: parsePositiveInt(
      Deno.env.get('RELAY_PUBLISH_WINDOW_MS') ?? undefined,
      DEFAULT_PUBLISH_WINDOW_MS,
    ),
    ipPublishLimitPerWindow: parsePositiveInt(
      Deno.env.get('RELAY_IP_PUBLISH_LIMIT_PER_WINDOW') ?? undefined,
      DEFAULT_IP_PUBLISH_LIMIT_PER_WINDOW,
    ),
    roomPublishLimitPerWindow: parsePositiveInt(
      Deno.env.get('RELAY_ROOM_PUBLISH_LIMIT_PER_WINDOW') ?? undefined,
      DEFAULT_ROOM_PUBLISH_LIMIT_PER_WINDOW,
    ),
    roomTokens: parseRoomTokens(Deno.env.get('RELAY_ROOM_TOKENS') ?? undefined),
    maxWsSessions: parsePositiveInt(
      Deno.env.get('MAX_WS_SESSIONS') ?? undefined,
      DEFAULT_MAX_WS_SESSIONS,
    ),
    requireSignatures: parseBoolean(
      Deno.env.get('RELAY_REQUIRE_SIGNATURE') ?? undefined,
      true,
    ),
    maxClockSkewSec: parsePositiveInt(
      Deno.env.get('RELAY_MAX_CLOCK_SKEW_SEC') ?? undefined,
      300,
    ),
    nonceTtlSec: parsePositiveInt(Deno.env.get('RELAY_NONCE_TTL_SEC') ?? undefined, 600),
    maxNoncesPerSender: parsePositiveInt(
      Deno.env.get('RELAY_MAX_NONCES_PER_SENDER') ?? undefined,
      2048,
    ),
    presenceTtlSec: parsePositiveInt(
      Deno.env.get('RELAY_PRESENCE_TTL_SEC') ?? undefined,
      DEFAULT_PRESENCE_TTL_SEC,
    ),
    wsPingIntervalMs: parsePositiveInt(
      Deno.env.get('WS_PING_INTERVAL_SEC') ?? undefined,
      DEFAULT_WS_PING_INTERVAL_MS / 1000,
    ) * 1000,
    wsIdleTimeoutMs: parsePositiveInt(
      Deno.env.get('WS_IDLE_TIMEOUT_SEC') ?? undefined,
      DEFAULT_WS_IDLE_TIMEOUT_MS / 1000,
    ) * 1000,
  };
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,16}$/;
const NAMED_SESSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id) || NAMED_SESSION_PATTERN.test(id);
}

function generateSessionId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

const host = Deno.env.get('HOST') ?? '127.0.0.1';
const port = parsePositiveInt(Deno.env.get('PORT') ?? undefined, 8788);
const service = createMemoryRelayService(optionsFromEnv());

const gitServeSessionTtlSec = parsePositiveInt(
  Deno.env.get('GIT_SERVE_SESSION_TTL_SEC') ?? undefined,
  0,
);
const gitServeSessionOptions = gitServeSessionTtlSec > 0
  ? { sessionTtlMs: gitServeSessionTtlSec * 1000 }
  : undefined;

const gitServeSessions = new Map<string, ReturnType<typeof createGitServeSession>>();

function getOrCreateSession(sessionId: string): ReturnType<typeof createGitServeSession> {
  let session = gitServeSessions.get(sessionId);
  if (!session) {
    session = createGitServeSession(gitServeSessionOptions);
    gitServeSessions.set(sessionId, session);
  }
  return session;
}

function extractSessionToken(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get('session_token') ??
    request.headers.get('x-session-token') ??
    '';
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Git serve session routes: /git/<session_id>/...
  // 1. Named session: /git/owner/repo/path...
  const namedGitMatch = pathname.match(
    /^\/git\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(.*)/,
  );
  if (namedGitMatch) {
    const candidateId = `${namedGitMatch[1]}/${namedGitMatch[2]}`;
    if (gitServeSessions.has(candidateId)) {
      const session = gitServeSessions.get(candidateId)!;
      const sessionUrl = new URL(request.url);
      sessionUrl.pathname = '/git/' + namedGitMatch[3];
      const sessionRequest = new Request(sessionUrl.toString(), request);
      return session.fetch(sessionRequest);
    }
    // fallthrough: try as random ID
  }

  // 2. Random session: /git/randomId/path...
  const randomGitMatch = pathname.match(/^\/git\/([A-Za-z0-9]{6,16})\/(.*)/);
  if (randomGitMatch) {
    const sessionId = randomGitMatch[1];
    const session = gitServeSessions.get(sessionId);
    if (!session) {
      return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
    }
    const sessionUrl = new URL(request.url);
    sessionUrl.pathname = '/git/' + randomGitMatch[2];
    const sessionRequest = new Request(sessionUrl.toString(), request);
    return session.fetch(sessionRequest);
  }

  // Serve API routes
  if (pathname === '/api/v1/serve/register' && request.method === 'POST') {
    const sender = url.searchParams.get('sender') ?? '';
    const repo = url.searchParams.get('repo') ?? '';
    let sessionId: string;

    if (sender && repo) {
      const keyInfoRes = await service.fetch(
        new Request(
          `http://localhost/api/v1/key/info?sender=${encodeURIComponent(sender)}`,
        ),
      );
      const keyInfo = await keyInfoRes.json() as Record<string, unknown>;
      const keyRecord = keyInfo.key as Record<string, unknown> | undefined;
      if (keyInfoRes.status === 200 && keyRecord?.github_verified_at) {
        sessionId = `${sender}/${repo}`;
      } else {
        sessionId = generateSessionId();
      }
    } else {
      sessionId = generateSessionId();
    }

    const session = getOrCreateSession(sessionId);
    const sessionRequest = new Request('http://localhost/register', { method: 'POST' });
    const result = await session.fetch(sessionRequest);
    const body = await result.json() as Record<string, unknown>;
    return Response.json({ ...body, session_id: sessionId });
  }

  if (pathname === '/api/v1/serve/poll' && request.method === 'GET') {
    const sessionId = url.searchParams.get('session') ?? '';
    if (!isValidSessionId(sessionId)) {
      return Response.json({ ok: false, error: 'invalid session' }, { status: 400 });
    }
    const session = gitServeSessions.get(sessionId);
    if (!session) {
      return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
    }
    const timeout = url.searchParams.get('timeout') ?? '30';
    const token = extractSessionToken(request);
    const sessionRequest = new Request(
      `http://localhost/poll?timeout=${timeout}&session_token=${encodeURIComponent(token)}`,
      { method: 'GET' },
    );
    return session.fetch(sessionRequest);
  }

  if (pathname === '/api/v1/serve/respond' && request.method === 'POST') {
    const sessionId = url.searchParams.get('session') ?? '';
    if (!isValidSessionId(sessionId)) {
      return Response.json({ ok: false, error: 'invalid session' }, { status: 400 });
    }
    const session = gitServeSessions.get(sessionId);
    if (!session) {
      return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
    }
    const token = extractSessionToken(request);
    const sessionRequest = new Request(
      `http://localhost/respond?session_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: request.headers,
        body: request.body,
      },
    );
    return session.fetch(sessionRequest);
  }

  if (pathname === '/api/v1/serve/info' && request.method === 'GET') {
    const sessionId = url.searchParams.get('session') ?? '';
    if (!isValidSessionId(sessionId)) {
      return Response.json({ ok: false, error: 'invalid session' }, { status: 400 });
    }
    const session = gitServeSessions.get(sessionId);
    if (!session) {
      return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
    }
    const token = extractSessionToken(request);
    const sessionRequest = new Request(
      `http://localhost/info?session_token=${encodeURIComponent(token)}`,
      { method: 'GET' },
    );
    return session.fetch(sessionRequest);
  }

  // Fall through to existing relay service
  const response = await service.fetch(request);

  // Log state-changing operations
  if (response.status === 200 && request.method === 'POST') {
    const sender = url.searchParams.get('sender') ?? '';
    const room = url.searchParams.get('room') ?? '';
    if (pathname === '/api/v1/publish') {
      const topic = url.searchParams.get('topic') ?? 'notify';
      const id = url.searchParams.get('id') ?? '';
      console.log(`[publish] room=${room} sender=${sender} topic=${topic} id=${id}`);
    } else if (pathname === '/api/v1/review') {
      const prId = url.searchParams.get('pr_id') ?? '';
      const verdict = url.searchParams.get('verdict') ?? '';
      console.log(`[review] room=${room} sender=${sender} pr_id=${prId} verdict=${verdict}`);
    }
  }

  return response;
}

console.log(`[bit-relay] listening on http://${host}:${port}`);

Deno.serve({ hostname: host, port }, handleRequest);
