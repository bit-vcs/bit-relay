import { assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';

function publishRequest(args: {
  room: string;
  sender: string;
  id: string;
  topic?: string;
  payload: unknown;
}): Request {
  const topic = args.topic ?? 'notify';
  const url = new URL('http://relay.local/api/v1/publish');
  url.searchParams.set('room', args.room);
  url.searchParams.set('sender', args.sender);
  url.searchParams.set('topic', topic);
  url.searchParams.set('id', args.id);
  return new Request(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args.payload),
  });
}

function cachePullRequest(args: {
  after?: number;
  limit?: number;
  peer?: string;
  room?: string;
}): Request {
  const url = new URL('http://relay.local/api/v1/cache/exchange/pull');
  if (args.after !== undefined) url.searchParams.set('after', String(args.after));
  if (args.limit !== undefined) url.searchParams.set('limit', String(args.limit));
  if (args.peer !== undefined) url.searchParams.set('peer', args.peer);
  if (args.room !== undefined) url.searchParams.set('room', args.room);
  return new Request(url.toString(), { method: 'GET' });
}

function cachePushRequest(entries: unknown[]): Request {
  return new Request('http://relay.local/api/v1/cache/exchange/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
}

Deno.test('cache exchange discovery returns node id and static peers', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
    relayNodeId: 'relay-a',
    peerRelayUrls: ['https://relay-b.example', 'https://relay-c.example'],
  } as any);

  try {
    const res = await service.fetch(
      new Request('http://relay.local/api/v1/cache/exchange/discovery'),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertObjectMatch(body, {
      ok: true,
      protocol: 'cache.exchange.v1',
      node_id: 'relay-a',
      peers: ['https://relay-b.example', 'https://relay-c.example'],
    });
  } finally {
    service.close();
  }
});

Deno.test('cache exchange pull includes local publish entries', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
    relayNodeId: 'relay-a',
  } as any);

  try {
    const publishRes = await service.fetch(
      publishRequest({
        room: 'main',
        sender: 'alice',
        id: 'm1',
        payload: { kind: 'hub.record', record: 'r1' },
      }),
    );
    assertEquals(publishRes.status, 200);

    const pullRes = await service.fetch(cachePullRequest({ after: 0, limit: 10 }));
    assertEquals(pullRes.status, 200);
    const body = await pullRes.json();
    assertEquals(body.entries.length, 1);
    assertObjectMatch(body.entries[0], {
      room: 'main',
      id: 'm1',
      sender: 'alice',
      topic: 'notify',
      origin: 'relay-a',
      hop_count: 1,
    });
    assertEquals(body.next_cursor, 1);
  } finally {
    service.close();
  }
});

Deno.test('cache exchange push handles accepted, duplicate, and conflict', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
    relayNodeId: 'relay-a',
  } as any);

  const remoteEntry = {
    room: 'main',
    id: 'remote-1',
    sender: 'relay-bot',
    topic: 'notify',
    payload: { kind: 'cache.record', version: 1 },
    signature: null,
    origin: 'relay-b',
    hop_count: 0,
    max_hops: 4,
  };

  try {
    const firstPush = await service.fetch(cachePushRequest([remoteEntry]));
    assertEquals(firstPush.status, 200);
    assertObjectMatch(await firstPush.json(), {
      ok: true,
      accepted: 1,
      duplicates: 0,
      conflicts: 0,
      rejected: 0,
    });

    const duplicatePush = await service.fetch(cachePushRequest([remoteEntry]));
    assertEquals(duplicatePush.status, 200);
    assertObjectMatch(await duplicatePush.json(), {
      ok: true,
      accepted: 0,
      duplicates: 1,
      conflicts: 0,
      rejected: 0,
    });

    const conflictPush = await service.fetch(cachePushRequest([{
      ...remoteEntry,
      payload: { kind: 'cache.record', version: 2 },
    }]));
    assertEquals(conflictPush.status, 200);
    assertObjectMatch(await conflictPush.json(), {
      ok: true,
      accepted: 0,
      duplicates: 0,
      conflicts: 1,
      rejected: 0,
    });

    const pollRes = await service.fetch(
      new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=100'),
    );
    const pollBody = await pollRes.json();
    assertEquals(pollBody.envelopes.length, 1);
    assertObjectMatch(pollBody.envelopes[0], {
      id: 'remote-1',
      payload: { kind: 'cache.record', version: 1 },
    });
  } finally {
    service.close();
  }
});

Deno.test('cache exchange push rejects loop origin and exhausted hops', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
    relayNodeId: 'relay-a',
  } as any);

  try {
    const pushRes = await service.fetch(cachePushRequest([
      {
        room: 'main',
        id: 'loop-1',
        sender: 'relay-a',
        topic: 'notify',
        payload: { kind: 'cache.record', source: 'self' },
        signature: null,
        origin: 'relay-a',
        hop_count: 1,
        max_hops: 4,
      },
      {
        room: 'main',
        id: 'ttl-1',
        sender: 'relay-b',
        topic: 'notify',
        payload: { kind: 'cache.record', source: 'ttl' },
        signature: null,
        origin: 'relay-b',
        hop_count: 2,
        max_hops: 2,
      },
    ]));
    assertEquals(pushRes.status, 200);
    const body = await pushRes.json();
    assertObjectMatch(body, {
      ok: true,
      accepted: 0,
      duplicates: 0,
      conflicts: 0,
      rejected: 2,
    });
    assertObjectMatch(body.rejection_counts, {
      loop_origin: 1,
      max_hops_reached: 1,
    });

    const pollRes = await service.fetch(
      new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=10'),
    );
    const pollBody = await pollRes.json();
    assertEquals(pollBody.envelopes.length, 0);
  } finally {
    service.close();
  }
});

Deno.test('cache exchange pull applies peer and room filters', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
    relayNodeId: 'relay-a',
  } as any);

  try {
    await service.fetch(
      publishRequest({
        room: 'main',
        sender: 'alice',
        id: 'local-main',
        payload: { kind: 'cache.record', value: 'local' },
      }),
    );
    await service.fetch(cachePushRequest([
      {
        room: 'main',
        id: 'remote-main',
        sender: 'relay-b',
        topic: 'notify',
        payload: { kind: 'cache.record', value: 'remote-main' },
        signature: null,
        origin: 'relay-b',
        hop_count: 0,
        max_hops: 4,
      },
      {
        room: 'other',
        id: 'remote-other',
        sender: 'relay-c',
        topic: 'notify',
        payload: { kind: 'cache.record', value: 'remote-other' },
        signature: null,
        origin: 'relay-c',
        hop_count: 0,
        max_hops: 4,
      },
    ]));

    const pullRes = await service.fetch(
      cachePullRequest({ after: 0, limit: 10, peer: 'relay-b', room: 'main' }),
    );
    assertEquals(pullRes.status, 200);
    const body = await pullRes.json();
    assertEquals(body.entries.length, 1);
    assertEquals(body.entries[0].id, 'local-main');
  } finally {
    service.close();
  }
});
