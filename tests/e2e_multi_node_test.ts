import { assert, assertEquals } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';
import { createGitServeSession } from '../src/git_serve_session.ts';

// --- Test relay server (mirrors deno_main.ts routing) ---

function createRelayHandler() {
  const service = createMemoryRelayService({ requireSignatures: false });
  const sessions = new Map<string, ReturnType<typeof createGitServeSession>>();
  const cleanupFns: (() => void)[] = [];

  function generateId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  function extractToken(url: URL, headers: Headers): string {
    return url.searchParams.get('session_token') ?? headers.get('x-session-token') ?? '';
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') return new Response('ok');

    // Git routes: /git/<session_id>/...
    const gitMatch = path.match(/^\/git\/([a-z0-9]+)\/(.*)/);
    if (gitMatch) {
      const session = sessions.get(gitMatch[1]);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const doUrl = new URL(request.url);
      doUrl.pathname = '/git/' + gitMatch[2];
      const init: RequestInit = { method: request.method, headers: request.headers };
      if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
      return session.fetch(new Request(doUrl.toString(), init));
    }

    // Serve register
    if (path === '/api/v1/serve/register' && request.method === 'POST') {
      const sid = generateId();
      const session = createGitServeSession();
      sessions.set(sid, session);
      cleanupFns.push(session.cleanup);
      const res = await session.fetch(new Request('http://do/register', { method: 'POST' }));
      const body = (await res.json()) as Record<string, unknown>;
      return Response.json({ ...body, session_id: sid });
    }

    // Serve poll
    if (path === '/api/v1/serve/poll' && request.method === 'GET') {
      const sid = url.searchParams.get('session') ?? '';
      const session = sessions.get(sid);
      if (!session) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      const timeout = url.searchParams.get('timeout') ?? '30';
      const token = extractToken(url, request.headers);
      return session.fetch(
        new Request(
          `http://do/poll?timeout=${timeout}&session_token=${encodeURIComponent(token)}`,
        ),
      );
    }

    // Serve respond
    if (path === '/api/v1/serve/respond' && request.method === 'POST') {
      const sid = url.searchParams.get('session') ?? '';
      const session = sessions.get(sid);
      if (!session) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      const token = extractToken(url, request.headers);
      return session.fetch(
        new Request(
          `http://do/respond?session_token=${encodeURIComponent(token)}`,
          { method: 'POST', headers: request.headers, body: request.body },
        ),
      );
    }

    // Serve info
    if (path === '/api/v1/serve/info' && request.method === 'GET') {
      const sid = url.searchParams.get('session') ?? '';
      const session = sessions.get(sid);
      if (!session) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      const token = extractToken(url, request.headers);
      return session.fetch(
        new Request(`http://do/info?session_token=${encodeURIComponent(token)}`),
      );
    }

    // Fall through to relay service
    return service.fetch(request);
  }

  return {
    handler,
    cleanup() {
      cleanupFns.forEach((fn) => fn());
    },
  };
}

interface TestRelay {
  baseUrl: string;
  shutdown: () => Promise<void>;
}

function startRelay(): TestRelay {
  const { handler, cleanup } = createRelayHandler();
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, handler);
  const baseUrl = `http://127.0.0.1:${server.addr.port}`;
  return {
    baseUrl,
    async shutdown() {
      cleanup();
      await server.shutdown();
    },
  };
}

// --- Node helper ---

interface NodeInfo {
  name: string;
  sessionId: string;
  sessionToken: string;
}

async function registerNode(baseUrl: string, name: string): Promise<NodeInfo> {
  const res = await fetch(`${baseUrl}/api/v1/serve/register`, { method: 'POST' });
  const body = await res.json();
  assertEquals(body.ok, true);
  return { name, sessionId: body.session_id, sessionToken: body.session_token };
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// --- E2E Tests ---

Deno.test('e2e: 5 nodes publish and poll messages in shared room', async () => {
  const relay = startRelay();
  try {
    const room = 'shared-project';
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

    // Each node publishes a message
    await Promise.all(
      names.map(async (name) => {
        const res = await fetch(
          `${relay.baseUrl}/api/v1/publish?room=${room}&sender=${name}&id=msg-${name}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'feature-broadcast', node: name }),
          },
        );
        assertEquals(res.status, 200);
        assertEquals((await res.json()).ok, true);
      }),
    );

    // Each node polls and sees all 5 messages
    const pollRes = await fetch(
      `${relay.baseUrl}/api/v1/poll?room=${room}&after=0&limit=100`,
    );
    const pollBody = await pollRes.json();
    assertEquals(pollBody.ok, true);
    assertEquals(pollBody.envelopes.length, 5);

    const senders = pollBody.envelopes.map((e: Record<string, unknown>) => e.sender).sort();
    assertEquals(senders, ['alpha', 'bravo', 'charlie', 'delta', 'echo']);

    // Verify each message payload
    for (const env of pollBody.envelopes) {
      assertEquals(
        (env as Record<string, Record<string, unknown>>).payload.type,
        'feature-broadcast',
      );
    }
  } finally {
    await relay.shutdown();
  }
});

Deno.test('e2e: 5 nodes register sessions with unique tokens', async () => {
  const relay = startRelay();
  try {
    const nodes: NodeInfo[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(await registerNode(relay.baseUrl, `node-${i}`));
    }

    // All session IDs are unique
    const ids = new Set(nodes.map((n) => n.sessionId));
    assertEquals(ids.size, 5);

    // All tokens are unique
    const tokens = new Set(nodes.map((n) => n.sessionToken));
    assertEquals(tokens.size, 5);

    // Each node's session is active
    for (const node of nodes) {
      const res = await fetch(
        `${relay.baseUrl}/api/v1/serve/info?session=${node.sessionId}&session_token=${node.sessionToken}`,
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.active, true);
    }
  } finally {
    await relay.shutdown();
  }
});

Deno.test('e2e: session tokens are isolated - cross-node access denied', async () => {
  const relay = startRelay();
  try {
    const nodes: NodeInfo[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(await registerNode(relay.baseUrl, `node-${i}`));
    }

    // Every node's token is rejected for every other node's session
    for (let attacker = 0; attacker < 5; attacker++) {
      for (let target = 0; target < 5; target++) {
        if (attacker === target) continue;

        // poll
        const pollRes = await fetch(
          `${relay.baseUrl}/api/v1/serve/poll?session=${
            nodes[target].sessionId
          }&timeout=1&session_token=${nodes[attacker].sessionToken}`,
        );
        assertEquals(pollRes.status, 403, `node-${attacker} should not access node-${target} poll`);
        await pollRes.json(); // drain body

        // info
        const infoRes = await fetch(
          `${relay.baseUrl}/api/v1/serve/info?session=${nodes[target].sessionId}&session_token=${
            nodes[attacker].sessionToken
          }`,
        );
        assertEquals(infoRes.status, 403, `node-${attacker} should not access node-${target} info`);
        await infoRes.json();

        // git request
        const gitRes = await fetch(
          `${relay.baseUrl}/git/${
            nodes[target].sessionId
          }/info/refs?service=git-upload-pack&session_token=${nodes[attacker].sessionToken}`,
        );
        assertEquals(gitRes.status, 403, `node-${attacker} should not access node-${target} git`);
        await gitRes.json();
      }
    }
  } finally {
    await relay.shutdown();
  }
});

Deno.test('e2e: git clone flow - 1 server, 1 client through relay', async () => {
  const relay = startRelay();
  try {
    const server = await registerNode(relay.baseUrl, 'server');
    const _client = await registerNode(relay.baseUrl, 'client');

    // Client makes git request to server's session
    const gitPromise = fetch(
      `${relay.baseUrl}/git/${server.sessionId}/info/refs?service=git-upload-pack&session_token=${server.sessionToken}`,
    );

    await new Promise((r) => setTimeout(r, 50));

    // Server polls for pending requests
    const pollRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/poll?session=${server.sessionId}&timeout=2&session_token=${server.sessionToken}`,
    );
    const poll = await pollRes.json();
    assertEquals(poll.ok, true);
    assertEquals(poll.requests.length, 1);
    assertEquals(poll.requests[0].method, 'GET');
    assert(poll.requests[0].path.includes('/info/refs'));

    // Server responds with fake refs
    const fakeRefs = '001e# service=git-upload-pack\n0000';
    const respondRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/respond?session=${server.sessionId}&session_token=${server.sessionToken}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: poll.requests[0].request_id,
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          body_base64: textToBase64(fakeRefs),
        }),
      },
    );
    assertEquals(respondRes.status, 200);
    await respondRes.json();

    // Client receives the response
    const gitRes = await gitPromise;
    assertEquals(gitRes.status, 200);
    assertEquals(
      gitRes.headers.get('content-type'),
      'application/x-git-upload-pack-advertisement',
    );
    assertEquals(await gitRes.text(), fakeRefs);
  } finally {
    await relay.shutdown();
  }
});

Deno.test('e2e: 4 clients clone from 1 server concurrently', async () => {
  const relay = startRelay();
  try {
    const server = await registerNode(relay.baseUrl, 'server');
    const clients: NodeInfo[] = [];
    for (let i = 0; i < 4; i++) {
      clients.push(await registerNode(relay.baseUrl, `client-${i}`));
    }

    // 4 clients make git requests concurrently
    const gitPromises = clients.map((_c) =>
      fetch(
        `${relay.baseUrl}/git/${server.sessionId}/info/refs?service=git-upload-pack&session_token=${server.sessionToken}`,
      )
    );

    // Wait for requests to be queued
    await new Promise((r) => setTimeout(r, 100));

    // Server polls — should get all 4 requests
    const pollRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/poll?session=${server.sessionId}&timeout=2&session_token=${server.sessionToken}`,
    );
    const poll = await pollRes.json();
    assertEquals(poll.ok, true);
    assertEquals(poll.requests.length, 4);

    // Server responds to each request with a unique body
    for (let i = 0; i < poll.requests.length; i++) {
      const req = poll.requests[i];
      const body = `refs-for-client-${i}`;
      const respondRes = await fetch(
        `${relay.baseUrl}/api/v1/serve/respond?session=${server.sessionId}&session_token=${server.sessionToken}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            request_id: req.request_id,
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body_base64: textToBase64(body),
          }),
        },
      );
      await respondRes.json();
    }

    // All 4 clients receive responses
    const responses = await Promise.all(gitPromises);
    for (const res of responses) {
      assertEquals(res.status, 200);
      const text = await res.text();
      assert(text.startsWith('refs-for-client-'));
    }
  } finally {
    await relay.shutdown();
  }
});

Deno.test('e2e: broadcast triggers cross-node fetch (5 nodes)', async () => {
  const relay = startRelay();
  try {
    const room = 'project-collab';
    const nodes: NodeInfo[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(await registerNode(relay.baseUrl, `node-${i}`));
    }

    // Node 0 pushes and broadcasts feature-broadcast
    const broadcastPayload = {
      type: 'feature-broadcast',
      session_id: nodes[0].sessionId,
      refs: [
        ['refs/heads/main', 'abc123def456'],
        ['refs/heads/feature-x', 'deadbeef0001'],
      ],
    };
    const pubRes = await fetch(
      `${relay.baseUrl}/api/v1/publish?room=${room}&sender=${nodes[0].name}&id=broadcast-1`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(broadcastPayload),
      },
    );
    assertEquals(pubRes.status, 200);
    assertEquals((await pubRes.json()).ok, true);

    // Nodes 1-4 poll the room and detect the broadcast
    const pollers = nodes.slice(1).map(async (_node) => {
      const res = await fetch(
        `${relay.baseUrl}/api/v1/poll?room=${room}&after=0&limit=10`,
      );
      const body = await res.json();
      assertEquals(body.ok, true);
      assertEquals(body.envelopes.length, 1);

      const envelope = body.envelopes[0];
      assertEquals(envelope.sender, nodes[0].name);
      assertEquals(envelope.payload.type, 'feature-broadcast');
      assertEquals(envelope.payload.session_id, nodes[0].sessionId);
      return envelope;
    });
    const envelopes = await Promise.all(pollers);

    // All 4 nodes detected the same broadcast
    assertEquals(envelopes.length, 4);

    // Node 1 simulates auto-fetch: makes git clone request to Node 0's session
    const gitPromise = fetch(
      `${relay.baseUrl}/git/${nodes[0].sessionId}/info/refs?service=git-upload-pack&session_token=${
        nodes[0].sessionToken
      }`,
    );

    await new Promise((r) => setTimeout(r, 50));

    // Node 0 polls and handles the git request
    const servePoll = await fetch(
      `${relay.baseUrl}/api/v1/serve/poll?session=${nodes[0].sessionId}&timeout=2&session_token=${
        nodes[0].sessionToken
      }`,
    );
    const servePollBody = await servePoll.json();
    assertEquals(servePollBody.requests.length, 1);

    // Node 0 responds with fake packfile
    const fakePack = 'PACK\x00\x00\x00\x02\x00\x00\x00\x00';
    const respondRes = await fetch(
      `${relay.baseUrl}/api/v1/serve/respond?session=${nodes[0].sessionId}&session_token=${
        nodes[0].sessionToken
      }`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: servePollBody.requests[0].request_id,
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
          body_base64: textToBase64(fakePack),
        }),
      },
    );
    await respondRes.json();

    // Node 1 receives the packfile
    const gitRes = await gitPromise;
    assertEquals(gitRes.status, 200);
    assertEquals(
      gitRes.headers.get('content-type'),
      'application/x-git-upload-pack-result',
    );
    const received = await gitRes.text();
    assertEquals(received, fakePack);
  } finally {
    await relay.shutdown();
  }
});

Deno.test('e2e: no token → git request returns 403', async () => {
  const relay = startRelay();
  try {
    const node = await registerNode(relay.baseUrl, 'server');

    // Request without token
    const res1 = await fetch(
      `${relay.baseUrl}/git/${node.sessionId}/info/refs?service=git-upload-pack`,
    );
    assertEquals(res1.status, 403);
    await res1.json();

    // Request with wrong token
    const res2 = await fetch(
      `${relay.baseUrl}/git/${node.sessionId}/info/refs?service=git-upload-pack&session_token=bad`,
    );
    assertEquals(res2.status, 403);
    await res2.json();
  } finally {
    await relay.shutdown();
  }
});
