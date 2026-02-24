import { assert, assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';
import { createGitServeSession } from '../src/git_serve_session.ts';
import { type CacheStore, createMemoryCacheStore } from '../src/cache_store.ts';
import {
  buildGitCacheKeyFromRequest,
  CACHE_HIT_HEADER,
  safeReadGitCache,
  safeWriteGitCache,
} from '../src/git_cache_layer.ts';

interface RelayHarness {
  baseUrl: string;
  cleanupSession(sessionId: string): void;
  dropSession(sessionId: string): void;
  shutdown(): Promise<void>;
}

function createRelayHarness(options: { cacheStore?: CacheStore } = {}): RelayHarness {
  const service = createMemoryRelayService({ requireSignatures: false });
  const sessions = new Map<string, ReturnType<typeof createGitServeSession>>();
  const cacheStore = options.cacheStore ?? createMemoryCacheStore();
  const cleanupFns: Array<() => void> = [];

  function generateSessionId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => chars[value % chars.length]).join('');
  }

  function extractToken(url: URL, headers: Headers): string {
    return url.searchParams.get('session_token') ?? headers.get('x-session-token') ?? '';
  }

  async function handleGitRequest(
    request: Request,
    sessionId: string,
    gitSubPath: string,
  ): Promise<Response> {
    const cacheKey = await buildGitCacheKeyFromRequest(
      request.clone(),
      sessionId,
      `/${gitSubPath}`,
    );
    const cached = await safeReadGitCache(cacheStore, cacheKey);
    const session = sessions.get(sessionId);
    if (!session) {
      if (cached) return cached;
      return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
    }

    const sessionUrl = new URL(request.url);
    sessionUrl.pathname = `/git/${gitSubPath}`;
    const sessionRequest = new Request(sessionUrl.toString(), request);
    const response = await session.fetch(sessionRequest);
    if (response.status === 200) {
      await safeWriteGitCache(cacheStore, cacheKey, response);
      return response;
    }
    if (cached && (response.status === 404 || response.status === 410)) {
      return cached;
    }
    return response;
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const gitMatch = path.match(/^\/git\/([a-z0-9]+)\/(.*)/);
    if (gitMatch) {
      return handleGitRequest(request, gitMatch[1], gitMatch[2]);
    }

    if (path === '/api/v1/serve/register' && request.method === 'POST') {
      const sessionId = generateSessionId();
      const session = createGitServeSession();
      sessions.set(sessionId, session);
      cleanupFns.push(session.cleanup);
      const registerRes = await session.fetch(
        new Request('http://do/register', { method: 'POST' }),
      );
      const body = await registerRes.json() as Record<string, unknown>;
      return Response.json({ ...body, session_id: sessionId });
    }

    if (path === '/api/v1/serve/poll' && request.method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      const session = sessions.get(sessionId);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const timeout = url.searchParams.get('timeout') ?? '30';
      const token = extractToken(url, request.headers);
      return session.fetch(
        new Request(
          `http://do/poll?timeout=${encodeURIComponent(timeout)}&session_token=${
            encodeURIComponent(token)
          }`,
        ),
      );
    }

    if (path === '/api/v1/serve/respond' && request.method === 'POST') {
      const sessionId = url.searchParams.get('session') ?? '';
      const session = sessions.get(sessionId);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const token = extractToken(url, request.headers);
      return session.fetch(
        new Request(`http://do/respond?session_token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        }),
      );
    }

    return service.fetch(request);
  }

  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, handler);
  const baseUrl = `http://127.0.0.1:${server.addr.port}`;

  return {
    baseUrl,
    cleanupSession(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.cleanup();
    },
    dropSession(sessionId: string) {
      sessions.delete(sessionId);
    },
    async shutdown() {
      for (const fn of cleanupFns) fn();
      service.close();
      await server.shutdown();
    },
  };
}

async function registerNode(
  baseUrl: string,
): Promise<{ sessionId: string; sessionToken: string }> {
  const res = await fetch(`${baseUrl}/api/v1/serve/register`, { method: 'POST' });
  assertEquals(res.status, 200);
  const body = await res.json() as { session_id: string; session_token: string };
  return {
    sessionId: body.session_id,
    sessionToken: body.session_token,
  };
}

function createAlwaysFailingCacheStore(): CacheStore {
  return {
    async put(): Promise<void> {
      throw new Error('cache put failed');
    },
    async get(): Promise<null> {
      throw new Error('cache get failed');
    },
    async delete(): Promise<boolean> {
      throw new Error('cache delete failed');
    },
    async list() {
      throw new Error('cache list failed');
    },
  };
}

Deno.test('e2e git cache degraded mode: cache backend failures do not block live git relay', async () => {
  const relay = createRelayHarness({ cacheStore: createAlwaysFailingCacheStore() });
  try {
    const node = await registerNode(relay.baseUrl);

    const firstPromise = fetch(
      `${relay.baseUrl}/git/${node.sessionId}/info/refs?service=git-upload-pack&session_token=${node.sessionToken}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    const pollRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/poll?session=${node.sessionId}&timeout=2&session_token=${node.sessionToken}`,
    );
    const pollBody = await pollRes.json() as { requests: Array<{ request_id: string }> };
    assert(pollBody.requests.length > 0);

    const respondRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/respond?session=${node.sessionId}&session_token=${node.sessionToken}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: pollBody.requests[0].request_id,
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          body_base64: btoa('refs-live'),
        }),
      },
    );
    assertEquals(respondRes.status, 200);
    await respondRes.json();

    const first = await firstPromise;
    assertEquals(first.status, 200);
    assertEquals(await first.text(), 'refs-live');
    assertEquals(first.headers.get(CACHE_HIT_HEADER), null);

    relay.cleanupSession(node.sessionId);
    relay.dropSession(node.sessionId);

    const second = await fetch(
      `${relay.baseUrl}/git/${node.sessionId}/info/refs?service=git-upload-pack&session_token=${node.sessionToken}`,
    );
    assertEquals(second.status, 404);
    assertObjectMatch(await second.json(), { ok: false, error: 'session not found' });
  } finally {
    await relay.shutdown();
  }
});

Deno.test('e2e git cache fallback: serves cached info/refs when session inactive', async () => {
  const relay = createRelayHarness();
  try {
    const node = await registerNode(relay.baseUrl);

    const firstPromise = fetch(
      `${relay.baseUrl}/git/${node.sessionId}/info/refs?service=git-upload-pack&session_token=${node.sessionToken}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    const pollRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/poll?session=${node.sessionId}&timeout=2&session_token=${node.sessionToken}`,
    );
    const pollBody = await pollRes.json() as { requests: Array<{ request_id: string }> };
    assert(pollBody.requests.length > 0);

    const respondRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/respond?session=${node.sessionId}&session_token=${node.sessionToken}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: pollBody.requests[0].request_id,
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          body_base64: btoa('refs-v1'),
        }),
      },
    );
    assertEquals(respondRes.status, 200);
    await respondRes.json();

    const first = await firstPromise;
    assertEquals(first.status, 200);
    assertEquals(await first.text(), 'refs-v1');
    assertEquals(first.headers.get(CACHE_HIT_HEADER), null);

    relay.cleanupSession(node.sessionId);

    const second = await fetch(
      `${relay.baseUrl}/git/${node.sessionId}/info/refs?service=git-upload-pack&session_token=${node.sessionToken}`,
    );
    assertEquals(second.status, 200);
    assertEquals(await second.text(), 'refs-v1');
    assertEquals(second.headers.get(CACHE_HIT_HEADER), '1');

    relay.dropSession(node.sessionId);

    const third = await fetch(
      `${relay.baseUrl}/git/${node.sessionId}/info/refs?service=git-upload-pack&session_token=${node.sessionToken}`,
    );
    assertEquals(third.status, 200);
    assertEquals(await third.text(), 'refs-v1');
    assertEquals(third.headers.get(CACHE_HIT_HEADER), '1');
  } finally {
    await relay.shutdown();
  }
});

Deno.test('e2e git cache fallback: POST cache key is request-body sensitive', async () => {
  const relay = createRelayHarness();
  try {
    const node = await registerNode(relay.baseUrl);
    const postUrl =
      `${relay.baseUrl}/git/${node.sessionId}/git-upload-pack?session_token=${node.sessionToken}`;
    const reqBody = 'want-commit-a';

    const firstPromise = fetch(postUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body: reqBody,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const pollRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/poll?session=${node.sessionId}&timeout=2&session_token=${node.sessionToken}`,
    );
    const pollBody = await pollRes.json() as { requests: Array<{ request_id: string }> };
    assert(pollBody.requests.length > 0);

    const respondRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/respond?session=${node.sessionId}&session_token=${node.sessionToken}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: pollBody.requests[0].request_id,
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
          body_base64: btoa('PACK-A'),
        }),
      },
    );
    assertEquals(respondRes.status, 200);
    await respondRes.json();

    const first = await firstPromise;
    assertEquals(first.status, 200);
    assertEquals(await first.text(), 'PACK-A');
    assertEquals(first.headers.get(CACHE_HIT_HEADER), null);

    relay.cleanupSession(node.sessionId);
    relay.dropSession(node.sessionId);

    const cached = await fetch(postUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body: reqBody,
    });
    assertEquals(cached.status, 200);
    assertEquals(await cached.text(), 'PACK-A');
    assertEquals(cached.headers.get(CACHE_HIT_HEADER), '1');

    const miss = await fetch(postUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body: 'want-commit-b',
    });
    assertEquals(miss.status, 404);
    assertObjectMatch(await miss.json(), { ok: false, error: 'session not found' });
  } finally {
    await relay.shutdown();
  }
});
