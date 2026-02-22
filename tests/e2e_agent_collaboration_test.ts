/**
 * E2E tests for Agent Collaboration Protocol.
 *
 * No relay changes — the protocol is purely a client-side convention
 * built on top of relay publish/poll + presence APIs.
 */
import { assert, assertEquals } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';

// ---------- Protocol types (client-side convention) ----------

interface ClaimMessage {
  type: 'claim';
  agent: string;
  files: string[];
  expiry: number; // epoch sec
}

interface ReleaseMessage {
  type: 'release';
  agent: string;
  files: string[];
}

interface BroadcastMessage {
  type: 'broadcast';
  agent: string;
  base_ref: string;
  head_ref: string;
  parent_broadcasts: string[];
  files_changed: string[];
}

type ProtocolMessage = ClaimMessage | ReleaseMessage | BroadcastMessage;

// ---------- Helpers ----------

const BASE = 'http://localhost';

function createRelay(opts: Record<string, unknown> = {}) {
  return createMemoryRelayService({ requireSignatures: false, ...opts });
}

async function publish(
  relay: ReturnType<typeof createRelay>,
  room: string,
  sender: string,
  payload: ProtocolMessage,
  id?: string,
) {
  const msgId = id ?? crypto.randomUUID();
  const res = await relay.fetch(
    new Request(
      `${BASE}/api/v1/publish?room=${room}&sender=${sender}&id=${msgId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    ),
  );
  const body = await res.json();
  assertEquals(res.status, 200);
  return { id: msgId, body };
}

async function poll(
  relay: ReturnType<typeof createRelay>,
  room: string,
  after = 0,
): Promise<
  {
    next_cursor: number;
    envelopes: Array<{ id: string; sender: string; payload: ProtocolMessage }>;
  }
> {
  const res = await relay.fetch(
    new Request(`${BASE}/api/v1/poll?room=${room}&after=${after}`, { method: 'GET' }),
  );
  assertEquals(res.status, 200);
  return await res.json();
}

async function heartbeat(
  relay: ReturnType<typeof createRelay>,
  room: string,
  participant: string,
  body?: { status?: string; metadata?: unknown },
) {
  const init: RequestInit = { method: 'POST' };
  if (body) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await relay.fetch(
    new Request(`${BASE}/api/v1/presence/heartbeat?room=${room}&participant=${participant}`, init),
  );
  assertEquals(res.status, 200);
  return await res.json();
}

async function getPresence(
  relay: ReturnType<typeof createRelay>,
  room: string,
): Promise<Array<{ participant_id: string; status: string; metadata: unknown }>> {
  const res = await relay.fetch(
    new Request(`${BASE}/api/v1/presence?room=${room}`, { method: 'GET' }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  return body.participants;
}

// deno-lint-ignore no-unused-vars
async function deletePresence(
  relay: ReturnType<typeof createRelay>,
  room: string,
  participant: string,
) {
  const res = await relay.fetch(
    new Request(`${BASE}/api/v1/presence?room=${room}&participant=${participant}`, {
      method: 'DELETE',
    }),
  );
  assertEquals(res.status, 200);
  return await res.json();
}

// Builds a set of currently claimed files from all messages
function buildClaimSet(
  envelopes: Array<{ payload: ProtocolMessage }>,
): Map<string, { agent: string; expiry: number }> {
  const claims = new Map<string, { agent: string; expiry: number }>();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const env of envelopes) {
    const msg = env.payload;
    if (msg.type === 'claim') {
      for (const file of msg.files) {
        if (msg.expiry > nowSec) {
          claims.set(file, { agent: msg.agent, expiry: msg.expiry });
        }
      }
    } else if (msg.type === 'release') {
      for (const file of msg.files) {
        const existing = claims.get(file);
        if (existing && existing.agent === msg.agent) {
          claims.delete(file);
        }
      }
    }
  }
  return claims;
}

function findConflictingFiles(
  claimSet: Map<string, { agent: string; expiry: number }>,
  agent: string,
  files: string[],
): string[] {
  return files.filter((f) => {
    const claim = claimSet.get(f);
    return claim && claim.agent !== agent;
  });
}

// ---------- Tests ----------

Deno.test('claim/release coordination — 5 agents', async () => {
  const relay = createRelay();
  const room = 'collab';
  const agents = ['agent-A', 'agent-B', 'agent-C', 'agent-D', 'agent-E'];
  const expiry = Math.floor(Date.now() / 1000) + 300;

  // Agent A claims files
  await publish(relay, room, agents[0], {
    type: 'claim',
    agent: agents[0],
    files: ['src/auth.ts', 'src/login.ts'],
    expiry,
  });

  // Agent B reads all messages and checks for conflicts
  const msgs1 = await poll(relay, room);
  const claimSet1 = buildClaimSet(msgs1.envelopes as Array<{ payload: ProtocolMessage }>);
  const conflicts = findConflictingFiles(claimSet1, agents[1], ['src/auth.ts', 'src/utils.ts']);
  assertEquals(conflicts, ['src/auth.ts']); // auth.ts is claimed by A

  // Agent B claims non-conflicting files
  await publish(relay, room, agents[1], {
    type: 'claim',
    agent: agents[1],
    files: ['src/utils.ts', 'src/config.ts'],
    expiry,
  });

  // Agents C, D, E claim their own files
  await publish(relay, room, agents[2], {
    type: 'claim',
    agent: agents[2],
    files: ['src/api.ts'],
    expiry,
  });
  await publish(relay, room, agents[3], {
    type: 'claim',
    agent: agents[3],
    files: ['src/db.ts'],
    expiry,
  });
  await publish(relay, room, agents[4], {
    type: 'claim',
    agent: agents[4],
    files: ['tests/auth_test.ts'],
    expiry,
  });

  // Agent A releases its claims
  await publish(relay, room, agents[0], {
    type: 'release',
    agent: agents[0],
    files: ['src/auth.ts', 'src/login.ts'],
  });

  // Now agent B can claim auth.ts
  const msgs2 = await poll(relay, room);
  const claimSet2 = buildClaimSet(msgs2.envelopes as Array<{ payload: ProtocolMessage }>);
  const conflicts2 = findConflictingFiles(claimSet2, agents[1], ['src/auth.ts']);
  assertEquals(conflicts2.length, 0); // no conflicts after release
});

Deno.test('ordered broadcast with causal chain', async () => {
  const relay = createRelay();
  const room = 'collab';

  // Agent A makes changes and broadcasts
  const broadcastA = await publish(relay, room, 'agent-A', {
    type: 'broadcast',
    agent: 'agent-A',
    base_ref: 'abc123',
    head_ref: 'def456',
    parent_broadcasts: [],
    files_changed: ['src/auth.ts'],
  });

  // Agent B reads agent A's broadcast
  const msgs1 = await poll(relay, room);
  assertEquals(msgs1.envelopes.length, 1);
  const aBroadcast = msgs1.envelopes[0].payload as BroadcastMessage;
  assertEquals(aBroadcast.type, 'broadcast');
  assertEquals(aBroadcast.agent, 'agent-A');
  assertEquals(aBroadcast.base_ref, 'abc123');

  // Agent B fast-forwards (incorporates A's changes) and broadcasts its own work
  const _broadcastB = await publish(relay, room, 'agent-B', {
    type: 'broadcast',
    agent: 'agent-B',
    base_ref: 'def456', // starts from A's head
    head_ref: 'ghi789',
    parent_broadcasts: [broadcastA.id], // causal link to A
    files_changed: ['src/utils.ts'],
  });

  // Agent C reads the full history and constructs causal chain
  const msgs2 = await poll(relay, room);
  assertEquals(msgs2.envelopes.length, 2);

  const broadcasts = msgs2.envelopes
    .map((e) => e.payload as BroadcastMessage)
    .filter((p) => p.type === 'broadcast');

  // Build causal chain: B references A
  const bMsg = broadcasts.find((b) => b.agent === 'agent-B')!;
  assertEquals(bMsg.parent_broadcasts.length, 1);
  assertEquals(bMsg.parent_broadcasts[0], broadcastA.id);
  assertEquals(bMsg.base_ref, 'def456'); // B started from A's head

  // C can determine the order: A -> B
  const chain: string[] = [];
  const idToMsg = new Map<string, BroadcastMessage & { id: string }>();
  for (const e of msgs2.envelopes) {
    idToMsg.set(e.id, { ...(e.payload as BroadcastMessage), id: e.id });
  }

  // Find the root (no parents)
  const root = [...idToMsg.values()].find((m) => m.parent_broadcasts.length === 0)!;
  chain.push(root.agent);

  // Follow chain
  let current = root;
  while (true) {
    const next = [...idToMsg.values()].find((m) => m.parent_broadcasts.includes(current.id));
    if (!next) break;
    chain.push(next.agent);
    current = next;
  }

  assertEquals(chain, ['agent-A', 'agent-B']);
});

Deno.test('follow/merge decision — conflict detection', async () => {
  const relay = createRelay();
  const room = 'collab';
  const commonBase = 'base-ref-000';

  // A and B diverge from the same base with non-overlapping files
  await publish(relay, room, 'agent-A', {
    type: 'broadcast',
    agent: 'agent-A',
    base_ref: commonBase,
    head_ref: 'head-A',
    parent_broadcasts: [],
    files_changed: ['src/auth.ts', 'src/login.ts'],
  });

  await publish(relay, room, 'agent-B', {
    type: 'broadcast',
    agent: 'agent-B',
    base_ref: commonBase,
    head_ref: 'head-B',
    parent_broadcasts: [],
    files_changed: ['src/utils.ts', 'src/config.ts'],
  });

  // Agent C evaluates merge-ability
  const msgs = await poll(relay, room);
  const broadcasts = msgs.envelopes
    .map((e) => e.payload as BroadcastMessage)
    .filter((p) => p.type === 'broadcast');

  // Find broadcasts from same base
  const sameBase = broadcasts.filter((b) => b.base_ref === commonBase);
  assertEquals(sameBase.length, 2);

  // Check file overlap
  const allFiles = sameBase.flatMap((b) => b.files_changed);
  const uniqueFiles = new Set(allFiles);
  const hasConflict = allFiles.length !== uniqueFiles.size;
  assertEquals(hasConflict, false); // no overlap → auto-merge possible

  // Now simulate a conflict scenario
  await publish(relay, room, 'agent-D', {
    type: 'broadcast',
    agent: 'agent-D',
    base_ref: commonBase,
    head_ref: 'head-D',
    parent_broadcasts: [],
    files_changed: ['src/auth.ts', 'src/db.ts'], // auth.ts overlaps with A
  });

  const msgs2 = await poll(relay, room);
  const broadcasts2 = msgs2.envelopes
    .map((e) => e.payload as BroadcastMessage)
    .filter((p) => p.type === 'broadcast' && p.base_ref === commonBase);

  const allFiles2 = broadcasts2.flatMap((b) => b.files_changed);
  const uniqueFiles2 = new Set(allFiles2);
  const hasConflict2 = allFiles2.length !== uniqueFiles2.size;
  assertEquals(hasConflict2, true); // auth.ts is in both A and D → conflict
});

Deno.test('5 agents full scenario — presence + claim + broadcast + follow', async () => {
  const relay = createRelay();
  const room = 'project-x';
  const agents = ['agent-A', 'agent-B', 'agent-C', 'agent-D', 'agent-E'];
  const expiry = Math.floor(Date.now() / 1000) + 300;

  // All 5 agents join via heartbeat
  for (const agent of agents) {
    await heartbeat(relay, room, agent, { status: 'online', metadata: { role: 'developer' } });
  }

  // Verify all 5 are present
  const presence = await getPresence(relay, room);
  assertEquals(presence.length, 5);

  // Phase 1: claim files
  await publish(relay, room, 'agent-A', {
    type: 'claim',
    agent: 'agent-A',
    files: ['src/auth.ts', 'src/session.ts'],
    expiry,
  });
  await publish(relay, room, 'agent-B', {
    type: 'claim',
    agent: 'agent-B',
    files: ['src/api.ts', 'src/routes.ts'],
    expiry,
  });
  await publish(relay, room, 'agent-C', {
    type: 'claim',
    agent: 'agent-C',
    files: ['src/db.ts', 'src/models.ts'],
    expiry,
  });

  // Phase 2: develop and broadcast
  const bcastA = await publish(relay, room, 'agent-A', {
    type: 'broadcast',
    agent: 'agent-A',
    base_ref: 'main-000',
    head_ref: 'feat-auth-001',
    parent_broadcasts: [],
    files_changed: ['src/auth.ts', 'src/session.ts'],
  });

  // Agent D (was idle) sees A's broadcast and fast-forwards
  const msgs = await poll(relay, room);
  const lastBroadcast = (msgs.envelopes as Array<{ id: string; payload: ProtocolMessage }>)
    .filter((e) => e.payload.type === 'broadcast')
    .pop()!;
  assertEquals(lastBroadcast.payload.type, 'broadcast');
  assertEquals((lastBroadcast.payload as BroadcastMessage).agent, 'agent-A');

  // Agent B broadcasts (builds on A)
  const _bcastB = await publish(relay, room, 'agent-B', {
    type: 'broadcast',
    agent: 'agent-B',
    base_ref: 'feat-auth-001',
    head_ref: 'feat-api-002',
    parent_broadcasts: [bcastA.id],
    files_changed: ['src/api.ts', 'src/routes.ts'],
  });

  // Agent A releases claims
  await publish(relay, room, 'agent-A', {
    type: 'release',
    agent: 'agent-A',
    files: ['src/auth.ts', 'src/session.ts'],
  });

  // Late joiner: agent-E catches up
  await heartbeat(relay, room, 'agent-E', { status: 'catching-up' });

  const allMsgs = await poll(relay, room);
  const broadcasts = (allMsgs.envelopes as Array<{ id: string; payload: ProtocolMessage }>)
    .filter((e) => e.payload.type === 'broadcast')
    .map((e) => e.payload as BroadcastMessage);

  assertEquals(broadcasts.length, 2);
  // E can reconstruct the causal chain: A -> B
  assertEquals(broadcasts[0].agent, 'agent-A');
  assertEquals(broadcasts[1].agent, 'agent-B');
  assertEquals(broadcasts[1].parent_broadcasts, [bcastA.id]);

  // E can see which files are still claimed
  const claimSet = buildClaimSet(allMsgs.envelopes as Array<{ payload: ProtocolMessage }>);
  // A released, so only B and C claims remain
  assert(!claimSet.has('src/auth.ts')); // released by A
  assert(!claimSet.has('src/session.ts')); // released by A
  assert(claimSet.has('src/api.ts')); // still claimed by B
  assert(claimSet.has('src/db.ts')); // still claimed by C
});

Deno.test('presence TTL expiry — agent crash simulation', async () => {
  const relay = createRelay({ presenceTtlSec: 2 });
  const room = 'collab';

  // Agent A and B join
  await heartbeat(relay, room, 'agent-A');
  await heartbeat(relay, room, 'agent-B');
  assertEquals((await getPresence(relay, room)).length, 2);

  // Agent A "crashes" (stops sending heartbeats)
  // Agent B keeps sending heartbeats
  await new Promise((r) => setTimeout(r, 1100));
  await heartbeat(relay, room, 'agent-B');

  // Wait for A's TTL to fully expire
  await new Promise((r) => setTimeout(r, 1100));

  // Check presence — A should be gone, B should still be present
  const presence = await getPresence(relay, room);
  assertEquals(presence.length, 1);
  assertEquals(presence[0].participant_id, 'agent-B');

  // Another agent (C) takes over A's work
  await heartbeat(relay, room, 'agent-C', { status: 'taking-over', metadata: { from: 'agent-A' } });
  const updatedPresence = await getPresence(relay, room);
  assertEquals(updatedPresence.length, 2);
  const ids = updatedPresence.map((p) => p.participant_id).sort();
  assertEquals(ids, ['agent-B', 'agent-C']);
});
