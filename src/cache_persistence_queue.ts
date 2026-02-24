export interface CachePersistenceQueueOptions {
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (entry: CachePersistenceQueueRetryEvent) => void;
  onSettled?: (entry: CachePersistenceQueueSettledEvent) => void;
}

export interface CachePersistenceQueue {
  enqueue(task: () => Promise<void>): Promise<void>;
  pendingCount(): number;
}

export interface CachePersistenceQueueRetryEvent {
  retryCount: number;
  delayMs: number;
  error: unknown;
}

export interface CachePersistenceQueueSettledEvent {
  success: boolean;
  attempts: number;
  retryCount: number;
  durationMs: number;
  error?: unknown;
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

function safeNotify(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch {
    // Observability callback failures must not affect queue semantics.
  }
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
  const onRetry = options.onRetry;
  const onSettled = options.onSettled;

  let pending = 0;
  let tail: Promise<void> = Promise.resolve();

  async function runWithRetry(task: () => Promise<void>): Promise<void> {
    const startedAtMs = Date.now();
    for (let attempt = 0;; attempt += 1) {
      try {
        await task();
        safeNotify(() =>
          onSettled?.({
            success: true,
            attempts: attempt + 1,
            retryCount: attempt,
            durationMs: Math.max(0, Date.now() - startedAtMs),
          })
        );
        return;
      } catch (error) {
        if (attempt >= maxRetries) {
          safeNotify(() =>
            onSettled?.({
              success: false,
              attempts: attempt + 1,
              retryCount: attempt,
              durationMs: Math.max(0, Date.now() - startedAtMs),
              error,
            })
          );
          throw error;
        }
        const delayMs = computeRetryDelayMs({
          retryIndex: attempt,
          retryBaseDelayMs,
          retryMaxDelayMs,
        });
        safeNotify(() =>
          onRetry?.({
            retryCount: attempt + 1,
            delayMs,
            error,
          })
        );
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
