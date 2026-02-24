import { createMemoryRelayService } from './memory_handler.ts';
import { createGitServeSession } from './git_serve_session.ts';
import { logRelayAudit, logRelayEvent } from './relay_observability.ts';
import { parseRelayRuntimeConfigFromEnv } from './runtime_config.ts';
import { createAdminGitHubApi } from './admin_github_api.ts';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
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
  for (let i = 0; i < bytes.length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

const host = Deno.env.get('HOST') ?? '127.0.0.1';
const port = parsePositiveInt(Deno.env.get('PORT') ?? undefined, 8788);
const runtimeConfig = parseRelayRuntimeConfigFromEnv((key) => Deno.env.get(key) ?? undefined);
const service = createMemoryRelayService(runtimeConfig.relay);
const adminGitHubApi = createAdminGitHubApi({
  adminToken: Deno.env.get('RELAY_ADMIN_TOKEN') ?? runtimeConfig.relay.authToken,
  defaultGitHubToken: runtimeConfig.github.token,
  apiBaseUrl: runtimeConfig.github.apiBaseUrl,
  audit(entry) {
    logRelayAudit(entry);
  },
});
const gitServeSessionOptions = runtimeConfig.gitServe.sessionTtlSec &&
    runtimeConfig.gitServe.sessionTtlSec > 0
  ? { sessionTtlMs: runtimeConfig.gitServe.sessionTtlSec * 1000 }
  : undefined;

const gitServeSessions = new Map<string, ReturnType<typeof createGitServeSession>>();

function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

function getOrCreateSession(sessionId: string): ReturnType<typeof createGitServeSession> {
  let session = gitServeSessions.get(sessionId);
  if (!session) {
    session = createGitServeSession({
      ...(gitServeSessionOptions ?? {}),
      eventSource: `deno:${host}:${port}`,
      eventTarget: `session:${sessionId}`,
      onIncomingRef(event) {
        logRelayEvent(event);
      },
    });
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

  const adminResponse = await adminGitHubApi.handle(request);
  if (adminResponse) return adminResponse;

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
    const response = Response.json({ ...body, session_id: sessionId });
    logRelayAudit({
      action: result.status === 200 ? 'serve.registered' : 'serve.register_failed',
      occurredAt: nowEpochSec(),
      status: result.status,
      room: null,
      sender: sender || null,
      target: '/api/v1/serve/register',
      id: sessionId,
      detail: {
        named_session: sessionId.includes('/'),
      },
    });
    return response;
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
  if (request.method === 'POST') {
    const sender = url.searchParams.get('sender') ?? '';
    const room = url.searchParams.get('room') ?? '';
    if (pathname === '/api/v1/publish') {
      const topic = url.searchParams.get('topic') ?? 'notify';
      const id = url.searchParams.get('id') ?? '';
      logRelayAudit({
        action: response.status === 200 ? 'publish.accepted' : 'publish.rejected',
        occurredAt: nowEpochSec(),
        status: response.status,
        room: room || null,
        sender: sender || null,
        target: pathname,
        id: id || null,
        detail: { topic },
      });
    } else if (pathname === '/api/v1/review') {
      const prId = url.searchParams.get('pr_id') ?? '';
      const verdict = url.searchParams.get('verdict') ?? '';
      logRelayAudit({
        action: response.status === 200 ? 'review.recorded' : 'review.rejected',
        occurredAt: nowEpochSec(),
        status: response.status,
        room: room || null,
        sender: sender || null,
        target: pathname,
        id: prId || null,
        detail: { verdict },
      });
    }
  }

  return response;
}

console.log(`[bit-relay] listening on http://${host}:${port}`);

Deno.serve({ hostname: host, port }, handleRequest);
