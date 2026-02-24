import { assertEquals } from '@std/assert';
import { parseRelayRuntimeConfigFromEnv } from '../src/runtime_config.ts';

function envFrom(entries: Record<string, string | undefined>): (key: string) => string | undefined {
  return (key: string) => entries[key];
}

Deno.test('parseRelayRuntimeConfigFromEnv returns defaults', () => {
  const config = parseRelayRuntimeConfigFromEnv(envFrom({}));
  assertEquals(config.relay.authToken, undefined);
  assertEquals(config.relay.requireSignatures, true);
  assertEquals(config.github.enabled, false);
  assertEquals(config.github.apiBaseUrl, 'https://api.github.com');
  assertEquals(config.cache.provider, 'memory');
  assertEquals(config.cache.maxBytes, null);
  assertEquals(config.peers.urls, []);
  assertEquals(config.trigger.webhookUrl, null);
  assertEquals(config.trigger.eventType, 'relay.incoming_ref');
  assertEquals(config.trigger.refPrefixes, ['refs/relay/incoming/']);
  assertEquals(config.gitServe.sessionTtlSec, null);
});

Deno.test('parseRelayRuntimeConfigFromEnv parses peers from csv env', () => {
  const config = parseRelayRuntimeConfigFromEnv(
    envFrom({
      RELAY_PEERS: 'https://relay-a.example, https://relay-b.example ,, ',
      RELAY_PEER_SYNC_INTERVAL_SEC: '45',
    }),
  );

  assertEquals(config.peers.urls, ['https://relay-a.example', 'https://relay-b.example']);
  assertEquals(config.peers.syncIntervalSec, 45);
});

Deno.test('parseRelayRuntimeConfigFromEnv applies RELAY_CONFIG_JSON override', () => {
  const config = parseRelayRuntimeConfigFromEnv(
    envFrom({
      RELAY_GITHUB_ENABLED: 'false',
      RELAY_CACHE_PROVIDER: 'memory',
      RELAY_CONFIG_JSON: JSON.stringify({
        github: {
          enabled: true,
          token: 'ghs_xxx',
          api_base_url: 'https://gh.example/api',
          app_id: 42,
          app_installation_id: 99,
        },
        cache: {
          provider: 'r2',
          r2_bucket: 'bit-relay-cache',
          r2_prefix: 'relay/',
          ttl_sec: 172800,
          max_bytes: 10_485_760,
        },
        peers: {
          urls: ['https://relay-c.example'],
          sync_interval_sec: 12,
        },
        trigger: {
          webhook_url: 'https://ci.example/hook',
          webhook_token: 'token-1',
          event_type: 'relay.custom_ref',
          ref_prefixes: ['refs/custom/incoming/', 'refs/relay/incoming/'],
        },
        git_serve: {
          session_ttl_sec: 600,
        },
      }),
    }),
  );

  assertEquals(config.github.enabled, true);
  assertEquals(config.github.token, 'ghs_xxx');
  assertEquals(config.github.apiBaseUrl, 'https://gh.example/api');
  assertEquals(config.github.appId, 42);
  assertEquals(config.github.appInstallationId, 99);
  assertEquals(config.cache.provider, 'r2');
  assertEquals(config.cache.r2Bucket, 'bit-relay-cache');
  assertEquals(config.cache.r2Prefix, 'relay/');
  assertEquals(config.cache.ttlSec, 172800);
  assertEquals(config.cache.maxBytes, 10_485_760);
  assertEquals(config.peers.urls, ['https://relay-c.example']);
  assertEquals(config.peers.syncIntervalSec, 12);
  assertEquals(config.trigger.webhookUrl, 'https://ci.example/hook');
  assertEquals(config.trigger.webhookToken, 'token-1');
  assertEquals(config.trigger.eventType, 'relay.custom_ref');
  assertEquals(config.trigger.refPrefixes, ['refs/custom/incoming/', 'refs/relay/incoming/']);
  assertEquals(config.gitServe.sessionTtlSec, 600);
});

Deno.test('parseRelayRuntimeConfigFromEnv parses trigger rule env values', () => {
  const config = parseRelayRuntimeConfigFromEnv(
    envFrom({
      RELAY_TRIGGER_EVENT_TYPE: 'relay.ref_received',
      RELAY_TRIGGER_REF_PREFIXES: 'refs/custom/incoming/, refs/relay/incoming/',
    }),
  );

  assertEquals(config.trigger.eventType, 'relay.ref_received');
  assertEquals(config.trigger.refPrefixes, ['refs/custom/incoming/', 'refs/relay/incoming/']);
});

Deno.test('parseRelayRuntimeConfigFromEnv parses cache max bytes from env', () => {
  const config = parseRelayRuntimeConfigFromEnv(
    envFrom({
      RELAY_CACHE_MAX_BYTES: '2048',
    }),
  );

  assertEquals(config.cache.maxBytes, 2048);
});
