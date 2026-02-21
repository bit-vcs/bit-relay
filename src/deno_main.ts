import {
  createMemoryRelayService,
  DEFAULT_MAX_MESSAGES_PER_ROOM,
  DEFAULT_MAX_WS_SESSIONS,
  DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
  DEFAULT_PUBLISH_WINDOW_MS,
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
    authToken: Deno.env.get('CLUSTER_API_TOKEN') ?? undefined,
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
  };
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,16}$/;

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

const gitServeSessions = new Map<string, ReturnType<typeof createGitServeSession>>();

function getOrCreateSession(sessionId: string): ReturnType<typeof createGitServeSession> {
  let session = gitServeSessions.get(sessionId);
  if (!session) {
    session = createGitServeSession();
    gitServeSessions.set(sessionId, session);
  }
  return session;
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Git serve session routes: /git/<session_id>/...
  const gitMatch = pathname.match(/^\/git\/([A-Za-z0-9]{6,16})\/(.*)/);
  if (gitMatch) {
    const sessionId = gitMatch[1];
    const gitPath = '/' + gitMatch[2];
    const session = gitServeSessions.get(sessionId);
    if (!session) {
      return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
    }
    const sessionUrl = new URL(request.url);
    sessionUrl.pathname = '/git/' + gitMatch[2];
    const sessionRequest = new Request(sessionUrl.toString(), request);
    return session.fetch(sessionRequest);
  }

  // Serve API routes
  if (pathname === '/api/v1/serve/register' && request.method === 'POST') {
    const sessionId = generateSessionId();
    const session = getOrCreateSession(sessionId);
    const sessionRequest = new Request('http://localhost/register', { method: 'POST' });
    const result = await session.fetch(sessionRequest);
    const body = await result.json() as Record<string, unknown>;
    return Response.json({ ...body, session_id: sessionId });
  }

  if (pathname === '/api/v1/serve/poll' && request.method === 'GET') {
    const sessionId = url.searchParams.get('session') ?? '';
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return Response.json({ ok: false, error: 'invalid session' }, { status: 400 });
    }
    const session = gitServeSessions.get(sessionId);
    if (!session) {
      return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
    }
    const timeout = url.searchParams.get('timeout') ?? '30';
    const sessionRequest = new Request(`http://localhost/poll?timeout=${timeout}`, { method: 'GET' });
    return session.fetch(sessionRequest);
  }

  if (pathname === '/api/v1/serve/respond' && request.method === 'POST') {
    const sessionId = url.searchParams.get('session') ?? '';
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return Response.json({ ok: false, error: 'invalid session' }, { status: 400 });
    }
    const session = gitServeSessions.get(sessionId);
    if (!session) {
      return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
    }
    const sessionRequest = new Request('http://localhost/respond', {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });
    return session.fetch(sessionRequest);
  }

  if (pathname === '/api/v1/serve/info' && request.method === 'GET') {
    const sessionId = url.searchParams.get('session') ?? '';
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return Response.json({ ok: false, error: 'invalid session' }, { status: 400 });
    }
    const session = gitServeSessions.get(sessionId);
    if (!session) {
      return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
    }
    const sessionRequest = new Request('http://localhost/info', { method: 'GET' });
    return session.fetch(sessionRequest);
  }

  // Fall through to existing relay service
  return service.fetch(request);
}

console.log(`[bit-relay] listening on http://${host}:${port}`);

Deno.serve({ hostname: host, port }, handleRequest);
