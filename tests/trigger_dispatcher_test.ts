import { assertEquals } from '@std/assert';
import { createWebhookTriggerDispatcher } from '../src/trigger_dispatcher.ts';
import type { IncomingRefRelayEvent } from '../src/contracts.ts';

function incomingRefEvent(ref: string): IncomingRefRelayEvent {
  return {
    type: 'incoming_ref',
    eventId: 'evt-1',
    occurredAt: 1_700_000_000,
    room: 'main',
    source: 'deno:test',
    target: 'session:abc',
    ref,
  };
}

Deno.test('webhook trigger dispatcher posts incoming ref payload with bearer token', async () => {
  const calls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
  const dispatcher = createWebhookTriggerDispatcher({
    webhookUrl: 'https://ci.example/hook',
    webhookToken: 'token-1',
    fetchFn: async (input, init) => {
      const req = new Request(input as RequestInfo | URL, init);
      const text = await req.text();
      calls.push({
        url: req.url,
        method: req.method,
        auth: req.headers.get('authorization'),
        body: text.length > 0 ? JSON.parse(text) : null,
      });
      return new Response('{}', { status: 202 });
    },
  });

  const result = await dispatcher.dispatchIncomingRef(incomingRefEvent('refs/relay/incoming/ci-1'));
  assertEquals(result.ok, true);
  assertEquals(result.dispatched, true);
  assertEquals(result.status, 202);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, 'https://ci.example/hook');
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[0].auth, 'Bearer token-1');
  const body = calls[0].body as Record<string, unknown>;
  assertEquals(body.event_type, 'relay.incoming_ref');
  assertEquals(body.ref, 'refs/relay/incoming/ci-1');
});

Deno.test('webhook trigger dispatcher skips non incoming refs', async () => {
  let called = 0;
  const dispatcher = createWebhookTriggerDispatcher({
    webhookUrl: 'https://ci.example/hook',
    fetchFn: async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    },
  });

  const result = await dispatcher.dispatchIncomingRef(incomingRefEvent('refs/heads/main'));
  assertEquals(result.ok, true);
  assertEquals(result.dispatched, false);
  assertEquals(called, 0);
});

Deno.test('webhook trigger dispatcher returns error for non-2xx status', async () => {
  const dispatcher = createWebhookTriggerDispatcher({
    webhookUrl: 'https://ci.example/hook',
    fetchFn: async () => new Response('fail', { status: 500 }),
  });

  const result = await dispatcher.dispatchIncomingRef(incomingRefEvent('refs/relay/incoming/ci-2'));
  assertEquals(result.ok, false);
  assertEquals(result.dispatched, true);
  assertEquals(result.status, 500);
  assertEquals(result.error, 'trigger dispatch failed: status=500');
});
