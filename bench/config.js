// Shared configuration for k6 benchmark tests

function normalizeRelayUrls(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const relayUrlsFromEnv = normalizeRelayUrls(__ENV.RELAY_URLS || '');
const fallbackBaseUrl = __ENV.BASE_URL || 'http://localhost:8788';
export const BASE_URL = relayUrlsFromEnv.length > 0 ? relayUrlsFromEnv[0] : fallbackBaseUrl;
export const RELAY_URLS = relayUrlsFromEnv.length > 0 ? relayUrlsFromEnv : [BASE_URL];
export const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
export const RUN_ID = __ENV.RUN_ID || `run-${Date.now()}`;

// WebSocket URL derived from BASE_URL
const wsScheme = BASE_URL.startsWith('https') ? 'wss' : 'ws';
const wsHost = BASE_URL.replace(/^https?:\/\//, '');
export const WS_URL = `${wsScheme}://${wsHost}`;

export function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
}
