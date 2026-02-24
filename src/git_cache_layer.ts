import type { CacheStore, CacheStoreKind } from './cache_store.ts';

const CACHE_HIT_HEADER = 'x-bit-relay-cache-hit';

export interface GitCacheKey {
  kind: CacheStoreKind;
  key: string;
  sessionId: string;
  pathWithQuery: string;
  requestHash: string;
}

export interface GitCacheSafeOptions {
  onError?: (error: unknown) => void;
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.replaceAll('/', '__');
}

function classifyKind(gitPath: string): CacheStoreKind {
  if (gitPath === '/HEAD' || gitPath.startsWith('/info/refs')) {
    return 'ref';
  }
  return 'pack';
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return toHex(digest);
}

function canonicalizePathWithQuery(gitPath: string, requestUrl: URL): string {
  const params = new URLSearchParams(requestUrl.search);
  params.delete('session_token');
  params.sort();
  const query = params.toString();
  return query.length > 0 ? `${gitPath}?${query}` : gitPath;
}

export async function buildGitCacheKeyFromRequest(
  request: Request,
  sessionId: string,
  gitPath: string,
): Promise<GitCacheKey> {
  const requestUrl = new URL(request.url);
  const pathWithQuery = canonicalizePathWithQuery(gitPath, requestUrl);
  const method = request.method.toUpperCase();
  const bodyBytes = method === 'POST' || method === 'PUT'
    ? new Uint8Array(await request.arrayBuffer())
    : new Uint8Array();
  const bodyHash = await sha256HexBytes(bodyBytes);
  const hashInput = new TextEncoder().encode(`${method}\n${pathWithQuery}\n${bodyHash}`);
  const requestHash = await sha256HexBytes(hashInput);
  const sessionPart = normalizeSessionId(sessionId);
  return {
    kind: classifyKind(gitPath),
    key: `git/${sessionPart}/${requestHash}`,
    sessionId,
    pathWithQuery,
    requestHash,
  };
}

export async function writeGitCache(
  cacheStore: CacheStore,
  cacheKey: GitCacheKey,
  response: Response,
): Promise<void> {
  if (response.status !== 200) return;
  const responseClone = response.clone();
  const body = new Uint8Array(await responseClone.arrayBuffer());
  const contentType = responseClone.headers.get('content-type') ?? undefined;
  const contentHash = await sha256HexBytes(body);
  await cacheStore.put({
    kind: cacheKey.kind,
    key: cacheKey.key,
    body,
    room: 'git',
    ref: cacheKey.sessionId,
    contentHash,
    contentType,
  });
}

export async function readGitCache(
  cacheStore: CacheStore,
  cacheKey: GitCacheKey,
): Promise<Response | null> {
  const cached = await cacheStore.get(cacheKey.kind, cacheKey.key);
  if (!cached) return null;
  const headers = new Headers();
  if (cached.metadata.contentType) {
    headers.set('content-type', cached.metadata.contentType);
  }
  headers.set(CACHE_HIT_HEADER, '1');
  const body = new Uint8Array(cached.body);
  return new Response(body.buffer as ArrayBuffer, { status: 200, headers });
}

export async function safeWriteGitCache(
  cacheStore: CacheStore,
  cacheKey: GitCacheKey,
  response: Response,
  options: GitCacheSafeOptions = {},
): Promise<void> {
  try {
    await writeGitCache(cacheStore, cacheKey, response);
  } catch (error) {
    options.onError?.(error);
  }
}

export async function safeReadGitCache(
  cacheStore: CacheStore,
  cacheKey: GitCacheKey,
  options: GitCacheSafeOptions = {},
): Promise<Response | null> {
  try {
    return await readGitCache(cacheStore, cacheKey);
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

export { CACHE_HIT_HEADER };
