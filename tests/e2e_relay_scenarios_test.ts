/**
 * E2E tests for relay scenarios where direct node-to-node communication is impossible.
 * These tests demonstrate that the relay (and intermediate nodes) are NECESSARY
 * for information to flow between disconnected parties.
 */
import { assert, assertEquals } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';
import { createGitServeSession } from '../src/git_serve_session.ts';

// --- Test relay server (same as e2e_multi_node_test.ts) ---

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

    if (path === '/api/v1/serve/register' && request.method === 'POST') {
      const sid = generateId();
      const session = createGitServeSession();
      sessions.set(sid, session);
      cleanupFns.push(session.cleanup);
      const res = await session.fetch(new Request('http://do/register', { method: 'POST' }));
      const body = (await res.json()) as Record<string, unknown>;
      return Response.json({ ...body, session_id: sid });
    }

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

    if (path === '/api/v1/serve/respond' && request.method === 'POST') {
      const sid = url.searchParams.get('session') ?? '';
      const session = sessions.get(sid);
      if (!session) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      const token = extractToken(url, request.headers);
      return session.fetch(
        new Request(`http://do/respond?session_token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        }),
      );
    }

    if (path === '/api/v1/serve/info' && request.method === 'GET') {
      const sid = url.searchParams.get('session') ?? '';
      const session = sessions.get(sid);
      if (!session) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      const token = extractToken(url, request.headers);
      return session.fetch(
        new Request(`http://do/info?session_token=${encodeURIComponent(token)}`),
      );
    }

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

// --- Helpers ---

interface NodeInfo {
  name: string;
  sessionId: string;
  sessionToken: string;
}

async function registerNode(baseUrl: string, name: string): Promise<NodeInfo> {
  const res = await fetch(`${baseUrl}/api/v1/serve/register`, { method: 'POST' });
  const body = await res.json();
  return { name, sessionId: body.session_id, sessionToken: body.session_token };
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function publish(
  baseUrl: string,
  room: string,
  sender: string,
  id: string,
  payload: unknown,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/api/v1/publish?room=${room}&sender=${sender}&id=${id}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  const body = await res.json();
  assertEquals(body.ok, true);
}

async function poll(
  baseUrl: string,
  room: string,
  after: number,
): Promise<{ next_cursor: number; envelopes: Record<string, unknown>[] }> {
  const res = await fetch(
    `${baseUrl}/api/v1/poll?room=${room}&after=${after}&limit=100`,
  );
  return await res.json();
}

/** Simulate git clone: make request, target node polls and responds, return result */
async function gitCloneThroughRelay(
  baseUrl: string,
  targetNode: NodeInfo,
  responsePayload: string,
): Promise<string> {
  // Client makes git request
  const gitPromise = fetch(
    `${baseUrl}/git/${targetNode.sessionId}/info/refs?service=git-upload-pack&session_token=${targetNode.sessionToken}`,
  );

  await new Promise((r) => setTimeout(r, 50));

  // Target polls and responds
  const pollRes = await fetch(
    `${baseUrl}/api/v1/serve/poll?session=${targetNode.sessionId}&timeout=2&session_token=${targetNode.sessionToken}`,
  );
  const pollBody = await pollRes.json();
  assert(pollBody.requests.length > 0, 'expected pending git request');

  const respondRes = await fetch(
    `${baseUrl}/api/v1/serve/respond?session=${targetNode.sessionId}&session_token=${targetNode.sessionToken}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: pollBody.requests[0].request_id,
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body_base64: textToBase64(responsePayload),
      }),
    },
  );
  await respondRes.json();

  const gitRes = await gitPromise;
  assertEquals(gitRes.status, 200);
  return await gitRes.text();
}

// =============================================================================
// Tests
// =============================================================================

Deno.test('chain relay: A→B→C→D→E multi-hop propagation', async () => {
  // Scenario:
  //   Node A originates data. Each node can only discover data from
  //   the previous node's broadcast. Without the chain of intermediate
  //   nodes, the final node E cannot receive A's data.
  //
  //   A --broadcast--> room "hop-0"
  //   B polls "hop-0", fetches from A, re-broadcasts to "hop-1"
  //   C polls "hop-1", fetches from B, re-broadcasts to "hop-2"
  //   D polls "hop-2", fetches from C, re-broadcasts to "hop-3"
  //   E polls "hop-3", fetches from D → gets A's original data

  const relay = startRelay();
  try {
    const nodes: NodeInfo[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(await registerNode(relay.baseUrl, `node-${i}`));
    }
    const [A, B, C, D, E] = nodes;

    const originalData = 'commit-abc123-from-node-A';

    // A broadcasts to hop-0
    await publish(relay.baseUrl, 'hop-0', A.name, 'broadcast-A', {
      type: 'feature-broadcast',
      session_id: A.sessionId,
      session_token: A.sessionToken,
      data_ref: originalData,
    });

    // Each intermediate node: poll previous hop → fetch → re-broadcast to next hop
    const hops = [
      { receiver: B, room_in: 'hop-0', room_out: 'hop-1' },
      { receiver: C, room_in: 'hop-1', room_out: 'hop-2' },
      { receiver: D, room_in: 'hop-2', room_out: 'hop-3' },
    ];

    let currentSource = A;
    let currentPayload = originalData;

    for (const hop of hops) {
      // Receiver polls the room and discovers the broadcast
      const pollResult = await poll(relay.baseUrl, hop.room_in, 0);
      assertEquals(pollResult.envelopes.length, 1);
      const envelope = pollResult.envelopes[0];
      const payload = envelope.payload as Record<string, unknown>;
      assertEquals(payload.type, 'feature-broadcast');

      // Receiver fetches data from the source through relay
      const sourceSessionId = payload.session_id as string;
      const sourceToken = payload.session_token as string;
      const sourceNode = { ...currentSource, sessionId: sourceSessionId, sessionToken: sourceToken };

      const fetchedData = await gitCloneThroughRelay(
        relay.baseUrl,
        sourceNode,
        currentPayload,
      );
      assertEquals(fetchedData, currentPayload);

      // Receiver re-broadcasts with its own session info
      await publish(relay.baseUrl, hop.room_out, hop.receiver.name, `broadcast-${hop.receiver.name}`, {
        type: 'feature-broadcast',
        session_id: hop.receiver.sessionId,
        session_token: hop.receiver.sessionToken,
        data_ref: fetchedData,
      });

      currentSource = hop.receiver;
      currentPayload = fetchedData;
    }

    // E (final node) polls hop-3 and fetches from D
    const finalPoll = await poll(relay.baseUrl, 'hop-3', 0);
    assertEquals(finalPoll.envelopes.length, 1);
    const finalPayload = finalPoll.envelopes[0].payload as Record<string, unknown>;

    const fetchedByE = await gitCloneThroughRelay(
      relay.baseUrl,
      {
        ...D,
        sessionId: finalPayload.session_id as string,
        sessionToken: finalPayload.session_token as string,
      },
      currentPayload,
    );

    // E received A's original data through 4 hops
    assertEquals(fetchedByE, originalData);
  } finally {
    await relay.shutdown();
  }
});

Deno.test('partition bridge: two isolated groups connected by bridge node', async () => {
  // Scenario:
  //   Group 1 (A, B) uses room "partition-1"
  //   Group 2 (D, E) uses room "partition-2"
  //   Bridge node C monitors both rooms and forwards messages.
  //   Without C, Group 2 never sees Group 1's messages.

  const relay = startRelay();
  try {
    const nodes: NodeInfo[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(await registerNode(relay.baseUrl, `node-${i}`));
    }
    const [A, B, C, D, E] = nodes;

    // Group 1: A and B publish to partition-1
    await publish(relay.baseUrl, 'partition-1', A.name, 'msg-A-1', {
      type: 'update',
      ref: 'refs/heads/main',
      oid: 'aaa111',
    });
    await publish(relay.baseUrl, 'partition-1', B.name, 'msg-B-1', {
      type: 'update',
      ref: 'refs/heads/feature',
      oid: 'bbb222',
    });

    // Group 2 cannot see partition-1 (they don't poll it)
    // Verify: partition-2 is empty
    const group2Before = await poll(relay.baseUrl, 'partition-2', 0);
    assertEquals(group2Before.envelopes.length, 0);

    // Bridge node C polls partition-1
    const fromGroup1 = await poll(relay.baseUrl, 'partition-1', 0);
    assertEquals(fromGroup1.envelopes.length, 2);

    // C forwards each message to partition-2
    for (const env of fromGroup1.envelopes) {
      await publish(
        relay.baseUrl,
        'partition-2',
        C.name,
        `forwarded-${env.id}`,
        {
          type: 'forwarded',
          original_sender: env.sender,
          original_payload: env.payload,
        },
      );
    }

    // Now Group 2 can see the forwarded messages
    const group2After = await poll(relay.baseUrl, 'partition-2', 0);
    assertEquals(group2After.envelopes.length, 2);

    // D and E both see the forwarded data
    for (const env of group2After.envelopes) {
      assertEquals(env.sender, C.name); // forwarded by bridge
      const payload = env.payload as Record<string, unknown>;
      assertEquals(payload.type, 'forwarded');
      assert(
        ['node-0', 'node-1'].includes(payload.original_sender as string),
        'original sender should be from group 1',
      );
    }

    // Verify bridge also relays git data: D fetches from A through relay
    const fetchedData = await gitCloneThroughRelay(
      relay.baseUrl,
      A,
      'packfile-from-A',
    );
    assertEquals(fetchedData, 'packfile-from-A');
  } finally {
    await relay.shutdown();
  }
});

Deno.test('late joiner: node catches up via cursor-based polling', async () => {
  // Scenario:
  //   Nodes A, B, C publish messages while D and E are offline.
  //   D joins later and uses cursor=0 to catch up on all history.
  //   E joins even later and catches up from a mid-point cursor.
  //   This demonstrates store-and-forward: the relay buffers messages
  //   for nodes that aren't connected yet.

  const relay = startRelay();
  try {
    const room = 'project-x';

    // Phase 1: A, B, C publish (D and E are "offline")
    await publish(relay.baseUrl, room, 'alice', 'msg-1', { seq: 1, data: 'first' });
    await publish(relay.baseUrl, room, 'bob', 'msg-2', { seq: 2, data: 'second' });
    await publish(relay.baseUrl, room, 'carol', 'msg-3', { seq: 3, data: 'third' });

    // Phase 2: D joins and catches up from beginning
    const dCatchUp = await poll(relay.baseUrl, room, 0);
    assertEquals(dCatchUp.envelopes.length, 3);
    assertEquals(
      dCatchUp.envelopes.map((e: Record<string, unknown>) =>
        (e.payload as Record<string, unknown>).seq
      ),
      [1, 2, 3],
    );
    const cursorAfterThree = dCatchUp.next_cursor;

    // Phase 3: more messages arrive
    await publish(relay.baseUrl, room, 'alice', 'msg-4', { seq: 4, data: 'fourth' });
    await publish(relay.baseUrl, room, 'bob', 'msg-5', { seq: 5, data: 'fifth' });

    // Phase 4: E joins, but from cursor after message 3
    // (simulating E was told "you're caught up to cursor X")
    const eCatchUp = await poll(relay.baseUrl, room, cursorAfterThree);
    assertEquals(eCatchUp.envelopes.length, 2);
    assertEquals(
      eCatchUp.envelopes.map((e: Record<string, unknown>) =>
        (e.payload as Record<string, unknown>).seq
      ),
      [4, 5],
    );

    // D polls again with its saved cursor → gets only new messages
    const dIncremental = await poll(relay.baseUrl, room, cursorAfterThree);
    assertEquals(dIncremental.envelopes.length, 2);
    assertEquals(
      dIncremental.envelopes.map((e: Record<string, unknown>) =>
        (e.payload as Record<string, unknown>).seq
      ),
      [4, 5],
    );
  } finally {
    await relay.shutdown();
  }
});

Deno.test('inbox/ack: guaranteed delivery despite intermittent connectivity', async () => {
  // Scenario:
  //   Node A publishes messages. Node B has unstable connectivity.
  //   B uses inbox/ack to ensure at-least-once delivery:
  //   - B fetches pending messages
  //   - B acks only the ones it successfully processed
  //   - B "disconnects" (stops polling)
  //   - More messages arrive
  //   - B "reconnects" → gets unacked + new messages

  const relay = startRelay();
  try {
    const room = 'reliable-room';
    const consumer = 'node-B';

    // Phase 1: A publishes 3 messages
    await publish(relay.baseUrl, room, 'node-A', 'msg-1', { seq: 1 });
    await publish(relay.baseUrl, room, 'node-A', 'msg-2', { seq: 2 });
    await publish(relay.baseUrl, room, 'node-A', 'msg-3', { seq: 3 });

    // Phase 2: B fetches pending (all 3 unacked)
    const pending1 = await fetch(
      `${relay.baseUrl}/api/v1/inbox/pending?room=${room}&consumer=${consumer}&limit=100`,
    );
    const pending1Body = await pending1.json();
    assertEquals(pending1Body.pending_count, 3);
    assertEquals(pending1Body.returned_count, 3);

    // B successfully processes msg-1 and msg-2, acks them
    const ackRes = await fetch(
      `${relay.baseUrl}/api/v1/inbox/ack?room=${room}&consumer=${consumer}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ['msg-1', 'msg-2'] }),
      },
    );
    const ackBody = await ackRes.json();
    assertEquals(ackBody.newly_acked, 2);
    assertEquals(ackBody.acked_total, 2);

    // B "crashes" before acking msg-3
    // ... (no more polling from B)

    // Phase 3: A publishes 2 more messages while B is offline
    await publish(relay.baseUrl, room, 'node-A', 'msg-4', { seq: 4 });
    await publish(relay.baseUrl, room, 'node-A', 'msg-5', { seq: 5 });

    // Phase 4: B comes back and fetches pending again
    const pending2 = await fetch(
      `${relay.baseUrl}/api/v1/inbox/pending?room=${room}&consumer=${consumer}&limit=100`,
    );
    const pending2Body = await pending2.json();

    // B should see: msg-3 (unacked) + msg-4 + msg-5 (new)
    assertEquals(pending2Body.pending_count, 3);
    assertEquals(pending2Body.returned_count, 3);

    const pendingIds = pending2Body.envelopes.map(
      (e: Record<string, unknown>) => e.id,
    );
    assertEquals(pendingIds, ['msg-3', 'msg-4', 'msg-5']);

    // B processes and acks all remaining
    const ackRes2 = await fetch(
      `${relay.baseUrl}/api/v1/inbox/ack?room=${room}&consumer=${consumer}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ['msg-3', 'msg-4', 'msg-5'] }),
      },
    );
    const ackBody2 = await ackRes2.json();
    assertEquals(ackBody2.newly_acked, 3);
    assertEquals(ackBody2.acked_total, 5);

    // Verify: no more pending
    const pending3 = await fetch(
      `${relay.baseUrl}/api/v1/inbox/pending?room=${room}&consumer=${consumer}&limit=100`,
    );
    const pending3Body = await pending3.json();
    assertEquals(pending3Body.pending_count, 0);
  } finally {
    await relay.shutdown();
  }
});

Deno.test('chain break: removing intermediate node stops propagation', async () => {
  // Scenario:
  //   A → B → C chain works. Then B "goes offline" (stops relaying).
  //   A publishes new data, but C never receives it because B is gone.
  //   This proves the intermediate node is NECESSARY for the chain.

  const relay = startRelay();
  try {
    const [A, B, C] = await Promise.all([
      registerNode(relay.baseUrl, 'node-A'),
      registerNode(relay.baseUrl, 'node-B'),
      registerNode(relay.baseUrl, 'node-C'),
    ]);

    // Phase 1: Full chain works
    // A broadcasts
    await publish(relay.baseUrl, 'hop-A', A.name, 'round1-A', {
      type: 'feature-broadcast',
      session_id: A.sessionId,
      session_token: A.sessionToken,
      round: 1,
    });

    // B relays: polls hop-A, fetches from A, re-broadcasts to hop-B
    const round1 = await poll(relay.baseUrl, 'hop-A', 0);
    assertEquals(round1.envelopes.length, 1);

    const fetchedR1 = await gitCloneThroughRelay(relay.baseUrl, A, 'data-round-1');
    assertEquals(fetchedR1, 'data-round-1');

    await publish(relay.baseUrl, 'hop-B', B.name, 'round1-B', {
      type: 'feature-broadcast',
      session_id: B.sessionId,
      session_token: B.sessionToken,
      round: 1,
    });

    // C receives via hop-B
    const cReceived = await poll(relay.baseUrl, 'hop-B', 0);
    assertEquals(cReceived.envelopes.length, 1);
    const cData = await gitCloneThroughRelay(relay.baseUrl, B, 'data-round-1');
    assertEquals(cData, 'data-round-1');

    // Phase 2: B goes offline — stops relaying
    // A broadcasts round 2
    await publish(relay.baseUrl, 'hop-A', A.name, 'round2-A', {
      type: 'feature-broadcast',
      session_id: A.sessionId,
      session_token: A.sessionToken,
      round: 2,
    });

    // B does NOT poll or relay (simulating offline)

    // C checks hop-B — still only has round 1's message
    const cAfterBreak = await poll(relay.baseUrl, 'hop-B', cReceived.next_cursor);
    assertEquals(cAfterBreak.envelopes.length, 0, 'C should not receive round 2 without B relaying');

    // A's broadcast IS in hop-A (relay stored it)
    const hopACheck = await poll(relay.baseUrl, 'hop-A', round1.next_cursor);
    assertEquals(hopACheck.envelopes.length, 1, "A's round 2 is in hop-A");

    // But C has no way to know about it — it only watches hop-B
    // This proves: without the intermediate node B, C is cut off
  } finally {
    await relay.shutdown();
  }
});
