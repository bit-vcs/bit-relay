import {
  DEFAULT_CACHE_EXCHANGE_MAX_HOPS,
  DEFAULT_CACHE_EXCHANGE_MAX_RECORDS,
  DEFAULT_IP_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_MAX_MESSAGES_PER_ROOM,
  DEFAULT_MAX_WS_SESSIONS,
  DEFAULT_PRESENCE_TTL_SEC,
  DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
  DEFAULT_PUBLISH_WINDOW_MS,
  DEFAULT_ROOM_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_WS_IDLE_TIMEOUT_MS,
  DEFAULT_WS_PING_INTERVAL_MS,
  type MemoryRelayOptions,
} from './memory_handler.ts';

export interface RelayGitHubConfig {
  enabled: boolean;
  token: string | null;
  apiBaseUrl: string;
  appId: number | null;
  appInstallationId: number | null;
  webhookSecret: string | null;
}

export interface RelayCacheConfig {
  provider: 'memory' | 'r2';
  r2Bucket: string | null;
  r2Prefix: string;
  ttlSec: number;
}

export interface RelayPeerConfig {
  urls: string[];
  syncIntervalSec: number;
  authToken: string | null;
}

export interface RelayTriggerConfig {
  webhookUrl: string | null;
  webhookToken: string | null;
}

export interface RelayGitServeConfig {
  sessionTtlSec: number | null;
}

export interface RelayRuntimeConfig {
  relay: MemoryRelayOptions;
  github: RelayGitHubConfig;
  cache: RelayCacheConfig;
  peers: RelayPeerConfig;
  trigger: RelayTriggerConfig;
  gitServe: RelayGitServeConfig;
}

export type EnvGetter = (key: string) => string | undefined;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function parseOptionalPositiveInt(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return fallback;
}

function parseOptionalString(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function parseRoomTokens(raw: string | undefined): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [room, token] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof token === 'string') out[room] = token;
    }
    return out;
  } catch {
    return {};
  }
}

function parseCsvUrls(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  const dedupe = new Set<string>();
  for (const candidate of raw.split(',')) {
    const value = candidate.trim();
    if (value.length === 0) continue;
    dedupe.add(value);
  }
  return [...dedupe];
}

function parsePeersJson(raw: string | undefined): string[] | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const dedupe = new Set<string>();
    for (const value of parsed) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      dedupe.add(trimmed);
    }
    return [...dedupe];
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function readRaw(record: Record<string, unknown>, snake: string, camel: string): unknown {
  if (Object.hasOwn(record, snake)) return record[snake];
  return record[camel];
}

function parseConfigJson(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asObject(parsed) ?? {};
  } catch {
    return {};
  }
}

function applyJsonOverride(
  base: RelayRuntimeConfig,
  rawJson: Record<string, unknown>,
): RelayRuntimeConfig {
  const config: RelayRuntimeConfig = {
    relay: { ...base.relay, roomTokens: { ...(base.relay.roomTokens ?? {}) } },
    github: { ...base.github },
    cache: { ...base.cache },
    peers: { ...base.peers, urls: [...base.peers.urls] },
    trigger: { ...base.trigger },
    gitServe: { ...base.gitServe },
  };

  const github = asObject(rawJson.github);
  if (github) {
    const enabled = asBoolean(readRaw(github, 'enabled', 'enabled'));
    if (enabled !== null) config.github.enabled = enabled;
    const token = asString(readRaw(github, 'token', 'token'));
    if (token !== null) config.github.token = token;
    const apiBaseUrl = asString(readRaw(github, 'api_base_url', 'apiBaseUrl'));
    if (apiBaseUrl !== null) config.github.apiBaseUrl = apiBaseUrl;
    const appId = asPositiveInt(readRaw(github, 'app_id', 'appId'));
    if (appId !== null) config.github.appId = appId;
    const appInstallationId = asPositiveInt(
      readRaw(github, 'app_installation_id', 'appInstallationId'),
    );
    if (appInstallationId !== null) config.github.appInstallationId = appInstallationId;
    const webhookSecret = asString(readRaw(github, 'webhook_secret', 'webhookSecret'));
    if (webhookSecret !== null) config.github.webhookSecret = webhookSecret;
  }

  const cache = asObject(rawJson.cache);
  if (cache) {
    const provider = asString(readRaw(cache, 'provider', 'provider'));
    if (provider === 'memory' || provider === 'r2') {
      config.cache.provider = provider;
    }
    const r2Bucket = asString(readRaw(cache, 'r2_bucket', 'r2Bucket'));
    if (r2Bucket !== null) config.cache.r2Bucket = r2Bucket;
    const r2Prefix = asString(readRaw(cache, 'r2_prefix', 'r2Prefix'));
    if (r2Prefix !== null) config.cache.r2Prefix = r2Prefix;
    const ttlSec = asPositiveInt(readRaw(cache, 'ttl_sec', 'ttlSec'));
    if (ttlSec !== null) config.cache.ttlSec = ttlSec;
  }

  const peers = asObject(rawJson.peers);
  if (peers) {
    const urlsRaw = readRaw(peers, 'urls', 'urls');
    if (Array.isArray(urlsRaw)) {
      const dedupe = new Set<string>();
      for (const value of urlsRaw) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed.length === 0) continue;
        dedupe.add(trimmed);
      }
      config.peers.urls = [...dedupe];
    }
    const syncIntervalSec = asPositiveInt(readRaw(peers, 'sync_interval_sec', 'syncIntervalSec'));
    if (syncIntervalSec !== null) config.peers.syncIntervalSec = syncIntervalSec;
    const authToken = asString(readRaw(peers, 'auth_token', 'authToken'));
    if (authToken !== null) config.peers.authToken = authToken;
  }

  const trigger = asObject(rawJson.trigger);
  if (trigger) {
    const webhookUrl = asString(readRaw(trigger, 'webhook_url', 'webhookUrl'));
    if (webhookUrl !== null) config.trigger.webhookUrl = webhookUrl;
    const webhookToken = asString(readRaw(trigger, 'webhook_token', 'webhookToken'));
    if (webhookToken !== null) config.trigger.webhookToken = webhookToken;
  }

  const gitServe = asObject(readRaw(rawJson, 'git_serve', 'gitServe'));
  if (gitServe) {
    const sessionTtlSec = asPositiveInt(readRaw(gitServe, 'session_ttl_sec', 'sessionTtlSec'));
    if (sessionTtlSec !== null) config.gitServe.sessionTtlSec = sessionTtlSec;
  }

  return config;
}

export function parseMemoryRelayOptionsFromEnv(getEnv: EnvGetter): MemoryRelayOptions {
  const peersFromJson = parsePeersJson(getEnv('RELAY_PEERS_JSON'));
  const peersFromCsv = parseCsvUrls(getEnv('RELAY_PEERS'));

  return {
    authToken: getEnv('BIT_RELAY_AUTH_TOKEN') ?? undefined,
    maxMessagesPerRoom: parsePositiveInt(
      getEnv('RELAY_MAX_MESSAGES_PER_ROOM'),
      DEFAULT_MAX_MESSAGES_PER_ROOM,
    ),
    publishPayloadMaxBytes: parsePositiveInt(
      getEnv('PUBLISH_PAYLOAD_MAX_BYTES'),
      DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
    ),
    publishLimitPerWindow: parsePositiveInt(
      getEnv('RELAY_PUBLISH_LIMIT_PER_WINDOW'),
      DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
    ),
    publishWindowMs: parsePositiveInt(getEnv('RELAY_PUBLISH_WINDOW_MS'), DEFAULT_PUBLISH_WINDOW_MS),
    ipPublishLimitPerWindow: parsePositiveInt(
      getEnv('RELAY_IP_PUBLISH_LIMIT_PER_WINDOW'),
      DEFAULT_IP_PUBLISH_LIMIT_PER_WINDOW,
    ),
    roomPublishLimitPerWindow: parsePositiveInt(
      getEnv('RELAY_ROOM_PUBLISH_LIMIT_PER_WINDOW'),
      DEFAULT_ROOM_PUBLISH_LIMIT_PER_WINDOW,
    ),
    roomTokens: parseRoomTokens(getEnv('RELAY_ROOM_TOKENS')),
    maxWsSessions: parsePositiveInt(getEnv('MAX_WS_SESSIONS'), DEFAULT_MAX_WS_SESSIONS),
    requireSignatures: parseBoolean(getEnv('RELAY_REQUIRE_SIGNATURE'), true),
    maxClockSkewSec: parsePositiveInt(getEnv('RELAY_MAX_CLOCK_SKEW_SEC'), 300),
    nonceTtlSec: parsePositiveInt(getEnv('RELAY_NONCE_TTL_SEC'), 600),
    maxNoncesPerSender: parsePositiveInt(getEnv('RELAY_MAX_NONCES_PER_SENDER'), 2048),
    presenceTtlSec: parsePositiveInt(getEnv('RELAY_PRESENCE_TTL_SEC'), DEFAULT_PRESENCE_TTL_SEC),
    wsPingIntervalMs:
      parsePositiveInt(getEnv('WS_PING_INTERVAL_SEC'), DEFAULT_WS_PING_INTERVAL_MS / 1000) * 1000,
    wsIdleTimeoutMs:
      parsePositiveInt(getEnv('WS_IDLE_TIMEOUT_SEC'), DEFAULT_WS_IDLE_TIMEOUT_MS / 1000) * 1000,
    relayNodeId: parseOptionalString(getEnv('RELAY_NODE_ID')) ?? undefined,
    peerRelayUrls: peersFromJson ?? peersFromCsv,
    cacheExchangeMaxHops: parsePositiveInt(
      getEnv('RELAY_CACHE_EXCHANGE_MAX_HOPS'),
      DEFAULT_CACHE_EXCHANGE_MAX_HOPS,
    ),
    cacheExchangeMaxRecords: parsePositiveInt(
      getEnv('RELAY_CACHE_EXCHANGE_MAX_RECORDS'),
      DEFAULT_CACHE_EXCHANGE_MAX_RECORDS,
    ),
    githubWebhookSecret: parseOptionalString(getEnv('RELAY_GITHUB_WEBHOOK_SECRET')) ?? undefined,
  };
}

export function parseRelayRuntimeConfigFromEnv(getEnv: EnvGetter): RelayRuntimeConfig {
  const peersFromJson = parsePeersJson(getEnv('RELAY_PEERS_JSON'));
  const peersFromCsv = parseCsvUrls(getEnv('RELAY_PEERS'));

  const base: RelayRuntimeConfig = {
    relay: parseMemoryRelayOptionsFromEnv(getEnv),
    github: {
      enabled: parseBoolean(getEnv('RELAY_GITHUB_ENABLED'), false),
      token: parseOptionalString(getEnv('RELAY_GITHUB_TOKEN')),
      apiBaseUrl: parseOptionalString(getEnv('RELAY_GITHUB_API_BASE_URL')) ??
        'https://api.github.com',
      appId: parseOptionalPositiveInt(getEnv('RELAY_GITHUB_APP_ID')),
      appInstallationId: parseOptionalPositiveInt(
        getEnv('RELAY_GITHUB_APP_INSTALLATION_ID') ?? getEnv('RELAY_GITHUB_INSTALLATION_ID'),
      ),
      webhookSecret: parseOptionalString(getEnv('RELAY_GITHUB_WEBHOOK_SECRET')),
    },
    cache: {
      provider: getEnv('RELAY_CACHE_PROVIDER') === 'r2' ? 'r2' : 'memory',
      r2Bucket: parseOptionalString(getEnv('RELAY_CACHE_R2_BUCKET')),
      r2Prefix: parseOptionalString(getEnv('RELAY_CACHE_R2_PREFIX')) ?? 'relay-cache/',
      ttlSec: parsePositiveInt(getEnv('RELAY_CACHE_TTL_SEC'), 86_400),
    },
    peers: {
      urls: peersFromJson ?? peersFromCsv,
      syncIntervalSec: parsePositiveInt(getEnv('RELAY_PEER_SYNC_INTERVAL_SEC'), 30),
      authToken: parseOptionalString(getEnv('RELAY_PEER_AUTH_TOKEN')),
    },
    trigger: {
      webhookUrl: parseOptionalString(getEnv('RELAY_TRIGGER_WEBHOOK_URL')),
      webhookToken: parseOptionalString(getEnv('RELAY_TRIGGER_WEBHOOK_TOKEN')),
    },
    gitServe: {
      sessionTtlSec: parseOptionalPositiveInt(getEnv('GIT_SERVE_SESSION_TTL_SEC')),
    },
  };

  const override = parseConfigJson(getEnv('RELAY_CONFIG_JSON'));
  return applyJsonOverride(base, override);
}
