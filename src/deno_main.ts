import {
  createMemoryRelayService,
  DEFAULT_MAX_MESSAGES_PER_ROOM,
  DEFAULT_MAX_WS_SESSIONS,
  DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
  DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
  DEFAULT_PUBLISH_WINDOW_MS,
  type MemoryRelayOptions,
} from './memory_handler.ts';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseRoomTokens(raw: string | undefined): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [room, token] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof token !== 'string') continue;
      out[room] = token;
    }
    return out;
  } catch {
    return {};
  }
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return fallback;
}

function optionsFromEnv(): MemoryRelayOptions {
  return {
    authToken: Deno.env.get('CLUSTER_API_TOKEN') ?? undefined,
    maxMessagesPerRoom: parsePositiveInt(
      Deno.env.get('RELAY_MAX_MESSAGES_PER_ROOM') ?? undefined,
      DEFAULT_MAX_MESSAGES_PER_ROOM,
    ),
    publishPayloadMaxBytes: parsePositiveInt(
      Deno.env.get('PUBLISH_PAYLOAD_MAX_BYTES') ?? undefined,
      DEFAULT_PUBLISH_PAYLOAD_MAX_BYTES,
    ),
    publishLimitPerWindow: parsePositiveInt(
      Deno.env.get('RELAY_PUBLISH_LIMIT_PER_WINDOW') ?? undefined,
      DEFAULT_PUBLISH_LIMIT_PER_WINDOW,
    ),
    publishWindowMs: parsePositiveInt(
      Deno.env.get('RELAY_PUBLISH_WINDOW_MS') ?? undefined,
      DEFAULT_PUBLISH_WINDOW_MS,
    ),
    roomTokens: parseRoomTokens(Deno.env.get('RELAY_ROOM_TOKENS') ?? undefined),
    maxWsSessions: parsePositiveInt(
      Deno.env.get('MAX_WS_SESSIONS') ?? undefined,
      DEFAULT_MAX_WS_SESSIONS,
    ),
    requireSignatures: parseBoolean(
      Deno.env.get('RELAY_REQUIRE_SIGNATURE') ?? undefined,
      true,
    ),
    maxClockSkewSec: parsePositiveInt(
      Deno.env.get('RELAY_MAX_CLOCK_SKEW_SEC') ?? undefined,
      300,
    ),
    nonceTtlSec: parsePositiveInt(Deno.env.get('RELAY_NONCE_TTL_SEC') ?? undefined, 600),
    maxNoncesPerSender: parsePositiveInt(
      Deno.env.get('RELAY_MAX_NONCES_PER_SENDER') ?? undefined,
      2048,
    ),
  };
}

const host = Deno.env.get('HOST') ?? '127.0.0.1';
const port = parsePositiveInt(Deno.env.get('PORT') ?? undefined, 8788);
const service = createMemoryRelayService(optionsFromEnv());

console.log(`[bit-relay] listening on http://${host}:${port}`);

Deno.serve({ hostname: host, port }, (request) => service.fetch(request));
