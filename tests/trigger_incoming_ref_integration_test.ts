import { assertEquals } from '@std/assert';
import { createGitServeSession } from '../src/git_serve_session.ts';
import { createWebhookTriggerDispatcher } from '../src/trigger_dispatcher.ts';

async function registerSession(
  session: ReturnType<typeof createGitServeSession>,
): Promise<string> {
  const res = await session.fetch(new Request('http://do/register', { method: 'POST' }));
  const body = await res.json() as { session_token: string };
  return body.session_token;
}

Deno.test('incoming ref from git-receive-pack triggers webhook dispatcher', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const dispatcher = createWebhookTriggerDispatcher({
    webhookUrl: 'https://ci.example/hook',
    fetchFn: async (input, init) => {
      const request = new Request(input as RequestInfo | URL, init);
      const bodyText = await request.text();
      calls.push({
        method: request.method,
        body: JSON.parse(bodyText),
      });
      return new Response('{}', { status: 202 });
    },
  });

  const session = createGitServeSession({
    onIncomingRef(event) {
      void dispatcher.dispatchIncomingRef(event);
    },
    eventSource: 'test',
    eventTarget: 'session:s1',
  });

  try {
    const token = await registerSession(session);

    const gitRequestPromise = session.fetch(
      new Request(`http://do/git/git-receive-pack?session_token=${token}`, {
        method: 'POST',
        body: 'refs/relay/incoming/ci-123\nrefs/heads/main\n',
      }),
    );

    const pollRes = await session.fetch(
      new Request(`http://do/poll?timeout=1&session_token=${token}`),
    );
    assertEquals(pollRes.status, 200);
    const pollBody = await pollRes.json() as {
      requests: Array<{ request_id: string }>;
    };
    assertEquals(pollBody.requests.length, 1);

    const requestId = pollBody.requests[0].request_id;
    const respondRes = await session.fetch(
      new Request(`http://do/respond?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          status: 200,
          headers: { 'content-type': 'application/x-git-receive-pack-result' },
          body_base64: btoa('ok'),
        }),
      }),
    );
    assertEquals(respondRes.status, 200);

    const gitRes = await gitRequestPromise;
    assertEquals(gitRes.status, 200);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, 'POST');
    assertEquals(calls[0].body.event_type, 'relay.incoming_ref');
    assertEquals(calls[0].body.ref, 'refs/relay/incoming/ci-123');
  } finally {
    session.cleanup();
  }
});

Deno.test('non-2xx git-receive-pack response does not trigger webhook dispatcher', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const dispatcher = createWebhookTriggerDispatcher({
    webhookUrl: 'https://ci.example/hook',
    fetchFn: async (input, init) => {
      const request = new Request(input as RequestInfo | URL, init);
      const bodyText = await request.text();
      calls.push({
        method: request.method,
        body: JSON.parse(bodyText),
      });
      return new Response('{}', { status: 202 });
    },
  });

  const session = createGitServeSession({
    onIncomingRef(event) {
      void dispatcher.dispatchIncomingRef(event);
    },
    eventSource: 'test',
    eventTarget: 'session:s1',
  });

  try {
    const token = await registerSession(session);

    const gitRequestPromise = session.fetch(
      new Request(`http://do/git/git-receive-pack?session_token=${token}`, {
        method: 'POST',
        body: 'refs/relay/incoming/ci-denied\nrefs/heads/main\n',
      }),
    );

    const pollRes = await session.fetch(
      new Request(`http://do/poll?timeout=1&session_token=${token}`),
    );
    assertEquals(pollRes.status, 200);
    const pollBody = await pollRes.json() as {
      requests: Array<{ request_id: string }>;
    };
    assertEquals(pollBody.requests.length, 1);

    const requestId = pollBody.requests[0].request_id;
    const respondRes = await session.fetch(
      new Request(`http://do/respond?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          status: 403,
          headers: { 'content-type': 'application/x-git-receive-pack-result' },
          body_base64: btoa('denied'),
        }),
      }),
    );
    assertEquals(respondRes.status, 200);

    const gitRes = await gitRequestPromise;
    assertEquals(gitRes.status, 403);
    assertEquals(calls.length, 0);
  } finally {
    session.cleanup();
  }
});
