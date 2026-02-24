import type { CacheExchangeEntry } from './cache_exchange.ts';

const DEFAULT_SYNC_LIMIT = 200;

export interface CacheSyncPullRequest {
  peer: string;
  after: number;
  limit: number;
}

export interface CacheSyncPullResult {
  entries: CacheExchangeEntry[];
  nextCursor: number;
}

export interface CacheSyncPushRequest {
  peer: string;
  entries: CacheExchangeEntry[];
}

export interface CacheSyncWorkerOptions {
  peers: string[];
  limit?: number;
  pullFromPeer(request: CacheSyncPullRequest): Promise<CacheSyncPullResult>;
  pushToLocal(request: CacheSyncPushRequest): Promise<void>;
}

export interface CacheSyncSummary {
  skipped: boolean;
  processedPeers: number;
  pulledEntries: number;
  pushedEntries: number;
  failedPeers: string[];
}

export interface CacheSyncWorker {
  syncOnce(): Promise<CacheSyncSummary>;
  cursorFor(peer: string): number;
  peers(): string[];
}

function normalizeLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SYNC_LIMIT;
  return Math.max(1, Math.trunc(raw));
}

function normalizePeers(raw: string[]): string[] {
  const dedupe = new Set<string>();
  for (const peer of raw) {
    if (typeof peer !== 'string') continue;
    const trimmed = peer.trim();
    if (trimmed.length === 0) continue;
    dedupe.add(trimmed);
  }
  return [...dedupe];
}

function toCursor(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

export function createCacheSyncWorker(options: CacheSyncWorkerOptions): CacheSyncWorker {
  const peers = normalizePeers(options.peers);
  const limit = normalizeLimit(options.limit);
  const cursors = new Map<string, number>(peers.map((peer) => [peer, 0]));
  let inFlight = false;

  async function syncOnce(): Promise<CacheSyncSummary> {
    if (inFlight) {
      return {
        skipped: true,
        processedPeers: 0,
        pulledEntries: 0,
        pushedEntries: 0,
        failedPeers: [],
      };
    }
    inFlight = true;
    try {
      const summary: CacheSyncSummary = {
        skipped: false,
        processedPeers: 0,
        pulledEntries: 0,
        pushedEntries: 0,
        failedPeers: [],
      };

      for (const peer of peers) {
        const after = cursors.get(peer) ?? 0;
        try {
          const pulled = await options.pullFromPeer({ peer, after, limit });
          const entries = Array.isArray(pulled.entries) ? pulled.entries : [];
          const nextCursor = toCursor(pulled.nextCursor, after);

          if (entries.length > 0) {
            await options.pushToLocal({ peer, entries });
            summary.pushedEntries += entries.length;
          }

          summary.processedPeers += 1;
          summary.pulledEntries += entries.length;
          cursors.set(peer, Math.max(after, nextCursor));
        } catch {
          summary.failedPeers.push(peer);
        }
      }

      return summary;
    } finally {
      inFlight = false;
    }
  }

  function cursorFor(peer: string): number {
    return cursors.get(peer) ?? 0;
  }

  return {
    syncOnce,
    cursorFor,
    peers: () => [...peers],
  };
}
