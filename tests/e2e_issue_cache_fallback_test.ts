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

Deno.test('e2e issue cache fallback: issue can be pulled from cache without origin room state', async () => {
  const sharedCacheStore = createMemoryCacheStore();
  const origin = createMemoryRelayService({
    requireSignatures: false,
    cacheStore: sharedCacheStore,
  } as any);

  try {
    const publishRes = await origin.fetch(
      publishRequest({
        room: 'repo-cache',
        sender: 'alice',
        id: 'issue-1',
        topic: 'issue',
        payload: { title: 'persisted issue' },
      }),
    );
    assertEquals(publishRes.status, 200);
  } finally {
    origin.close();
  }

  // New relay node with empty in-memory room state but same cache store
  const cacheNode = createMemoryRelayService({
    requireSignatures: false,
    cacheStore: sharedCacheStore,
  } as any);

  try {
    const pollRes = await cacheNode.fetch(
      new Request('http://relay.local/api/v1/poll?room=repo-cache&after=0&limit=10'),
    );
    assertEquals(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assertEquals(pollBody.envelopes.length, 0);

    const issuePullRes = await cacheNode.fetch(
      new Request('http://relay.local/api/v1/cache/issues/pull?room=repo-cache&after=0&limit=10'),
    );
    assertEquals(issuePullRes.status, 200);
    const body = await issuePullRes.json();
    assertEquals(body.envelopes.length, 1);
    assertObjectMatch(body.envelopes[0], {
      id: 'issue-1',
      topic: 'issue',
      room: 'repo-cache',
      payload: { title: 'persisted issue' },
    });

    const issueSyncRes = await cacheNode.fetch(
      new Request('http://relay.local/api/v1/cache/issues/sync?room=repo-cache&after=0&limit=10'),
    );
    assertEquals(issueSyncRes.status, 200);
    const syncBody = await issueSyncRes.json();
    assertEquals(syncBody.room_cursor, 1);
    assertEquals(syncBody.next_cursor, 1);
    assertEquals(syncBody.events.length, 1);
    assertEquals(syncBody.snapshots.length, 1);
    assertObjectMatch(syncBody.events[0], {
      cursor: 1,
      issue_id: 'issue-1',
    });
    assertObjectMatch(syncBody.snapshots[0], {
      issue_id: 'issue-1',
      last_cursor: 1,
    });
  } finally {
    cacheNode.close();
  }
});
