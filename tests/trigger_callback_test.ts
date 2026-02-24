import { assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';

Deno.test('trigger callback publishes ci.result envelope and is visible from poll', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
  } as any);

  try {
    const callbackRes = await service.fetch(
      new Request('http://relay.local/api/v1/trigger/callback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ref: 'refs/relay/incoming/repo-ci',
          status: 'success',
          logs_url: 'https://ci.example/log/1',
          artifact_url: 'https://ci.example/artifacts/1',
          external_id: 'run-1',
        }),
      }),
    );
    assertEquals(callbackRes.status, 200);
    const callbackBody = await callbackRes.json();
    assertObjectMatch(callbackBody, {
      ok: true,
      accepted: true,
      room: 'repo-ci',
      topic: 'ci.result',
      ref: 'refs/relay/incoming/repo-ci',
      status: 'success',
    });

    const pollRes = await service.fetch(
      new Request('http://relay.local/api/v1/poll?room=repo-ci&after=0&limit=10'),
    );
    assertEquals(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assertEquals(pollBody.envelopes.length, 1);
    assertObjectMatch(pollBody.envelopes[0], {
      topic: 'ci.result',
      payload: {
        source: 'ci',
        status: 'success',
        logs_url: 'https://ci.example/log/1',
        artifact_url: 'https://ci.example/artifacts/1',
        external_id: 'run-1',
      },
    });
  } finally {
    service.close();
  }
});

Deno.test('trigger results endpoint returns ci.result timeline with cursor', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
  } as any);

  try {
    await service.fetch(
      new Request('http://relay.local/api/v1/publish?room=main&sender=bot&topic=notify&id=n-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'plain notify' }),
      }),
    );

    await service.fetch(
      new Request('http://relay.local/api/v1/trigger/callback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          room: 'main',
          ref: 'refs/relay/incoming/ci-main',
          status: 'failure',
          logs_url: 'https://ci.example/log/2',
        }),
      }),
    );

    const listRes = await service.fetch(
      new Request('http://relay.local/api/v1/trigger/results?room=main&after=0&limit=10'),
    );
    assertEquals(listRes.status, 200);
    const listBody = await listRes.json();
    assertEquals(listBody.results.length, 1);
    assertObjectMatch(listBody.results[0], {
      cursor: 2,
      topic: 'ci.result',
      payload: {
        status: 'failure',
      },
    });
    assertEquals(listBody.next_cursor, 2);
  } finally {
    service.close();
  }
});

Deno.test('trigger callback rejects missing required fields', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
  } as any);

  try {
    const res = await service.fetch(
      new Request('http://relay.local/api/v1/trigger/callback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ref: 'refs/relay/incoming/ci-main',
        }),
      }),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertObjectMatch(body, { ok: false, error: 'missing field: status' });
  } finally {
    service.close();
  }
});
