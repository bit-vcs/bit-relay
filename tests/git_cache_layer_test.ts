import { assertEquals, assertExists } from '@std/assert';
import { createMemoryCacheStore } from '../src/cache_store.ts';
import {
  buildGitCacheKeyFromRequest,
  CACHE_HIT_HEADER,
  readGitCache,
  writeGitCache,
} from '../src/git_cache_layer.ts';

Deno.test('git cache key normalizes query ordering and strips session_token', async () => {
  const requestA = new Request(
    'http://relay.local/git/repo/info/refs?service=git-upload-pack&session_token=abc',
    { method: 'GET' },
  );
  const requestB = new Request(
    'http://relay.local/git/repo/info/refs?session_token=zzz&service=git-upload-pack',
    { method: 'GET' },
  );

  const keyA = await buildGitCacheKeyFromRequest(requestA, 'owner/repo', '/info/refs');
  const keyB = await buildGitCacheKeyFromRequest(requestB, 'owner/repo', '/info/refs');

  assertEquals(keyA.kind, 'ref');
  assertEquals(keyA.key, keyB.key);
  assertEquals(keyA.requestHash, keyB.requestHash);
});

Deno.test('git cache read/write round-trip', async () => {
  const store = createMemoryCacheStore();
  const req = new Request('http://relay.local/git/repo/git-upload-pack', {
    method: 'POST',
    body: 'want-a',
  });
  const key = await buildGitCacheKeyFromRequest(req, 'repo1', '/git-upload-pack');

  const before = await readGitCache(store, key);
  assertEquals(before, null);

  await writeGitCache(
    store,
    key,
    new Response('PACK-A', {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
    }),
  );
  const after = await readGitCache(store, key);
  assertExists(after);
  assertEquals(after.status, 200);
  assertEquals(after.headers.get(CACHE_HIT_HEADER), '1');
  assertEquals(after.headers.get('content-type'), 'application/x-git-upload-pack-result');
  assertEquals(await after.text(), 'PACK-A');
});
