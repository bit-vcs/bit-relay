import { assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';
import { type CacheStore, createMemoryCacheStore } from '../src/cache_store.ts';

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

Deno.test('cache issue pull returns only issue topics from cache store', async () => {
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
        id: 'i-1',
        topic: 'issue',
        payload: { title: 'first issue' },
      }),
    );
    await service.fetch(
      publishRequest({
        room: 'repo-a',
        sender: 'alice',
        id: 'n-1',
        topic: 'notify',
        payload: { title: 'not issue' },
      }),
    );

    const res = await service.fetch(
      new Request('http://relay.local/api/v1/cache/issues/pull?room=repo-a&after=0&limit=10'),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.envelopes.length, 1);
    assertObjectMatch(body.envelopes[0], {
      id: 'i-1',
      topic: 'issue',
      payload: { title: 'first issue' },
    });

    const issueEntries = await cacheStore.list({ kind: 'issue', room: 'repo-a', limit: 10 });
    assertEquals(issueEntries.entries.length, 1);
    assertEquals(issueEntries.entries[0].key, 'repo-a/i-1');
    assertEquals(issueEntries.entries[0].ref, 'issue');

    const objectEntries = await cacheStore.list({ kind: 'object', room: 'repo-a', limit: 10 });
    assertEquals(objectEntries.entries.length, 1);
    assertEquals(objectEntries.entries[0].key, 'repo-a/n-1');
    assertEquals(objectEntries.entries[0].ref, 'notify');
  } finally {
    service.close();
  }
});

Deno.test('cache issue pull supports cursor pagination', async () => {
  const cacheStore = createMemoryCacheStore();
  const service = createMemoryRelayService({
    requireSignatures: false,
    cacheStore,
  } as any);

  try {
    for (let i = 0; i < 3; i += 1) {
      await service.fetch(
        publishRequest({
          room: 'repo-a',
          sender: 'alice',
          id: `i-${i}`,
          topic: 'issue',
          payload: { seq: i },
        }),
      );
    }

    const page1 = await service.fetch(
      new Request('http://relay.local/api/v1/cache/issues/pull?room=repo-a&after=0&limit=2'),
    );
    assertEquals(page1.status, 200);
    const body1 = await page1.json();
    assertEquals(body1.envelopes.length, 2);
    assertEquals(body1.next_cursor, 2);

    const page2 = await service.fetch(
      new Request('http://relay.local/api/v1/cache/issues/pull?room=repo-a&after=2&limit=2'),
    );
    assertEquals(page2.status, 200);
    const body2 = await page2.json();
    assertEquals(body2.envelopes.length, 1);
    assertEquals(body2.next_cursor, 3);
  } finally {
    service.close();
  }
});

Deno.test('cache issue pull returns 405 for non-GET', async () => {
  const cacheStore = createMemoryCacheStore();
  const service = createMemoryRelayService({
    requireSignatures: false,
    cacheStore,
  } as any);

  try {
    const res = await service.fetch(
      new Request('http://relay.local/api/v1/cache/issues/pull?room=repo-a', {
        method: 'POST',
      }),
    );
    assertEquals(res.status, 405);
  } finally {
    service.close();
  }
});

function createFailingListCacheStore(): CacheStore {
  return {
    async put(): Promise<void> {
      // no-op
    },
    async get(): Promise<null> {
      return null;
    },
    async delete(): Promise<boolean> {
      return false;
    },
    async list() {
      throw new Error('list failed');
    },
  };
}

Deno.test('cache issue pull degrades when cache backend list fails', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
    cacheStore: createFailingListCacheStore(),
  } as any);

  try {
    const res = await service.fetch(
      new Request('http://relay.local/api/v1/cache/issues/pull?room=repo-a&after=10&limit=5'),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.room, 'repo-a');
    assertEquals(body.next_cursor, 10);
    assertEquals(Array.isArray(body.envelopes), true);
    assertEquals(body.envelopes.length, 0);
  } finally {
    service.close();
  }
});
