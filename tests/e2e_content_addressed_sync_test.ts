/**
 * E2E test: IPFS-style content-addressed sync without explicit room names.
 *
 * Instead of manually choosing a room, the room is deterministically
 * derived from the content identity (like IPFS CIDs derive from content hash).
 * Nodes that share the same content automatically converge to the same room.
 *
 * Protocol:
 *   room = "cid:" + SHA256(content-group-id)
 *   Messages use Bitswap-like want/have semantics:
 *     payload.type="have" → node advertises its object inventory
 *     payload.type="want" → node requests specific objects
 */
import { assert, assertEquals } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';
import { createGitServeSession } from '../src/git_serve_session.ts';

// --- Test relay server (reusable) ---

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

// --- Content-addressing helpers ---

/**
 * Derive room name from content identity, like IPFS CID → DHT key.
 * Room names must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
 * so we use a truncated hex hash (max 64 chars total).
 */
async function contentRoom(contentGroupId: string): Promise<string> {
  const bytes = new TextEncoder().encode(contentGroupId);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  // "s" prefix (swarm) + 63 chars of hash = 64 chars max
  return `s${hex.slice(0, 63)}`;
}

/** Derive room for a git object by its hash (like IPFS block CID) */
async function objectRoom(objectHash: string): Promise<string> {
  const bytes = new TextEncoder().encode(`git:object:${objectHash}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  // "o" prefix (object) + 63 chars of hash = 64 chars max
  return `o${hex.slice(0, 63)}`;
}

/** Derive room for a git repo by its fingerprint (like IPFS swarm) */
// deno-lint-ignore require-await
async function repoSwarmRoom(repoFingerprint: string): Promise<string> {
  return contentRoom(`git:repo:${repoFingerprint}`);
}

// --- Relay helpers ---

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
    `${baseUrl}/api/v1/publish?room=${encodeURIComponent(room)}&sender=${sender}&id=${id}`,
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
    `${baseUrl}/api/v1/poll?room=${encodeURIComponent(room)}&after=${after}&limit=100`,
  );
  return await res.json();
}

async function fetchObject(
  baseUrl: string,
  provider: NodeInfo,
  objectHash: string,
): Promise<string> {
  const objectData = `OBJECT:${objectHash}`;

  const gitPromise = fetch(
    `${baseUrl}/git/${provider.sessionId}/info/refs?service=git-upload-pack&session_token=${provider.sessionToken}`,
  );

  await new Promise((r) => setTimeout(r, 50));

  const pollRes = await fetch(
    `${baseUrl}/api/v1/serve/poll?session=${provider.sessionId}&timeout=2&session_token=${provider.sessionToken}`,
  );
  const pollBody = await pollRes.json();
  assert(pollBody.requests.length > 0, `expected pending request for ${objectHash}`);

  const respondRes = await fetch(
    `${baseUrl}/api/v1/serve/respond?session=${provider.sessionId}&session_token=${provider.sessionToken}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: pollBody.requests[0].request_id,
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body_base64: textToBase64(objectData),
      }),
    },
  );
  await respondRes.json();

  const gitRes = await gitPromise;
  assertEquals(gitRes.status, 200);
  return await gitRes.text();
}

// --- Bitswap-like protocol types ---

interface HaveMessage {
  type: 'have';
  node_name: string;
  session_id: string;
  session_token: string;
  objects: string[]; // git object hashes
}

interface WantMessage {
  type: 'want';
  node_name: string;
  objects: string[]; // git object hashes needed
}

interface PeerNode {
  info: NodeInfo;
  objects: Set<string>; // object hashes this node holds
}

// =============================================================================
// Tests
// =============================================================================

Deno.test('content-addressed sync: nodes discover each other via repo fingerprint', async () => {
  // Scenario:
  //   No room names are specified. Nodes that work on the same repo
  //   derive the same room from the repo's fingerprint (initial commit hash).
  //   This is analogous to IPFS nodes joining the same swarm via CID.
  //
  //   repo fingerprint: "abc123" (e.g. hash of initial commit)
  //   room = "cid:" + SHA256("git:repo:abc123")
  //
  //   All 5 nodes independently derive the same room, publish their
  //   objects, and exchange missing ones — without knowing each other
  //   or specifying any room name.

  const relay = startRelay();
  try {
    const REPO_FINGERPRINT = 'abc123deadbeef'; // e.g. initial commit hash
    const room = await repoSwarmRoom(REPO_FINGERPRINT);

    // Verify deterministic room derivation
    const room2 = await repoSwarmRoom(REPO_FINGERPRINT);
    assertEquals(room, room2, 'same fingerprint must derive same room');

    // Different repo → different room (isolation)
    const otherRoom = await repoSwarmRoom('other-repo-xyz');
    assert(room !== otherRoom, 'different repos must derive different rooms');

    // 5 nodes, each with unique git objects
    const objectSets = [
      ['obj-aaa111', 'obj-aaa222'],
      ['obj-bbb111'],
      ['obj-ccc111', 'obj-ccc222', 'obj-ccc333'],
      ['obj-ddd111'],
      ['obj-eee111', 'obj-eee222'],
    ];
    const allObjects = objectSets.flat().sort();

    const peers: PeerNode[] = [];
    for (let i = 0; i < 5; i++) {
      const info = await registerNode(relay.baseUrl, `peer-${i}`);
      peers.push({ info, objects: new Set(objectSets[i]) });
    }

    // Phase 1: Each node publishes "have" to the content-addressed room
    // (no manual room config — derived from repo fingerprint)
    for (const peer of peers) {
      const have: HaveMessage = {
        type: 'have',
        node_name: peer.info.name,
        session_id: peer.info.sessionId,
        session_token: peer.info.sessionToken,
        objects: [...peer.objects],
      };
      await publish(relay.baseUrl, room, peer.info.name, `have-${peer.info.name}`, have);
    }

    // Phase 2: Each node polls the room, discovers others' inventories
    const pollResult = await poll(relay.baseUrl, room, 0);
    assertEquals(pollResult.envelopes.length, 5);

    // Build provider index: object → best provider
    const providerIndex = new Map<string, NodeInfo>();
    for (const env of pollResult.envelopes) {
      const have = env.payload as unknown as HaveMessage;
      assertEquals(have.type, 'have');
      for (const obj of have.objects) {
        if (!providerIndex.has(obj)) {
          providerIndex.set(obj, {
            name: have.node_name,
            sessionId: have.session_id,
            sessionToken: have.session_token,
          });
        }
      }
    }

    // Phase 3: Each node fetches missing objects (Bitswap-like)
    for (const peer of peers) {
      const missing = allObjects.filter((o) => !peer.objects.has(o));

      // Publish "want" (optional, for protocol completeness)
      if (missing.length > 0) {
        const want: WantMessage = {
          type: 'want',
          node_name: peer.info.name,
          objects: missing,
        };
        await publish(
          relay.baseUrl,
          room,
          peer.info.name,
          `want-${peer.info.name}`,
          want,
        );
      }

      // Fetch each missing object from its provider
      for (const obj of missing) {
        const provider = providerIndex.get(obj)!;
        assert(provider, `no provider for ${obj}`);
        const data = await fetchObject(relay.baseUrl, provider, obj);
        assertEquals(data, `OBJECT:${obj}`);
        peer.objects.add(obj);
      }
    }

    // Phase 4: All nodes converged
    for (const peer of peers) {
      assertEquals(
        [...peer.objects].sort(),
        allObjects,
        `${peer.info.name} should have all objects`,
      );
    }
  } finally {
    await relay.shutdown();
  }
});

Deno.test('content-addressed sync: per-object rooms for fine-grained discovery', async () => {
  // Scenario:
  //   Like IPFS where each block has its own CID and can be discovered
  //   independently, each git object gets its own content-addressed room.
  //   A node looking for object "abc123" subscribes to room("abc123")
  //   and finds providers there.
  //
  //   This enables:
  //   - Fetching a single object from any provider who has it
  //   - No need to know the full repo — just the object hash
  //   - Multiple repos can share the same objects (deduplication)

  const relay = startRelay();
  try {
    // 3 providers, each announcing different objects in per-object rooms
    const providers: PeerNode[] = [];
    for (let i = 0; i < 3; i++) {
      const info = await registerNode(relay.baseUrl, `provider-${i}`);
      providers.push({ info, objects: new Set<string>() });
    }

    // Provider 0 has obj-A and obj-B
    // Provider 1 has obj-B and obj-C (overlap on obj-B)
    // Provider 2 has obj-C and obj-D
    const providerObjects: string[][] = [
      ['obj-A', 'obj-B'],
      ['obj-B', 'obj-C'],
      ['obj-C', 'obj-D'],
    ];

    // Each provider announces each object in that object's content-addressed room
    for (let i = 0; i < providers.length; i++) {
      for (const obj of providerObjects[i]) {
        providers[i].objects.add(obj);
        const objRoom = await objectRoom(obj);
        await publish(
          relay.baseUrl,
          objRoom,
          providers[i].info.name,
          `provide-${providers[i].info.name}-${obj}`,
          {
            type: 'provide',
            node_name: providers[i].info.name,
            session_id: providers[i].info.sessionId,
            session_token: providers[i].info.sessionToken,
            object: obj,
          },
        );
      }
    }

    // A new node wants obj-A, obj-C, obj-D
    const _seeker = await registerNode(relay.baseUrl, 'seeker');
    const seekerObjects = new Set<string>();
    const wanted = ['obj-A', 'obj-C', 'obj-D'];

    for (const obj of wanted) {
      // Look up the object's content-addressed room
      const objRoom = await objectRoom(obj);
      const result = await poll(relay.baseUrl, objRoom, 0);

      // Should find at least one provider
      assert(result.envelopes.length > 0, `no providers for ${obj}`);

      // Pick first provider (could be random / closest in real impl)
      const provider = result.envelopes[0].payload as unknown as {
        node_name: string;
        session_id: string;
        session_token: string;
      };

      // Fetch the object
      const data = await fetchObject(
        relay.baseUrl,
        {
          name: provider.node_name,
          sessionId: provider.session_id,
          sessionToken: provider.session_token,
        },
        obj,
      );
      assertEquals(data, `OBJECT:${obj}`);
      seekerObjects.add(obj);
    }

    assertEquals([...seekerObjects].sort(), wanted.sort());

    // Verify obj-B has 2 providers (overlap), obj-A has 1
    const roomB = await objectRoom('obj-B');
    const providersForB = await poll(relay.baseUrl, roomB, 0);
    assertEquals(providersForB.envelopes.length, 2, 'obj-B should have 2 providers');

    const roomA = await objectRoom('obj-A');
    const providersForA = await poll(relay.baseUrl, roomA, 0);
    assertEquals(providersForA.envelopes.length, 1, 'obj-A should have 1 provider');
  } finally {
    await relay.shutdown();
  }
});

Deno.test('content-addressed sync: multi-repo isolation via fingerprint', async () => {
  // Scenario:
  //   Two different repos sync simultaneously through the same relay.
  //   Each repo's nodes are isolated in their own content-addressed room.
  //   No cross-contamination between repos.

  const relay = startRelay();
  try {
    const roomAlpha = await repoSwarmRoom('repo-alpha-fingerprint');
    const roomBeta = await repoSwarmRoom('repo-beta-fingerprint');
    assert(roomAlpha !== roomBeta, 'different repos must be in different rooms');

    // Repo Alpha: 2 nodes
    const alphaA = await registerNode(relay.baseUrl, 'alpha-A');
    const _alphaB = await registerNode(relay.baseUrl, 'alpha-B');

    // Repo Beta: 2 nodes
    const betaA = await registerNode(relay.baseUrl, 'beta-A');
    const _betaB = await registerNode(relay.baseUrl, 'beta-B');

    // Publish to respective rooms
    await publish(
      relay.baseUrl,
      roomAlpha,
      'alpha-A',
      'have-alpha-A',
      {
        type: 'have',
        node_name: alphaA.name,
        session_id: alphaA.sessionId,
        session_token: alphaA.sessionToken,
        objects: ['alpha-obj-1', 'alpha-obj-2'],
      } satisfies HaveMessage,
    );

    await publish(
      relay.baseUrl,
      roomBeta,
      'beta-A',
      'have-beta-A',
      {
        type: 'have',
        node_name: betaA.name,
        session_id: betaA.sessionId,
        session_token: betaA.sessionToken,
        objects: ['beta-obj-1', 'beta-obj-2'],
      } satisfies HaveMessage,
    );

    // Alpha nodes only see alpha objects
    const alphaPoll = await poll(relay.baseUrl, roomAlpha, 0);
    assertEquals(alphaPoll.envelopes.length, 1);
    const alphaHave = alphaPoll.envelopes[0].payload as unknown as HaveMessage;
    assert(alphaHave.objects.every((o) => o.startsWith('alpha-')));

    // Beta nodes only see beta objects
    const betaPoll = await poll(relay.baseUrl, roomBeta, 0);
    assertEquals(betaPoll.envelopes.length, 1);
    const betaHave = betaPoll.envelopes[0].payload as unknown as HaveMessage;
    assert(betaHave.objects.every((o) => o.startsWith('beta-')));

    // Cross-fetch works: alpha-B fetches from alpha-A
    const data = await fetchObject(relay.baseUrl, alphaA, 'alpha-obj-1');
    assertEquals(data, 'OBJECT:alpha-obj-1');

    // Beta-B fetches from beta-A (completely independent)
    const betaData = await fetchObject(relay.baseUrl, betaA, 'beta-obj-1');
    assertEquals(betaData, 'OBJECT:beta-obj-1');
  } finally {
    await relay.shutdown();
  }
});

Deno.test('content-addressed sync: shared objects across repos (deduplication)', async () => {
  // Scenario:
  //   Like IPFS, the same content (same hash) can be shared across
  //   different repos. If repo-A and repo-B both contain the same
  //   git blob (e.g., a common library file), either repo's node
  //   can serve it.

  const relay = startRelay();
  try {
    const SHARED_OBJECT = 'obj-shared-lib-abc'; // same blob in both repos
    const sharedRoom = await objectRoom(SHARED_OBJECT);

    // Node from repo-A provides the shared object
    const repoANode = await registerNode(relay.baseUrl, 'repo-A-node');
    await publish(relay.baseUrl, sharedRoom, repoANode.name, 'provide-A', {
      type: 'provide',
      node_name: repoANode.name,
      session_id: repoANode.sessionId,
      session_token: repoANode.sessionToken,
      object: SHARED_OBJECT,
    });

    // Node from repo-B provides the same object
    const repoBNode = await registerNode(relay.baseUrl, 'repo-B-node');
    await publish(relay.baseUrl, sharedRoom, repoBNode.name, 'provide-B', {
      type: 'provide',
      node_name: repoBNode.name,
      session_id: repoBNode.sessionId,
      session_token: repoBNode.sessionToken,
      object: SHARED_OBJECT,
    });

    // A new node from repo-C needs this object
    const result = await poll(relay.baseUrl, sharedRoom, 0);
    assertEquals(result.envelopes.length, 2, 'should find 2 providers for shared object');

    // Can fetch from either provider
    const provider = result.envelopes[0].payload as unknown as {
      node_name: string;
      session_id: string;
      session_token: string;
    };
    const data = await fetchObject(
      relay.baseUrl,
      {
        name: provider.node_name,
        sessionId: provider.session_id,
        sessionToken: provider.session_token,
      },
      SHARED_OBJECT,
    );
    assertEquals(data, `OBJECT:${SHARED_OBJECT}`);
  } finally {
    await relay.shutdown();
  }
});

Deno.test('content-addressed sync: forked repos discover each other via shared ancestry', async () => {
  // Scenario:
  //   "Similar repositories" = repos that share a common base.
  //
  //   origin:  c1 → c2 → c3
  //   fork-A:  c1 → c2 → c3 → c4 → c5  (added feature-A)
  //   fork-B:  c1 → c2 → c3 → c6 → c7  (added feature-B)
  //
  //   Strategy: each node advertises ALL its objects in per-object rooms.
  //   Since c1, c2, c3 are shared, querying any shared object's room
  //   reveals all repos that contain it → discovery without prior knowledge.
  //
  //   This is how IPFS works: content-identical blocks share the same CID,
  //   so any node that has the block appears as a provider.

  const relay = startRelay();
  try {
    // Shared ancestry objects (present in all repos)
    const sharedObjects = ['commit-c1', 'commit-c2', 'commit-c3', 'tree-root-v1', 'blob-readme'];

    // Fork-specific objects
    const forkAOnly = ['commit-c4', 'commit-c5', 'blob-feature-a'];
    const forkBOnly = ['commit-c6', 'commit-c7', 'blob-feature-b'];

    const originNode = await registerNode(relay.baseUrl, 'origin');
    const forkANode = await registerNode(relay.baseUrl, 'fork-A');
    const forkBNode = await registerNode(relay.baseUrl, 'fork-B');

    const originObjects = new Set(sharedObjects);
    const forkAObjects = new Set([...sharedObjects, ...forkAOnly]);
    const forkBObjects = new Set([...sharedObjects, ...forkBOnly]);

    // Each node advertises its objects in per-object rooms
    // deno-lint-ignore no-inner-declarations
    async function advertiseObjects(node: NodeInfo, objects: Set<string>) {
      for (const obj of objects) {
        const room = await objectRoom(obj);
        await publish(relay.baseUrl, room, node.name, `provide-${node.name}-${obj}`, {
          type: 'provide',
          node_name: node.name,
          session_id: node.sessionId,
          session_token: node.sessionToken,
          object: obj,
        });
      }
    }

    await advertiseObjects(originNode, originObjects);
    await advertiseObjects(forkANode, forkAObjects);
    await advertiseObjects(forkBNode, forkBObjects);

    // --- Discovery scenario: fork-B wants to find "similar repos" ---
    // fork-B picks any object it has (e.g. commit-c1) and checks who else has it

    const discoveryRoom = await objectRoom('commit-c1');
    const providers = await poll(relay.baseUrl, discoveryRoom, 0);

    // All 3 repos have commit-c1 → all 3 appear as providers
    assertEquals(providers.envelopes.length, 3, 'all 3 repos share commit-c1');
    const discoveredNames = providers.envelopes.map(
      (e) => (e.payload as Record<string, unknown>).node_name,
    );
    assert(discoveredNames.includes('origin'));
    assert(discoveredNames.includes('fork-A'));
    assert(discoveredNames.includes('fork-B'));

    // --- fork-B discovers fork-A's unique objects ---
    // fork-B now knows about fork-A. To find what fork-A has that fork-B doesn't,
    // fork-B needs fork-A's full inventory. Two approaches:
    //
    // Approach 1: Swarm room per repo (requires known fingerprint)
    // Approach 2: Ask fork-A directly via a "manifest" object room

    // Let's use approach 2: each repo publishes a manifest
    // listing all its objects in a well-known room derived from its node name
    const forkAManifestRoom = await contentRoom(`manifest:${forkANode.name}`);
    await publish(relay.baseUrl, forkAManifestRoom, forkANode.name, 'manifest', {
      type: 'manifest',
      objects: [...forkAObjects],
    });

    // fork-B queries fork-A's manifest
    const manifestPoll = await poll(relay.baseUrl, forkAManifestRoom, 0);
    assertEquals(manifestPoll.envelopes.length, 1);
    const forkAManifest = manifestPoll.envelopes[0].payload as unknown as {
      type: string;
      objects: string[];
    };

    // Compute diff: what does fork-A have that fork-B doesn't?
    const newForB = forkAManifest.objects.filter((o) => !forkBObjects.has(o));
    assertEquals(newForB.sort(), forkAOnly.sort(), 'fork-B discovers fork-A-only objects');

    // fork-B fetches the missing objects
    for (const obj of newForB) {
      const data = await fetchObject(relay.baseUrl, forkANode, obj);
      assertEquals(data, `OBJECT:${obj}`);
      forkBObjects.add(obj);
    }

    // fork-B now has origin + fork-A + fork-B objects
    const expectedAll = [...sharedObjects, ...forkAOnly, ...forkBOnly].sort();
    assertEquals([...forkBObjects].sort(), expectedAll);
  } finally {
    await relay.shutdown();
  }
});

Deno.test('content-addressed sync: independently created repos discover shared content', async () => {
  // Scenario:
  //   Two repos created independently (different initial commits)
  //   but containing the same library file (same blob hash).
  //
  //   repo-X: init-X → ... has blob "lib-utils-v2" (sha: utils-abc)
  //   repo-Y: init-Y → ... has blob "lib-utils-v2" (sha: utils-abc)
  //
  //   They have NO shared history, but per-object rooms let them
  //   discover each other through shared content.

  const relay = startRelay();
  try {
    const SHARED_BLOB = 'blob-utils-abc'; // identical file in both repos
    const sharedRoom = await objectRoom(SHARED_BLOB);

    // repo-X objects (independent history)
    const repoXNode = await registerNode(relay.baseUrl, 'repo-X');
    const _repoXObjects = ['init-X', 'commit-X1', 'tree-X1', SHARED_BLOB, 'blob-app-X'];

    // repo-Y objects (independent history, shares one blob)
    const repoYNode = await registerNode(relay.baseUrl, 'repo-Y');
    const _repoYObjects = ['init-Y', 'commit-Y1', 'tree-Y1', SHARED_BLOB, 'blob-app-Y'];

    // Both advertise the shared blob
    await publish(relay.baseUrl, sharedRoom, repoXNode.name, 'provide-X', {
      type: 'provide',
      node_name: repoXNode.name,
      session_id: repoXNode.sessionId,
      session_token: repoXNode.sessionToken,
      object: SHARED_BLOB,
    });
    await publish(relay.baseUrl, sharedRoom, repoYNode.name, 'provide-Y', {
      type: 'provide',
      node_name: repoYNode.name,
      session_id: repoYNode.sessionId,
      session_token: repoYNode.sessionToken,
      object: SHARED_BLOB,
    });

    // A third node looking for this blob finds both repos
    const result = await poll(relay.baseUrl, sharedRoom, 0);
    assertEquals(result.envelopes.length, 2);

    const names = result.envelopes.map(
      (e) => (e.payload as Record<string, unknown>).node_name,
    );
    assert(names.includes('repo-X'));
    assert(names.includes('repo-Y'));

    // But initial commit rooms are completely separate
    const roomInitX = await objectRoom('init-X');
    const roomInitY = await objectRoom('init-Y');
    assert(roomInitX !== roomInitY, 'independent repos have different init rooms');

    const initXProviders = await poll(relay.baseUrl, roomInitX, 0);
    // Only repo-X is in init-X room (repo-Y never advertised there)
    assertEquals(initXProviders.envelopes.length, 0, 'repo-Y has not advertised init-X');
  } finally {
    await relay.shutdown();
  }
});

Deno.test('content-addressed sync: progressive discovery via overlap expansion', async () => {
  // Scenario:
  //   A node starts with one known object, uses it to discover peers,
  //   then expands its knowledge by querying more objects from those peers.
  //   This is "graph walking" — like IPFS Bitswap expanding wants.
  //
  //   Step 1: I know "commit-c3" → find who else has it
  //   Step 2: Discovered "origin" → get its manifest → learn about c1, c2, tree-root
  //   Step 3: Check "tree-root" room → find even more peers
  //
  //   This creates a discovery cascade without any prior configuration.

  const relay = startRelay();
  try {
    // Setup: 3 repos with overlapping objects
    //   origin:    [c1, c2, c3, tree-root]
    //   fork:      [c1, c2, c3, c4, tree-root, tree-fork]
    //   unrelated: [tree-root, blob-shared]  (shares tree-root but not commits)
    const originNode = await registerNode(relay.baseUrl, 'origin');
    const forkNode = await registerNode(relay.baseUrl, 'fork');
    const unrelatedNode = await registerNode(relay.baseUrl, 'unrelated');

    const originObjs = ['c1', 'c2', 'c3', 'tree-root'];
    const forkObjs = ['c1', 'c2', 'c3', 'c4', 'tree-root', 'tree-fork'];
    const unrelatedObjs = ['tree-root', 'blob-shared'];

    // Advertise all objects
    // deno-lint-ignore no-inner-declarations
    async function advertise(node: NodeInfo, objs: string[]) {
      for (const obj of objs) {
        const room = await objectRoom(obj);
        await publish(relay.baseUrl, room, node.name, `p-${node.name}-${obj}`, {
          type: 'provide',
          node_name: node.name,
          session_id: node.sessionId,
          session_token: node.sessionToken,
          object: obj,
        });
      }
    }

    await advertise(originNode, originObjs);
    await advertise(forkNode, forkObjs);
    await advertise(unrelatedNode, unrelatedObjs);

    // Also publish manifests
    // deno-lint-ignore no-inner-declarations
    async function publishManifest(node: NodeInfo, objs: string[]) {
      const room = await contentRoom(`manifest:${node.name}`);
      await publish(relay.baseUrl, room, node.name, `manifest-${node.name}`, {
        type: 'manifest',
        objects: objs,
      });
    }
    await publishManifest(originNode, originObjs);
    await publishManifest(forkNode, forkObjs);
    await publishManifest(unrelatedNode, unrelatedObjs);

    // --- Progressive discovery from a new node ---
    // New node knows only "c3" (e.g., someone gave it a commit hash)

    // Step 1: Query c3's room → discover origin and fork
    const c3Room = await objectRoom('c3');
    const step1 = await poll(relay.baseUrl, c3Room, 0);
    assertEquals(step1.envelopes.length, 2, 'c3 is in origin and fork');
    const step1Names = new Set(
      step1.envelopes.map((e) => (e.payload as Record<string, unknown>).node_name),
    );
    assert(step1Names.has('origin'));
    assert(step1Names.has('fork'));
    assert(!step1Names.has('unrelated'), 'unrelated repo does not have c3');

    // Step 2: Get origin's manifest → learn about tree-root
    const originManifestRoom = await contentRoom(`manifest:origin`);
    const originManifest = await poll(relay.baseUrl, originManifestRoom, 0);
    const originObjList = (
      originManifest.envelopes[0].payload as unknown as { objects: string[] }
    ).objects;
    assert(originObjList.includes('tree-root'));

    // Step 3: Query tree-root room → discover the unrelated repo too!
    const treeRootRoom = await objectRoom('tree-root');
    const step3 = await poll(relay.baseUrl, treeRootRoom, 0);
    assertEquals(step3.envelopes.length, 3, 'tree-root is in all 3 repos');
    const step3Names = new Set(
      step3.envelopes.map((e) => (e.payload as Record<string, unknown>).node_name),
    );
    assert(step3Names.has('origin'));
    assert(step3Names.has('fork'));
    assert(step3Names.has('unrelated'), 'discovered unrelated repo via shared tree-root');

    // Summary: starting from just "c3", we discovered all 3 repos
    // by walking the content graph:
    //   c3 → {origin, fork} → tree-root → {origin, fork, unrelated}
  } finally {
    await relay.shutdown();
  }
});
