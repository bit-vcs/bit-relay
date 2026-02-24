import { assertEquals, assertExists } from '@std/assert';
import {
  type CacheStore,
  type CacheStoreObject,
  createMemoryCacheStore,
  createR2CacheStore,
  type R2BucketLike,
} from '../src/cache_store.ts';

interface StoredObject {
  body: Uint8Array;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  uploaded: Date;
}

class FakeR2ObjectBody {
  readonly body: Uint8Array;
  readonly size: number;
  readonly uploaded: Date;
  readonly httpMetadata?: { contentType?: string };
  readonly customMetadata?: Record<string, string>;

  constructor(source: StoredObject) {
    this.body = source.body;
    this.size = source.body.byteLength;
    this.uploaded = source.uploaded;
    this.httpMetadata = source.httpMetadata;
    this.customMetadata = source.customMetadata;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Uint8Array(this.body).buffer as ArrayBuffer;
  }
}

class FakeR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, StoredObject>();

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void> {
    const body = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);
    this.objects.set(key, {
      body,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      uploaded: new Date(),
    });
  }

  async get(key: string): Promise<FakeR2ObjectBody | null> {
    const found = this.objects.get(key);
    return found ? new FakeR2ObjectBody(found) : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    objects: Array<{
      key: string;
      size: number;
      uploaded: Date;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }>;
    truncated: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    const limit = Math.max(1, Math.trunc(options?.limit ?? 1000));
    const start = Math.max(0, Number.parseInt(options?.cursor ?? '0', 10) || 0);
    const filtered = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b));

    const page = filtered.slice(start, start + limit).map(([key, object]) => ({
      key,
      size: object.body.byteLength,
      uploaded: object.uploaded,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    }));

    const next = start + page.length;
    const truncated = next < filtered.length;
    return {
      objects: page,
      truncated,
      ...(truncated ? { cursor: String(next) } : {}),
    };
  }
}

function textOf(object: CacheStoreObject | null): string | null {
  if (!object) return null;
  return new TextDecoder().decode(object.body);
}

type StoreFactory = () => CacheStore;

function runCacheStoreContract(name: string, createStore: StoreFactory): void {
  Deno.test(`${name}: put/get/delete`, async () => {
    const store = createStore();
    await store.put({
      kind: 'object',
      key: 'obj/1',
      body: new TextEncoder().encode('hello'),
      room: 'main',
      contentHash: 'sha256:abc',
      contentType: 'application/octet-stream',
    });

    const found = await store.get('object', 'obj/1');
    assertEquals(textOf(found), 'hello');
    assertExists(found);
    assertEquals(found.metadata.room, 'main');
    assertEquals(found.metadata.contentHash, 'sha256:abc');

    const deleted = await store.delete('object', 'obj/1');
    assertEquals(deleted, true);
    assertEquals(await store.get('object', 'obj/1'), null);
    assertEquals(await store.delete('object', 'obj/1'), false);
  });

  Deno.test(`${name}: list supports kind/prefix/room and cursor`, async () => {
    const store = createStore();
    await store.put({
      kind: 'object',
      key: 'k/1',
      body: new TextEncoder().encode('a'),
      room: 'room-a',
    });
    await store.put({
      kind: 'object',
      key: 'k/2',
      body: new TextEncoder().encode('b'),
      room: 'room-a',
    });
    await store.put({
      kind: 'object',
      key: 'k/3',
      body: new TextEncoder().encode('c'),
      room: 'room-b',
    });
    await store.put({
      kind: 'issue',
      key: 'issue/1',
      body: new TextEncoder().encode('i'),
      room: 'room-a',
    });

    const page1 = await store.list({ kind: 'object', prefix: 'k/', room: 'room-a', limit: 1 });
    assertEquals(page1.entries.length, 1);
    assertExists(page1.cursor);

    const page2 = await store.list({
      kind: 'object',
      prefix: 'k/',
      room: 'room-a',
      limit: 10,
      cursor: page1.cursor ?? undefined,
    });
    assertEquals(page2.entries.length, 1);
    assertEquals(page2.cursor, null);

    const roomB = await store.list({ kind: 'object', room: 'room-b' });
    assertEquals(roomB.entries.length, 1);
    assertEquals(roomB.entries[0].key, 'k/3');

    const issues = await store.list({ kind: 'issue', room: 'room-a' });
    assertEquals(issues.entries.length, 1);
    assertEquals(issues.entries[0].key, 'issue/1');
  });
}

runCacheStoreContract('memory cache store', () => createMemoryCacheStore());
runCacheStoreContract('r2 cache store', () => {
  const bucket = new FakeR2Bucket();
  return createR2CacheStore({ bucket, prefix: 'relay-cache/' });
});
