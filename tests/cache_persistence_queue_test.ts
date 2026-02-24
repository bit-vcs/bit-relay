import { assertEquals, assertRejects } from '@std/assert';
import { createCachePersistenceQueue } from '../src/cache_persistence_queue.ts';

Deno.test('cache persistence queue executes tasks sequentially', async () => {
  const order: string[] = [];
  const queue = createCachePersistenceQueue({
    maxRetries: 0,
    sleep: async () => {},
  });

  const a = queue.enqueue(async () => {
    order.push('a:start');
    await Promise.resolve();
    order.push('a:end');
  });
  const b = queue.enqueue(async () => {
    order.push('b:start');
    order.push('b:end');
  });

  await Promise.all([a, b]);
  assertEquals(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

Deno.test('cache persistence queue retries failed task and eventually succeeds', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const queue = createCachePersistenceQueue({
    maxRetries: 2,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 20,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  await queue.enqueue(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error(`transient-${attempts}`);
    }
  });

  assertEquals(attempts, 3);
  assertEquals(sleeps, [5, 10]);
});

Deno.test('cache persistence queue rejects after retry budget is exhausted', async () => {
  let attempts = 0;
  const queue = createCachePersistenceQueue({
    maxRetries: 1,
    retryBaseDelayMs: 1,
    sleep: async () => {},
  });

  await assertRejects(
    () =>
      queue.enqueue(async () => {
        attempts += 1;
        throw new Error('always-fail');
      }),
    Error,
    'always-fail',
  );
  assertEquals(attempts, 2);
});

Deno.test('cache persistence queue exposes retry/settled metrics hooks', async () => {
  const retries: Array<{ retryCount: number; delayMs: number }> = [];
  const settled: Array<{ success: boolean; retryCount: number; attempts: number }> = [];
  let attempts = 0;
  const queue = createCachePersistenceQueue({
    maxRetries: 2,
    retryBaseDelayMs: 3,
    sleep: async () => {},
    onRetry(entry) {
      retries.push({ retryCount: entry.retryCount, delayMs: entry.delayMs });
    },
    onSettled(entry) {
      settled.push({
        success: entry.success,
        retryCount: entry.retryCount,
        attempts: entry.attempts,
      });
    },
  });

  await queue.enqueue(async () => {
    attempts += 1;
    if (attempts < 2) {
      throw new Error('transient');
    }
  });

  assertEquals(retries, [{ retryCount: 1, delayMs: 3 }]);
  assertEquals(settled, [{ success: true, retryCount: 1, attempts: 2 }]);
});
