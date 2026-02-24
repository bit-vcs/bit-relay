import { assertEquals } from '@std/assert';
import { createMemoryRelayService, type MemoryRelayService } from '../src/memory_handler.ts';
import { createCacheSyncWorker } from '../src/cache_sync_worker.ts';

async function publish(
  service: MemoryRelayService,
  args: { room: string; sender: string; id: string; payload: unknown; topic?: string },
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

async function pollEnvelopeCount(service: MemoryRelayService, room: string): Promise<number> {
  const res = await service.fetch(
    new Request(
      `http://relay.local/api/v1/poll?room=${encodeURIComponent(room)}&after=0&limit=100`,
      { method: 'GET' },
    ),
  );
  assertEquals(res.status, 200);
  const body = await res.json() as { envelopes: unknown[] };
  return body.envelopes.length;
}

function createServiceBackedWorker(args: {
  localNodeId: string;
  localService: MemoryRelayService;
  peers: Record<string, MemoryRelayService>;
}) {
  return createCacheSyncWorker({
    peers: Object.keys(args.peers),
    limit: 100,
    async pullFromPeer({ peer, after, limit }) {
      const target = args.peers[peer];
      const res = await target.fetch(
        new Request(
          `http://relay.local/api/v1/cache/exchange/pull?after=${after}&limit=${limit}&peer=${
            encodeURIComponent(args.localNodeId)
          }`,
        ),
      );
      assertEquals(res.status, 200);
      const body = await res.json() as { entries: unknown[]; next_cursor: number };
      return {
        entries: body.entries as any[],
        nextCursor: body.next_cursor,
      };
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

Deno.test('cache sync worker replicates entries from peer and advances cursor', async () => {
  const relayA = createMemoryRelayService({ requireSignatures: false, relayNodeId: 'relay-a' });
  const relayB = createMemoryRelayService({ requireSignatures: false, relayNodeId: 'relay-b' });

  try {
    await publish(relayA, {
      room: 'main',
      sender: 'alice',
      id: 'm1',
      payload: { kind: 'hub.record', record: 'r1' },
    });

    const workerB = createServiceBackedWorker({
      localNodeId: 'relay-b',
      localService: relayB,
      peers: { 'relay-a': relayA },
    });

    const summary = await workerB.syncOnce();
    assertEquals(summary.processedPeers, 1);
    assertEquals(summary.pulledEntries, 1);
    assertEquals(summary.pushedEntries, 1);
    assertEquals(summary.failedPeers.length, 0);
    assertEquals(workerB.cursorFor('relay-a'), 1);

    assertEquals(await pollEnvelopeCount(relayB, 'main'), 1);
  } finally {
    relayA.close();
    relayB.close();
  }
});

Deno.test('cache sync worker does not advance cursor when local push fails', async () => {
  const relayA = createMemoryRelayService({ requireSignatures: false, relayNodeId: 'relay-a' });

  try {
    await publish(relayA, {
      room: 'main',
      sender: 'alice',
      id: 'm1',
      payload: { kind: 'hub.record', record: 'r1' },
    });

    let shouldFailPush = true;
    const worker = createCacheSyncWorker({
      peers: ['relay-a'],
      limit: 100,
      async pullFromPeer({ after, limit }) {
        const res = await relayA.fetch(
          new Request(
            `http://relay.local/api/v1/cache/exchange/pull?after=${after}&limit=${limit}&peer=relay-b`,
          ),
        );
        const body = await res.json() as { entries: unknown[]; next_cursor: number };
        return { entries: body.entries as any[], nextCursor: body.next_cursor };
      },
      async pushToLocal() {
        if (shouldFailPush) {
          throw new Error('simulated push failure');
        }
      },
    });

    const first = await worker.syncOnce();
    assertEquals(first.failedPeers, ['relay-a']);
    assertEquals(worker.cursorFor('relay-a'), 0);

    shouldFailPush = false;
    const second = await worker.syncOnce();
    assertEquals(second.failedPeers.length, 0);
    assertEquals(worker.cursorFor('relay-a'), 1);
  } finally {
    relayA.close();
  }
});

Deno.test('cache sync worker suppresses round-trip loop by peer filter', async () => {
  const relayA = createMemoryRelayService({ requireSignatures: false, relayNodeId: 'relay-a' });
  const relayB = createMemoryRelayService({ requireSignatures: false, relayNodeId: 'relay-b' });

  try {
    await publish(relayA, {
      room: 'main',
      sender: 'alice',
      id: 'm1',
      payload: { kind: 'hub.record', record: 'r1' },
    });

    const workerB = createServiceBackedWorker({
      localNodeId: 'relay-b',
      localService: relayB,
      peers: { 'relay-a': relayA },
    });
    await workerB.syncOnce();
    assertEquals(await pollEnvelopeCount(relayB, 'main'), 1);

    const workerA = createServiceBackedWorker({
      localNodeId: 'relay-a',
      localService: relayA,
      peers: { 'relay-b': relayB },
    });
    const summary = await workerA.syncOnce();
    assertEquals(summary.pulledEntries, 0);
    assertEquals(summary.pushedEntries, 0);

    assertEquals(await pollEnvelopeCount(relayA, 'main'), 1);
    assertEquals(await pollEnvelopeCount(relayB, 'main'), 1);
  } finally {
    relayA.close();
    relayB.close();
  }
});
