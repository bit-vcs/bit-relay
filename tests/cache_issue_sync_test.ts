import { assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';
import { createMemoryCacheStore } from '../src/cache_store.ts';

function publishRequest(args: {
  room: string;
  sender: string;
  id: string;
  topic: string;
  payload: unknown;
}): Request {
  const url = new URL('http://relay.local/api/v1/publish');
  url.searchParams.set('room', args.room);
  url.searchParams.set('sender', args.sender);
  url.searchParams.set('id', args.id);
  url.searchParams.set('topic', args.topic);
  return new Request(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args.payload),
  });
}

Deno.test('cache issue sync returns snapshots and incremental events', async () => {
  const cacheStore = createMemoryCacheStore();
  const service = createMemoryRelayService({
    requireSignatures: false,
    cacheStore,
  } as any);

  try {
    await service.fetch(
      publishRequest({
        room: 'repo-a',
        sender: 'alice',
        id: 'ev-1',
        topic: 'issue',
        payload: { issue_id: 'issue-1', title: 'first' },
      }),
    );
    await service.fetch(
      publishRequest({
        room: 'repo-a',
        sender: 'alice',
        id: 'ev-2',
        topic: 'issue.updated',
        payload: { issue_id: 'issue-1', title: 'first updated' },
      }),
    );
    await service.fetch(
      publishRequest({
        room: 'repo-a',
        sender: 'alice',
        id: 'ev-3',
        topic: 'issue.closed',
        payload: { issue_id: 'issue-1', state: 'closed' },
      }),
    );
    await service.fetch(
      publishRequest({
        room: 'repo-a',
        sender: 'alice',
        id: 'ev-4',
        topic: 'issue',
        payload: { issue_id: 'issue-2', title: 'second' },
      }),
    );

    const sync1Res = await service.fetch(
      new Request('http://relay.local/api/v1/cache/issues/sync?room=repo-a&after=0&limit=2'),
    );
    assertEquals(sync1Res.status, 200);
    const sync1 = await sync1Res.json() as {
      next_cursor: number;
      room_cursor: number;
      events: Array<Record<string, unknown>>;
      snapshots: Array<Record<string, unknown>>;
    };
    assertEquals(sync1.next_cursor, 2);
    assertEquals(sync1.room_cursor, 4);
    assertEquals(sync1.events.length, 2);
    assertObjectMatch(sync1.events[0], { cursor: 1, issue_id: 'issue-1' });
    assertObjectMatch(sync1.events[1], { cursor: 2, issue_id: 'issue-1' });

    const issue1Snapshot = sync1.snapshots.find((item) => item.issue_id === 'issue-1');
    const issue2Snapshot = sync1.snapshots.find((item) => item.issue_id === 'issue-2');
    assertEquals(issue1Snapshot?.last_cursor, 3);
    assertEquals(issue2Snapshot?.last_cursor, 4);

    const sync2Res = await service.fetch(
      new Request('http://relay.local/api/v1/cache/issues/sync?room=repo-a&after=2&limit=10'),
    );
    assertEquals(sync2Res.status, 200);
    const sync2 = await sync2Res.json() as {
      next_cursor: number;
      events: Array<Record<string, unknown>>;
    };
    assertEquals(sync2.next_cursor, 4);
    assertEquals(sync2.events.length, 2);
    assertObjectMatch(sync2.events[0], { cursor: 3, issue_id: 'issue-1' });
    assertObjectMatch(sync2.events[1], { cursor: 4, issue_id: 'issue-2' });
  } finally {
    service.close();
  }
});

Deno.test('cache issue sync keeps room cursor across relay restart with shared cache store', async () => {
  const sharedCacheStore = createMemoryCacheStore();
  const first = createMemoryRelayService({
    requireSignatures: false,
    cacheStore: sharedCacheStore,
  } as any);

  try {
    await first.fetch(
      publishRequest({
        room: 'repo-b',
        sender: 'alice',
        id: 'ev-1',
        topic: 'issue',
        payload: { issue_id: 'issue-1', title: 'first' },
      }),
    );
  } finally {
    first.close();
  }

  const second = createMemoryRelayService({
    requireSignatures: false,
    cacheStore: sharedCacheStore,
  } as any);

  try {
    await second.fetch(
      publishRequest({
        room: 'repo-b',
        sender: 'alice',
        id: 'ev-2',
        topic: 'issue.updated',
        payload: { issue_id: 'issue-1', title: 'second update' },
      }),
    );

    const syncRes = await second.fetch(
      new Request('http://relay.local/api/v1/cache/issues/sync?room=repo-b&after=0&limit=10'),
    );
    assertEquals(syncRes.status, 200);
    const sync = await syncRes.json() as {
      room_cursor: number;
      next_cursor: number;
      events: Array<Record<string, unknown>>;
      snapshots: Array<Record<string, unknown>>;
    };
    assertEquals(sync.room_cursor, 2);
    assertEquals(sync.next_cursor, 2);
    assertEquals(sync.events.length, 2);
    assertObjectMatch(sync.events[0], { cursor: 1, issue_id: 'issue-1' });
    assertObjectMatch(sync.events[1], { cursor: 2, issue_id: 'issue-1' });
    assertEquals(sync.snapshots.length, 1);
    assertObjectMatch(sync.snapshots[0], { issue_id: 'issue-1', last_cursor: 2 });
  } finally {
    second.close();
  }
});

Deno.test('cache issue sync returns 405 for non-GET', async () => {
  const cacheStore = createMemoryCacheStore();
  const service = createMemoryRelayService({
    requireSignatures: false,
    cacheStore,
  } as any);

  try {
    const res = await service.fetch(
      new Request('http://relay.local/api/v1/cache/issues/sync?room=repo-a', {
        method: 'POST',
      }),
    );
    assertEquals(res.status, 405);
  } finally {
    service.close();
  }
});
