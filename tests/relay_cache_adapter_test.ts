import { assertEquals } from '@std/assert';
import { createMemoryCacheStore } from '../src/cache_store.ts';
import { createRelayCacheAdapter } from '../src/relay_cache_adapter.ts';

function isValidRoomName(room: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(room);
}

function isValidTopic(topic: string): boolean {
  return /^[a-z][a-z0-9._-]{0,63}$/.test(topic);
}

Deno.test('relay cache adapter persists envelope and serves pull/sync views', async () => {
  const adapter = createRelayCacheAdapter({
    cacheStore: createMemoryCacheStore(),
    isValidRoomName,
    isValidTopic,
    nowSec: () => 1_700_000_000,
    cachePersistMaxRetries: 0,
  });

  await adapter.persistEnvelope(
    {
      room: 'repo-a',
      id: 'issue-1',
      sender: 'alice',
      topic: 'issue',
      payload: { title: 'first issue' },
      signature: null,
    },
    1,
  );

  const pull = await adapter.pullIssues('repo-a', 0, 10);
  assertEquals(pull.envelopes.length, 1);
  assertEquals(pull.envelopes[0].id, 'issue-1');
  assertEquals(pull.nextCursor, 1);

  const sync = await adapter.syncIssues('repo-a', 0, 10, 10);
  assertEquals(sync.events.length, 1);
  assertEquals(sync.snapshots.length, 1);
  assertEquals(sync.roomCursor, 1);
  assertEquals(sync.nextCursor, 1);
});

Deno.test('relay cache adapter snapshots and restores issue cursors', () => {
  const adapter = createRelayCacheAdapter({
    cacheStore: null,
    isValidRoomName,
    isValidTopic,
  });

  adapter.restoreIssueCursors({
    'repo-a': 42,
    '': 10,
    'repo-b': Number.NaN,
  });

  const snapshot = adapter.snapshotIssueCursors();
  assertEquals(snapshot, { 'repo-a': 42 });
});
