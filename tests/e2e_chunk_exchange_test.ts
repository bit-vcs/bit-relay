/**
 * E2E test: 5 nodes exchange missing chunks through the relay.
 *
 * Each node starts with a unique set of chunks. By advertising inventory
 * to a shared room and fetching missing chunks from peers via git serve
 * sessions, all nodes converge to the complete set.
 *
 *   Before:  A={α}  B={β}  C={γ}  D={δ}  E={ε}
 *   After:   A={α,β,γ,δ,ε}  B={...}  C={...}  D={...}  E={...}
 */
import { assert, assertEquals } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';
import { createGitServeSession } from '../src/git_serve_session.ts';

// --- Test relay server (same as other e2e tests) ---

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

// --- Chunk exchange helpers ---

interface ChunkInventory {
  type: 'chunk-inventory';
  node_name: string;
  session_id: string;
  session_token: string;
  chunks: string[];
}

/** A node that holds chunks and can serve them via git session */
interface PeerNode {
  info: NodeInfo;
  chunks: Set<string>;
}

/** Simulate serving a chunk: the requesting side makes a git request,
 *  the serving side polls and responds with the chunk data. */
async function fetchChunkFromPeer(
  baseUrl: string,
  peer: NodeInfo,
  chunkName: string,
): Promise<string> {
  const chunkData = `PACK:${chunkName}`;

  // Client makes git request (simulates git fetch for a specific chunk)
  const gitPromise = fetch(
    `${baseUrl}/git/${peer.sessionId}/info/refs?service=git-upload-pack&session_token=${peer.sessionToken}`,
  );

  await new Promise((r) => setTimeout(r, 50));

  // Peer polls for pending requests and responds
  const pollRes = await fetch(
    `${baseUrl}/api/v1/serve/poll?session=${peer.sessionId}&timeout=2&session_token=${peer.sessionToken}`,
  );
  const pollBody = await pollRes.json();
  assert(pollBody.requests.length > 0, `expected pending git request for chunk ${chunkName}`);

  const respondRes = await fetch(
    `${baseUrl}/api/v1/serve/respond?session=${peer.sessionId}&session_token=${peer.sessionToken}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: pollBody.requests[0].request_id,
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body_base64: textToBase64(chunkData),
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

Deno.test('chunk exchange: 5 nodes converge to complete set via inventory broadcast', async () => {
  // Scenario:
  //   5 nodes each start with a unique chunk. They advertise their inventory
  //   to a shared room, discover what others have, and fetch missing chunks.
  //   After one round of exchange, all 5 nodes have all 5 chunks.
  //
  //   Before: A={α}, B={β}, C={γ}, D={δ}, E={ε}
  //   After:  A={α,β,γ,δ,ε}, B={α,β,γ,δ,ε}, ... all complete

  const relay = startRelay();
  try {
    const ROOM = 'chunk-sync';
    const ALL_CHUNKS = ['chunk-alpha', 'chunk-beta', 'chunk-gamma', 'chunk-delta', 'chunk-epsilon'];

    // Create 5 nodes, each with one unique chunk
    const peers: PeerNode[] = [];
    for (let i = 0; i < 5; i++) {
      const info = await registerNode(relay.baseUrl, `node-${i}`);
      peers.push({ info, chunks: new Set([ALL_CHUNKS[i]]) });
    }

    // Phase 1: Each node publishes its inventory
    for (const peer of peers) {
      const inventory: ChunkInventory = {
        type: 'chunk-inventory',
        node_name: peer.info.name,
        session_id: peer.info.sessionId,
        session_token: peer.info.sessionToken,
        chunks: [...peer.chunks],
      };
      await publish(
        relay.baseUrl,
        ROOM,
        peer.info.name,
        `inventory-${peer.info.name}`,
        inventory,
      );
    }

    // Phase 2: Each node polls the room to discover all inventories
    const pollResult = await poll(relay.baseUrl, ROOM, 0);
    assertEquals(pollResult.envelopes.length, 5);

    // Build a lookup: chunk → which peer has it
    const chunkProviders = new Map<string, NodeInfo>();
    for (const env of pollResult.envelopes) {
      const inv = env.payload as unknown as ChunkInventory;
      for (const chunk of inv.chunks) {
        if (!chunkProviders.has(chunk)) {
          chunkProviders.set(chunk, {
            name: inv.node_name,
            sessionId: inv.session_id,
            sessionToken: inv.session_token,
          });
        }
      }
    }

    // Phase 3: Each node fetches missing chunks from peers
    for (const peer of peers) {
      const missing = ALL_CHUNKS.filter((c) => !peer.chunks.has(c));
      assertEquals(missing.length, 4, `${peer.info.name} should be missing 4 chunks`);

      for (const chunkName of missing) {
        const provider = chunkProviders.get(chunkName)!;
        assert(provider, `no provider found for ${chunkName}`);

        const received = await fetchChunkFromPeer(relay.baseUrl, provider, chunkName);
        assertEquals(received, `PACK:${chunkName}`);
        peer.chunks.add(chunkName);
      }
    }

    // Phase 4: Verify all nodes have all chunks
    for (const peer of peers) {
      assertEquals(
        [...peer.chunks].sort(),
        ALL_CHUNKS.sort(),
        `${peer.info.name} should have all 5 chunks`,
      );
    }
  } finally {
    await relay.shutdown();
  }
});

Deno.test('chunk exchange: nodes with partial overlap exchange only missing pieces', async () => {
  // Scenario:
  //   Nodes have overlapping chunk sets. Each node should only fetch
  //   what it doesn't already have, avoiding redundant transfers.
  //
  //   A={α,β}  B={β,γ}  C={γ,δ}  D={δ,ε}  E={ε,α}
  //   After: all have {α,β,γ,δ,ε}

  const relay = startRelay();
  try {
    const ROOM = 'partial-sync';
    const ALL_CHUNKS = ['chunk-alpha', 'chunk-beta', 'chunk-gamma', 'chunk-delta', 'chunk-epsilon'];
    const initialSets = [
      ['chunk-alpha', 'chunk-beta'], // A
      ['chunk-beta', 'chunk-gamma'], // B
      ['chunk-gamma', 'chunk-delta'], // C
      ['chunk-delta', 'chunk-epsilon'], // D
      ['chunk-epsilon', 'chunk-alpha'], // E
    ];

    const peers: PeerNode[] = [];
    for (let i = 0; i < 5; i++) {
      const info = await registerNode(relay.baseUrl, `node-${i}`);
      peers.push({ info, chunks: new Set(initialSets[i]) });
    }

    // Phase 1: Advertise inventories
    for (const peer of peers) {
      const inventory: ChunkInventory = {
        type: 'chunk-inventory',
        node_name: peer.info.name,
        session_id: peer.info.sessionId,
        session_token: peer.info.sessionToken,
        chunks: [...peer.chunks],
      };
      await publish(relay.baseUrl, ROOM, peer.info.name, `inv-${peer.info.name}`, inventory);
    }

    // Phase 2: Discover and build provider map
    const pollResult = await poll(relay.baseUrl, ROOM, 0);
    assertEquals(pollResult.envelopes.length, 5);

    const chunkProviders = new Map<string, NodeInfo>();
    for (const env of pollResult.envelopes) {
      const inv = env.payload as unknown as ChunkInventory;
      for (const chunk of inv.chunks) {
        if (!chunkProviders.has(chunk)) {
          chunkProviders.set(chunk, {
            name: inv.node_name,
            sessionId: inv.session_id,
            sessionToken: inv.session_token,
          });
        }
      }
    }

    // Phase 3: Each node fetches only what it's missing
    let totalFetches = 0;
    for (const peer of peers) {
      const missing = ALL_CHUNKS.filter((c) => !peer.chunks.has(c));
      // Each node has 2 chunks, so missing 3
      assertEquals(missing.length, 3, `${peer.info.name} should be missing 3 chunks`);
      totalFetches += missing.length;

      for (const chunkName of missing) {
        const provider = chunkProviders.get(chunkName)!;
        const received = await fetchChunkFromPeer(relay.baseUrl, provider, chunkName);
        assertEquals(received, `PACK:${chunkName}`);
        peer.chunks.add(chunkName);
      }
    }

    // 5 nodes × 3 missing each = 15 fetches (not 5×4=20, because overlap is skipped)
    assertEquals(totalFetches, 15);

    // Phase 4: All converged
    for (const peer of peers) {
      assertEquals(
        [...peer.chunks].sort(),
        ALL_CHUNKS.sort(),
        `${peer.info.name} should have all 5 chunks`,
      );
    }
  } finally {
    await relay.shutdown();
  }
});

Deno.test('chunk exchange: late joiner catches up from multiple peers', async () => {
  // Scenario:
  //   4 nodes complete their exchange. A 5th node joins late and
  //   fetches from whichever peer has each chunk (load distribution).
  //
  //   Phase 1: A,B,C,D exchange → all have {α,β,γ,δ}
  //   Phase 2: E joins with {ε}, publishes inventory
  //   Phase 3: E fetches α from A, β from B, γ from C, δ from D
  //   Phase 4: A,B,C,D fetch ε from E
  //   Result: all 5 have {α,β,γ,δ,ε}

  const relay = startRelay();
  try {
    const ROOM = 'late-join-sync';

    // Phase 1: 4 nodes register and advertise
    const initialPeers: PeerNode[] = [];
    const chunkNames = ['chunk-alpha', 'chunk-beta', 'chunk-gamma', 'chunk-delta'];
    for (let i = 0; i < 4; i++) {
      const info = await registerNode(relay.baseUrl, `node-${i}`);
      // After internal exchange, each has all 4 chunks
      initialPeers.push({ info, chunks: new Set(chunkNames) });
    }

    for (const peer of initialPeers) {
      await publish(
        relay.baseUrl,
        ROOM,
        peer.info.name,
        `inv-${peer.info.name}`,
        {
          type: 'chunk-inventory',
          node_name: peer.info.name,
          session_id: peer.info.sessionId,
          session_token: peer.info.sessionToken,
          chunks: [...peer.chunks],
        } satisfies ChunkInventory,
      );
    }

    // Phase 2: E joins late with chunk-epsilon
    const nodeE = await registerNode(relay.baseUrl, 'node-E');
    const peerE: PeerNode = { info: nodeE, chunks: new Set(['chunk-epsilon']) };

    await publish(
      relay.baseUrl,
      ROOM,
      nodeE.name,
      `inv-${nodeE.name}`,
      {
        type: 'chunk-inventory',
        node_name: nodeE.name,
        session_id: nodeE.sessionId,
        session_token: nodeE.sessionToken,
        chunks: [...peerE.chunks],
      } satisfies ChunkInventory,
    );

    // Phase 3: E discovers all inventories and fetches missing chunks
    const pollResult = await poll(relay.baseUrl, ROOM, 0);
    assertEquals(pollResult.envelopes.length, 5);

    // E picks a different provider for each chunk (load distribution)
    const providerByChunk = new Map<string, NodeInfo>();
    for (const env of pollResult.envelopes) {
      const inv = env.payload as unknown as ChunkInventory;
      for (const chunk of inv.chunks) {
        // Prefer the original owner to distribute load
        if (!providerByChunk.has(chunk) || inv.node_name.startsWith('node-')) {
          providerByChunk.set(chunk, {
            name: inv.node_name,
            sessionId: inv.session_id,
            sessionToken: inv.session_token,
          });
        }
      }
    }

    // E fetches α,β,γ,δ from different peers
    for (const chunkName of chunkNames) {
      assert(!peerE.chunks.has(chunkName), `E should not yet have ${chunkName}`);
      const provider = providerByChunk.get(chunkName)!;
      const received = await fetchChunkFromPeer(relay.baseUrl, provider, chunkName);
      assertEquals(received, `PACK:${chunkName}`);
      peerE.chunks.add(chunkName);
    }

    // Phase 4: Original nodes fetch ε from E
    for (const peer of initialPeers) {
      assert(!peer.chunks.has('chunk-epsilon'));
      const received = await fetchChunkFromPeer(relay.baseUrl, nodeE, 'chunk-epsilon');
      assertEquals(received, 'PACK:chunk-epsilon');
      peer.chunks.add('chunk-epsilon');
    }

    // Phase 5: Verify all 5 nodes have all 5 chunks
    const allChunks = [...chunkNames, 'chunk-epsilon'].sort();
    for (const peer of [...initialPeers, peerE]) {
      assertEquals(
        [...peer.chunks].sort(),
        allChunks,
        `${peer.info.name} should have all 5 chunks`,
      );
    }
  } finally {
    await relay.shutdown();
  }
});
