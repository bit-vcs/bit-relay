export interface CachePersistenceQueueOptions {
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CachePersistenceQueue {
  enqueue(task: () => Promise<void>): Promise<void>;
  pendingCount(): number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 20;
const DEFAULT_RETRY_MAX_DELAY_MS = 500;

function normalizeNonNegativeInt(raw: number | undefined, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.trunc(raw));
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelayMs(args: {
  retryIndex: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): number {
  const scale = 2 ** Math.max(0, args.retryIndex);
  const delay = args.retryBaseDelayMs * scale;
  return Math.min(args.retryMaxDelayMs, delay);
}

export function createCachePersistenceQueue(
  options: CachePersistenceQueueOptions = {},
): CachePersistenceQueue {
  const maxRetries = normalizeNonNegativeInt(options.maxRetries, DEFAULT_MAX_RETRIES);
  const retryBaseDelayMs = normalizeNonNegativeInt(
    options.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS,
  );
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    normalizeNonNegativeInt(options.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS),
  );
  const sleep = options.sleep ?? defaultSleep;

  let pending = 0;
  let tail: Promise<void> = Promise.resolve();

  async function runWithRetry(task: () => Promise<void>): Promise<void> {
    for (let attempt = 0;; attempt += 1) {
      try {
        await task();
        return;
      } catch (error) {
        if (attempt >= maxRetries) {
          throw error;
        }
        const delayMs = computeRetryDelayMs({
          retryIndex: attempt,
          retryBaseDelayMs,
          retryMaxDelayMs,
        });
        await sleep(delayMs);
      }
    }
  }

  async function enqueue(task: () => Promise<void>): Promise<void> {
    pending += 1;
    const run = tail.then(async () => {
      await runWithRetry(task);
    });
    const settled = run.finally(() => {
      pending -= 1;
    });
    tail = settled.catch(() => {});
    return settled;
  }

  function pendingCount(): number {
    return pending;
  }

  return {
    enqueue,
    pendingCount,
  };
}
