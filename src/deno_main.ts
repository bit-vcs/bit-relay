import { createMemoryRelayService } from './memory_handler.ts';
import { createGitServeSession } from './git_serve_session.ts';
import { logRelayAudit, logRelayEvent } from './relay_observability.ts';
import { parseRelayRuntimeConfigFromEnv } from './runtime_config.ts';
import { createAdminGitHubApi } from './admin_github_api.ts';
import { createCacheSyncWorker } from './cache_sync_worker.ts';
import type { CacheExchangeEntry } from './cache_exchange.ts';
import { createMemoryCacheStore } from './cache_store.ts';
import { buildGitCacheKeyFromRequest, readGitCache, writeGitCache } from './git_cache_layer.ts';

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
const relayCacheStore = createMemoryCacheStore();
const service = createMemoryRelayService({
  ...runtimeConfig.relay,
  peerRelayUrls: runtimeConfig.peers.urls.length > 0
    ? runtimeConfig.peers.urls
    : runtimeConfig.relay.peerRelayUrls,
  cacheStore: relayCacheStore,
});
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
const gitCacheStore = relayCacheStore;
const relayAuthToken = (runtimeConfig.relay.authToken ?? '').trim();
const peerSyncAuthToken = (runtimeConfig.peers.authToken ?? '').trim();
const encoder = new TextEncoder();

if (runtimeConfig.cache.provider === 'r2') {
  console.warn(
    '[bit-relay] RELAY_CACHE_PROVIDER=r2 is not yet supported in deno_main; using memory cache',
  );
}

function withRelayAuthHeaders(headersInit?: HeadersInit): Headers {
  const headers = new Headers(headersInit);
  if (relayAuthToken.length > 0 && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${relayAuthToken}`);
  }
  return headers;
}

function createInternalServiceRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: withRelayAuthHeaders(init.headers),
  });
}

function parseCacheExchangePullBody(body: Record<string, unknown>): {
  entries: CacheExchangeEntry[];
  nextCursor: number;
} {
  const entries = Array.isArray(body.entries) ? body.entries as CacheExchangeEntry[] : [];
  const nextCursor = typeof body.next_cursor === 'number' && Number.isFinite(body.next_cursor)
    ? Math.max(0, Math.trunc(body.next_cursor))
    : 0;
  return { entries, nextCursor };
}

function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function resolveLocalRelayNodeId(): Promise<string> {
  const response = await service.fetch(
    createInternalServiceRequest('http://localhost/api/v1/cache/exchange/discovery', {
      method: 'GET',
    }),
  );
  if (response.status !== 200) {
    throw new Error(`cache exchange discovery failed: status=${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  const nodeId = typeof body.node_id === 'string' ? body.node_id.trim() : '';
  if (nodeId.length === 0) {
    throw new Error('cache exchange discovery did not return node_id');
  }
  return nodeId;
}

async function pushEntriesToLocal(entries: CacheExchangeEntry[]): Promise<Record<string, unknown>> {
  const response = await service.fetch(
    createInternalServiceRequest('http://localhost/api/v1/cache/exchange/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ entries }),
    }),
  );
  if (response.status !== 200) {
    const text = await response.text();
    throw new Error(`local cache push failed: status=${response.status}, body=${text}`);
  }
  return await response.json() as Record<string, unknown>;
}

async function startCacheSyncWorker(): Promise<void> {
  const peers = runtimeConfig.peers.urls;
  if (peers.length === 0) return;

  let localNodeId = '';
  try {
    localNodeId = await resolveLocalRelayNodeId();
  } catch (error) {
    console.error('[bit-relay] cache-sync disabled: failed to resolve local node id', error);
    return;
  }

  const worker = createCacheSyncWorker({
    peers,
    limit: 200,
    async pullFromPeer({ peer, after, limit }) {
      const url = new URL('/api/v1/cache/exchange/pull', peer);
      url.searchParams.set('after', String(after));
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('peer', localNodeId);

      const headers = new Headers();
      if (peerSyncAuthToken.length > 0) {
        headers.set('authorization', `Bearer ${peerSyncAuthToken}`);
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers,
      });
      if (response.status !== 200) {
        const text = await response.text();
        throw new Error(`peer pull failed: peer=${peer}, status=${response.status}, body=${text}`);
      }
      const body = await response.json() as Record<string, unknown>;
      return parseCacheExchangePullBody(body);
    },
    async pushToLocal({ peer, entries }) {
      const result = await pushEntriesToLocal(entries);
      const accepted = typeof result.accepted === 'number' && Number.isFinite(result.accepted)
        ? Math.max(0, Math.trunc(result.accepted))
        : entries.length;
      if (accepted > 0) {
        logRelayEvent({
          type: 'cache_replicated',
          eventId: crypto.randomUUID(),
          occurredAt: nowEpochSec(),
          room: 'all',
          source: `peer:${peer}`,
          cacheKey: `cache.exchange.${accepted}`,
          fromNode: peer,
          toNode: localNodeId,
          bytes: encoder.encode(JSON.stringify(entries)).byteLength,
        });
      }
    },
  });

  const intervalMs = Math.max(1, runtimeConfig.peers.syncIntervalSec) * 1000;
  const runOnce = async () => {
    const summary = await worker.syncOnce();
    if (summary.failedPeers.length > 0) {
      console.error('[bit-relay] cache-sync failed peers:', summary.failedPeers.join(','));
    }
  };

  await runOnce();
  setInterval(() => {
    void runOnce();
  }, intervalMs);
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

async function handleGitRelayRequest(args: {
  request: Request;
  sessionId: string;
  gitSubPath: string;
}): Promise<Response> {
  const { request, sessionId, gitSubPath } = args;
  const cacheKey = await buildGitCacheKeyFromRequest(request.clone(), sessionId, `/${gitSubPath}`);
  const cached = await readGitCache(gitCacheStore, cacheKey);
  const session = gitServeSessions.get(sessionId);
  if (!session) {
    if (cached) return cached;
    return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
  }

  const sessionUrl = new URL(request.url);
  sessionUrl.pathname = `/git/${gitSubPath}`;
  const sessionRequest = new Request(sessionUrl.toString(), request);
  const response = await session.fetch(sessionRequest);

  if (response.status === 200) {
    await writeGitCache(gitCacheStore, cacheKey, response);
    return response;
  }

  if (cached && (response.status === 404 || response.status === 410)) {
    return cached;
  }

  return response;
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  let namedGitFallback: { sessionId: string; gitSubPath: string } | null = null;

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
      return handleGitRelayRequest({
        request,
        sessionId: candidateId,
        gitSubPath: namedGitMatch[3],
      });
    }
    namedGitFallback = { sessionId: candidateId, gitSubPath: namedGitMatch[3] };
    // fallthrough: try as random ID
  }

  // 2. Random session: /git/randomId/path...
  const randomGitMatch = pathname.match(/^\/git\/([A-Za-z0-9]{6,16})\/(.*)/);
  if (randomGitMatch) {
    return handleGitRelayRequest({
      request,
      sessionId: randomGitMatch[1],
      gitSubPath: randomGitMatch[2],
    });
  }

  if (namedGitFallback) {
    return handleGitRelayRequest({
      request,
      sessionId: namedGitFallback.sessionId,
      gitSubPath: namedGitFallback.gitSubPath,
    });
  }

  // Serve API routes
  if (pathname === '/api/v1/serve/register' && request.method === 'POST') {
    const sender = url.searchParams.get('sender') ?? '';
    const repo = url.searchParams.get('repo') ?? '';
    let sessionId: string;

    if (sender && repo) {
      const keyInfoRes = await service.fetch(
        createInternalServiceRequest(
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
void startCacheSyncWorker();

Deno.serve({ hostname: host, port }, handleRequest);
