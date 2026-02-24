import { assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';

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
