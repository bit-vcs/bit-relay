import { assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayHandler } from '../src/memory_handler.ts';

Deno.test('health endpoint returns ok', async () => {
  const handler = createMemoryRelayHandler({});
  const res = await handler(new Request('http://relay.local/health'));
  assertEquals(res.status, 200);
  assertObjectMatch(await res.json(), { status: 'ok', service: 'bit-relay' });
});

Deno.test('publish and poll with direct payload', async () => {
  const handler = createMemoryRelayHandler({});
  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=notify&id=m1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'hub.record', record: 'record-1' }),
    }),
  );
  assertEquals(publish.status, 200);
  assertObjectMatch(await publish.json(), { ok: true, accepted: true, cursor: 1 });

  const poll = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=200'),
  );
  assertEquals(poll.status, 200);
  const body = await poll.json();
  assertEquals(body.next_cursor, 1);
  assertEquals(body.envelopes.length, 1);
  assertObjectMatch(body.envelopes[0], {
    room: 'main',
    id: 'm1',
    sender: 'bit',
    topic: 'notify',
    payload: { kind: 'hub.record', record: 'record-1' },
  });
});

Deno.test('publish accepts wrapped payload for bithub compatibility', async () => {
  const handler = createMemoryRelayHandler({});
  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=node-a&topic=notify&id=b1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: {
          kind: 'bithub.node',
          url: 'http://127.0.0.1:3100',
          name: 'node-a',
        },
      }),
    }),
  );
  assertEquals(publish.status, 200);

  const poll = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=200'),
  );
  const body = await poll.json();
  assertEquals(body.envelopes.length, 1);
  assertObjectMatch(body.envelopes[0].payload, {
    kind: 'bithub.node',
    url: 'http://127.0.0.1:3100',
    name: 'node-a',
  });
});

Deno.test('publish deduplicates by message id in same room', async () => {
  const handler = createMemoryRelayHandler({});
  const req = (sender: string, value: number) =>
    new Request(
      `http://relay.local/api/v1/publish?room=main&sender=${sender}&topic=notify&id=same`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'hub.record', value }),
      },
    );

  const first = await handler(req('alice', 1));
  const second = await handler(req('bob', 2));

  assertObjectMatch(await first.json(), { accepted: true, cursor: 1 });
  assertObjectMatch(await second.json(), { accepted: false, cursor: 1 });
});

Deno.test('inbox pending and ack flow', async () => {
  const handler = createMemoryRelayHandler({});
  await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=alice&topic=notify&id=m1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'git_pr', number: 1 }),
    }),
  );
  await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=alice&topic=notify&id=m2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'git_pr', number: 2 }),
    }),
  );

  const pending1 = await handler(
    new Request('http://relay.local/api/v1/inbox/pending?room=main&consumer=reviewer-a&limit=10'),
  );
  const body1 = await pending1.json();
  assertEquals(body1.pending_count, 2);

  const ack = await handler(
    new Request('http://relay.local/api/v1/inbox/ack?room=main&consumer=reviewer-a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['m1'] }),
    }),
  );
  assertEquals(ack.status, 200);
  assertObjectMatch(await ack.json(), { newly_acked: 1, acked_total: 1 });

  const pending2 = await handler(
    new Request('http://relay.local/api/v1/inbox/pending?room=main&consumer=reviewer-a&limit=10'),
  );
  const body2 = await pending2.json();
  assertEquals(body2.pending_count, 1);
  assertEquals(body2.envelopes[0].id, 'm2');
});

Deno.test('requires bearer token when auth token configured', async () => {
  const handler = createMemoryRelayHandler({ authToken: 'secret-token' });

  const unauthorized = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=10'),
  );
  assertEquals(unauthorized.status, 401);

  const authorized = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=10', {
      headers: {
        authorization: 'Bearer secret-token',
      },
    }),
  );
  assertEquals(authorized.status, 200);
});
