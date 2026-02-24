import { assertEquals } from '@std/assert';
import {
  type CacheExchangeRecord,
  classifyCacheExchangeCollision,
  parseIncomingCacheExchangeEntry,
  selectCacheExchangeEntries,
} from '../src/cache_exchange.ts';

Deno.test('cache exchange: classify collision distinguishes duplicate and conflict', () => {
  const existing = {
    room: 'main',
    id: 'a1',
    sender: 'alice',
    topic: 'notify',
    payload: { kind: 'r', value: 1 },
    signature: null,
  };

  const duplicate = {
    ...existing,
  };
  const conflict = {
    ...existing,
    payload: { kind: 'r', value: 2 },
  };

  assertEquals(classifyCacheExchangeCollision(existing, duplicate), 'duplicate');
  assertEquals(classifyCacheExchangeCollision(existing, conflict), 'conflict');
});

Deno.test('cache exchange: select entries respects cursor, peer, room, and hop limit', () => {
  const records: CacheExchangeRecord[] = [
    {
      cursor: 1,
      envelope: {
        room: 'main',
        id: 'a1',
        sender: 'alice',
        topic: 'notify',
        payload: { v: 1 },
        signature: null,
      },
      origin: 'relay-a',
      hopCount: 0,
      maxHops: 3,
    },
    {
      cursor: 2,
      envelope: {
        room: 'main',
        id: 'b1',
        sender: 'bob',
        topic: 'notify',
        payload: { v: 2 },
        signature: null,
      },
      origin: 'relay-b',
      hopCount: 1,
      maxHops: 3,
    },
    {
      cursor: 3,
      envelope: {
        room: 'other',
        id: 'c1',
        sender: 'carol',
        topic: 'notify',
        payload: { v: 3 },
        signature: null,
      },
      origin: 'relay-c',
      hopCount: 1,
      maxHops: 1,
    },
  ];

  const selected = selectCacheExchangeEntries(records, {
    after: 0,
    limit: 10,
    peer: 'relay-b',
    room: 'main',
  });

  assertEquals(selected.nextCursor, 3);
  assertEquals(selected.entries.length, 1);
  assertEquals(selected.entries[0].id, 'a1');
  assertEquals(selected.entries[0].hop_count, 1);
});

Deno.test('cache exchange: parse incoming entry validates required fields', () => {
  const ok = parseIncomingCacheExchangeEntry({
    room: 'main',
    id: 'id-1',
    sender: 'alice',
    topic: 'notify',
    payload: { hello: 'world' },
    signature: null,
    origin: 'relay-a',
    hop_count: 1,
    max_hops: 4,
  }, 3);
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.entry.maxHops, 4);
  }

  const ng = parseIncomingCacheExchangeEntry({
    room: 'main',
    id: '',
    sender: 'alice',
    topic: 'notify',
    payload: { hello: 'world' },
    origin: 'relay-a',
    hop_count: 1,
  }, 3);
  assertEquals(ng.ok, false);
});
