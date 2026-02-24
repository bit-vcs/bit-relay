import { assertEquals } from '@std/assert';
import { createMemoryRelayService, type MemoryRelayService } from '../src/memory_handler.ts';
import { type CacheSyncWorker, createCacheSyncWorker } from '../src/cache_sync_worker.ts';
import type { CacheExchangeEntry } from '../src/cache_exchange.ts';

type NodeId = 'relay-a' | 'relay-b' | 'relay-c';

interface RelayNode {
  id: NodeId;
  service: MemoryRelayService;
}

function createRelayNode(id: NodeId): RelayNode {
  return {
    id,
    service: createMemoryRelayService({
      requireSignatures: false,
      relayNodeId: id,
    }),
  };
}

async function publish(
  service: MemoryRelayService,
  args: {
    room: string;
    sender: string;
    id: string;
    payload: unknown;
    topic?: string;
  },
): Promise<void> {
  const topic = args.topic ?? 'notify';
  const res = await service.fetch(
    new Request(
      `http://relay.local/api/v1/publish?room=${encodeURIComponent(args.room)}&sender=${
        encodeURIComponent(args.sender)
      }&topic=${encodeURIComponent(topic)}&id=${encodeURIComponent(args.id)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args.payload),
      },
    ),
  );
  assertEquals(res.status, 200);
}

async function pollIds(service: MemoryRelayService, room: string): Promise<string[]> {
  const res = await service.fetch(
    new Request(
      `http://relay.local/api/v1/poll?room=${encodeURIComponent(room)}&after=0&limit=10000`,
    ),
  );
  assertEquals(res.status, 200);
  const body = await res.json() as { envelopes: Array<{ id: string }> };
  return body.envelopes.map((value) => value.id).sort();
}

function createWorker(args: {
  nodeId: NodeId;
  localService: MemoryRelayService;
  peers: NodeId[];
  services: Map<NodeId, MemoryRelayService>;
  canConnect: (from: NodeId, to: NodeId) => boolean;
}): CacheSyncWorker {
  return createCacheSyncWorker({
    peers: args.peers,
    limit: 200,
    async pullFromPeer({ peer, after, limit }) {
      const peerId = peer as NodeId;
      if (!args.canConnect(args.nodeId, peerId)) {
        throw new Error(`network blocked: ${args.nodeId} -> ${peerId}`);
      }
      const target = args.services.get(peerId);
      if (!target) {
        throw new Error(`missing target service: ${peerId}`);
      }
      const res = await target.fetch(
        new Request(
          `http://relay.local/api/v1/cache/exchange/pull?after=${after}&limit=${limit}&peer=${
            encodeURIComponent(args.nodeId)
          }`,
        ),
      );
      if (res.status !== 200) {
        throw new Error(`peer pull failed: ${peerId}, status=${res.status}`);
      }
      const body = await res.json() as Record<string, unknown>;
      const entries = Array.isArray(body.entries) ? body.entries as CacheExchangeEntry[] : [];
      const nextCursor = typeof body.next_cursor === 'number' && Number.isFinite(body.next_cursor)
        ? Math.max(0, Math.trunc(body.next_cursor))
        : after;
      return { entries, nextCursor };
    },
    async pushToLocal({ entries }) {
      const res = await args.localService.fetch(
        new Request('http://relay.local/api/v1/cache/exchange/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entries }),
        }),
      );
      assertEquals(res.status, 200);
    },
  });
}

async function runRounds(workers: CacheSyncWorker[], rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    for (const worker of workers) {
      await worker.syncOnce();
    }
  }
}

Deno.test('e2e cache sync: 3 relays converge under multi-node load', async () => {
  const nodeA = createRelayNode('relay-a');
  const nodeB = createRelayNode('relay-b');
  const nodeC = createRelayNode('relay-c');
  const nodes = [nodeA, nodeB, nodeC];

  try {
    const services = new Map<NodeId, MemoryRelayService>(nodes.map((n) => [n.id, n.service]));
    const canConnect = () => true;
    const workers = [
      createWorker({
        nodeId: 'relay-a',
        localService: nodeA.service,
        peers: ['relay-b', 'relay-c'],
        services,
        canConnect,
      }),
      createWorker({
        nodeId: 'relay-b',
        localService: nodeB.service,
        peers: ['relay-a', 'relay-c'],
        services,
        canConnect,
      }),
      createWorker({
        nodeId: 'relay-c',
        localService: nodeC.service,
        peers: ['relay-a', 'relay-b'],
        services,
        canConnect,
      }),
    ];

    const room = 'load';
    for (const node of nodes) {
      for (let i = 0; i < 20; i += 1) {
        await publish(node.service, {
          room,
          sender: node.id,
          id: `${node.id}-${i}`,
          payload: { kind: 'cache.record', node: node.id, seq: i },
        });
      }
    }

    await runRounds(workers, 6);

    const expectedCount = 60;
    for (const node of nodes) {
      const ids = await pollIds(node.service, room);
      assertEquals(ids.length, expectedCount);
    }
  } finally {
    nodeA.service.close();
    nodeB.service.close();
    nodeC.service.close();
  }
});

Deno.test('e2e cache sync: partition recovery in chain topology', async () => {
  const nodeA = createRelayNode('relay-a');
  const nodeB = createRelayNode('relay-b');
  const nodeC = createRelayNode('relay-c');
  const nodes = [nodeA, nodeB, nodeC];

  try {
    const services = new Map<NodeId, MemoryRelayService>(nodes.map((n) => [n.id, n.service]));
    const blocked = new Set<string>();
    const canConnect = (from: NodeId, to: NodeId) => !blocked.has(`${from}->${to}`);
    const workers = [
      createWorker({
        nodeId: 'relay-a',
        localService: nodeA.service,
        peers: ['relay-b'],
        services,
        canConnect,
      }),
      createWorker({
        nodeId: 'relay-b',
        localService: nodeB.service,
        peers: ['relay-a', 'relay-c'],
        services,
        canConnect,
      }),
      createWorker({
        nodeId: 'relay-c',
        localService: nodeC.service,
        peers: ['relay-b'],
        services,
        canConnect,
      }),
    ];

    const room = 'partition';
    await publish(nodeA.service, {
      room,
      sender: 'relay-a',
      id: 'a-0',
      payload: { kind: 'cache.record', node: 'relay-a' },
    });
    await runRounds(workers, 4);

    blocked.add('relay-b->relay-c');
    blocked.add('relay-c->relay-b');

    await publish(nodeC.service, {
      room,
      sender: 'relay-c',
      id: 'c-isolated',
      payload: { kind: 'cache.record', node: 'relay-c', phase: 'partition' },
    });
    await runRounds(workers, 4);

    const idsA1 = await pollIds(nodeA.service, room);
    const idsB1 = await pollIds(nodeB.service, room);
    const idsC1 = await pollIds(nodeC.service, room);
    assertEquals(idsA1.includes('c-isolated'), false);
    assertEquals(idsB1.includes('c-isolated'), false);
    assertEquals(idsC1.includes('c-isolated'), true);

    blocked.delete('relay-b->relay-c');
    blocked.delete('relay-c->relay-b');
    await runRounds(workers, 6);

    const idsA2 = await pollIds(nodeA.service, room);
    const idsB2 = await pollIds(nodeB.service, room);
    const idsC2 = await pollIds(nodeC.service, room);
    assertEquals(idsA2.includes('c-isolated'), true);
    assertEquals(idsB2.includes('c-isolated'), true);
    assertEquals(idsC2.includes('c-isolated'), true);
  } finally {
    nodeA.service.close();
    nodeB.service.close();
    nodeC.service.close();
  }
});
