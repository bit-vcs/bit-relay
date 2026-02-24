import { assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';
import { createMemoryCacheStore } from '../src/cache_store.ts';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signGitHubWebhook(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  return `sha256=${toHex(signature)}`;
}

function createIssueEventPayload(action: string): Record<string, unknown> {
  return {
    action,
    issue: {
      number: 42,
      title: 'bug report',
      state: action === 'closed' ? 'closed' : 'open',
      html_url: 'https://github.com/acme/api/issues/42',
    },
    repository: {
      full_name: 'acme/api',
    },
    sender: {
      login: 'octocat',
    },
  };
}

Deno.test('github webhook verifies signature and publishes mapped issue event', async () => {
  const secret = 'hook-secret';
  const service = createMemoryRelayService({
    requireSignatures: false,
    githubWebhookSecret: secret,
  } as any);

  try {
    const payload = createIssueEventPayload('closed');
    const bodyText = JSON.stringify(payload);
    const signature = await signGitHubWebhook(secret, bodyText);

    const hookRes = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'd-1',
          'x-hub-signature-256': signature,
        },
        body: bodyText,
      }),
    );
    assertEquals(hookRes.status, 200);
    const hookBody = await hookRes.json();
    assertObjectMatch(hookBody, {
      ok: true,
      accepted: true,
      duplicate: false,
      delivery_id: 'd-1',
      event: 'issues',
      topic: 'issue.closed',
      room: 'acme-api',
    });

    const pollRes = await service.fetch(
      new Request('http://relay.local/api/v1/poll?room=acme-api&after=0&limit=10'),
    );
    assertEquals(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assertEquals(pollBody.envelopes.length, 1);
    assertObjectMatch(pollBody.envelopes[0], {
      topic: 'issue.closed',
      payload: {
        source: 'github',
        delivery_id: 'd-1',
        event: 'issues',
        action: 'closed',
        issue_id: 'acme/api#42',
      },
    });
  } finally {
    service.close();
  }
});

Deno.test('github webhook rejects invalid signature', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
    githubWebhookSecret: 'hook-secret',
  } as any);

  try {
    const bodyText = JSON.stringify(createIssueEventPayload('opened'));
    const res = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'd-2',
          'x-hub-signature-256': 'sha256=deadbeef',
        },
        body: bodyText,
      }),
    );
    assertEquals(res.status, 401);
    const body = await res.json();
    assertObjectMatch(body, { ok: false, error: 'invalid github webhook signature' });
  } finally {
    service.close();
  }
});

Deno.test('github webhook deduplicates same delivery id', async () => {
  const secret = 'hook-secret';
  const service = createMemoryRelayService({
    requireSignatures: false,
    githubWebhookSecret: secret,
  } as any);

  try {
    const payload = createIssueEventPayload('edited');
    const bodyText = JSON.stringify(payload);
    const signature = await signGitHubWebhook(secret, bodyText);

    const first = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'd-3',
          'x-hub-signature-256': signature,
        },
        body: bodyText,
      }),
    );
    assertEquals(first.status, 200);
    const firstBody = await first.json();
    assertObjectMatch(firstBody, { accepted: true, duplicate: false });

    const second = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'd-3',
          'x-hub-signature-256': signature,
        },
        body: bodyText,
      }),
    );
    assertEquals(second.status, 200);
    const secondBody = await second.json();
    assertObjectMatch(secondBody, { accepted: false, duplicate: true, delivery_id: 'd-3' });

    const pollRes = await service.fetch(
      new Request('http://relay.local/api/v1/poll?room=acme-api&after=0&limit=10'),
    );
    assertEquals(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assertEquals(pollBody.envelopes.length, 1);
  } finally {
    service.close();
  }
});

Deno.test('github webhook is accepted without bearer auth when signature is valid', async () => {
  const secret = 'hook-secret';
  const service = createMemoryRelayService({
    authToken: 'relay-admin-token',
    requireSignatures: false,
    githubWebhookSecret: secret,
  } as any);

  try {
    const payload = createIssueEventPayload('opened');
    const bodyText = JSON.stringify(payload);
    const signature = await signGitHubWebhook(secret, bodyText);
    const res = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'd-4',
          'x-hub-signature-256': signature,
        },
        body: bodyText,
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertObjectMatch(body, {
      ok: true,
      accepted: true,
      delivery_id: 'd-4',
      topic: 'issue',
    });
  } finally {
    service.close();
  }
});

Deno.test('github webhook keeps latest issue snapshot under out-of-order delivery', async () => {
  const secret = 'hook-secret';
  const service = createMemoryRelayService({
    requireSignatures: false,
    cacheStore: createMemoryCacheStore(),
    githubWebhookSecret: secret,
  } as any);

  try {
    const reopenedPayload = createIssueEventPayload('reopened');
    (reopenedPayload.issue as Record<string, unknown>).updated_at = '2026-01-03T12:00:00Z';
    const reopenedBody = JSON.stringify(reopenedPayload);
    const reopenedSig = await signGitHubWebhook(secret, reopenedBody);
    const reopenedRes = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'oo-1',
          'x-hub-signature-256': reopenedSig,
        },
        body: reopenedBody,
      }),
    );
    assertEquals(reopenedRes.status, 200);

    const closedPayload = createIssueEventPayload('closed');
    (closedPayload.issue as Record<string, unknown>).updated_at = '2026-01-02T12:00:00Z';
    const closedBody = JSON.stringify(closedPayload);
    const closedSig = await signGitHubWebhook(secret, closedBody);
    const closedRes = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'oo-2',
          'x-hub-signature-256': closedSig,
        },
        body: closedBody,
      }),
    );
    assertEquals(closedRes.status, 200);

    const syncRes = await service.fetch(
      new Request('http://relay.local/api/v1/cache/issues/sync?room=acme-api&after=0&limit=10'),
    );
    assertEquals(syncRes.status, 200);
    const sync = await syncRes.json() as {
      events: Array<Record<string, unknown>>;
      snapshots: Array<Record<string, unknown>>;
      room_cursor: number;
    };
    assertEquals(sync.room_cursor, 2);
    assertEquals(sync.events.length, 2);
    assertEquals(sync.snapshots.length, 1);
    assertObjectMatch(sync.snapshots[0], {
      issue_id: 'acme/api#42',
      envelope: {
        topic: 'issue.reopened',
      },
    });
  } finally {
    service.close();
  }
});

Deno.test('github webhook stores failed deliveries in DLQ and supports retry endpoint', async () => {
  const secret = 'hook-secret';
  const service = createMemoryRelayService({
    requireSignatures: false,
    githubWebhookSecret: secret,
  } as any);

  try {
    const unsupportedPayload = JSON.stringify({ action: 'created' });
    const unsupportedSig = await signGitHubWebhook(secret, unsupportedPayload);
    const hookRes = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'fork',
          'x-github-delivery': 'dlq-1',
          'x-hub-signature-256': unsupportedSig,
        },
        body: unsupportedPayload,
      }),
    );
    assertEquals(hookRes.status, 202);
    const hookBody = await hookRes.json();
    assertObjectMatch(hookBody, {
      ok: false,
      queued: true,
      delivery_id: 'dlq-1',
    });

    const listRes = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook/dlq?after=0&limit=10'),
    );
    assertEquals(listRes.status, 200);
    const listBody = await listRes.json() as {
      entries: Array<Record<string, unknown>>;
    };
    assertEquals(listBody.entries.length, 1);
    assertObjectMatch(listBody.entries[0], {
      delivery_id: 'dlq-1',
      event: 'fork',
      retry_count: 0,
    });

    const retryRes = await service.fetch(
      new Request('http://relay.local/api/v1/github/webhook/dlq/retry?delivery_id=dlq-1', {
        method: 'POST',
      }),
    );
    assertEquals(retryRes.status, 200);
    const retryBody = await retryRes.json();
    assertObjectMatch(retryBody, {
      ok: true,
      queued: true,
      accepted: false,
      delivery_id: 'dlq-1',
      retry_count: 1,
    });
  } finally {
    service.close();
  }
});
