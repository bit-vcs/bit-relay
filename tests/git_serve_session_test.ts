import { assert, assertEquals, assertObjectMatch } from '@std/assert';
import { createGitServeSession, DEFAULT_SESSION_TTL_MS } from '../src/git_serve_session.ts';

async function registerSession(
  session: ReturnType<typeof createGitServeSession>,
): Promise<string> {
  const res = await session.fetch(new Request('http://do/register', { method: 'POST' }));
  const body = await res.json();
  return body.session_token;
}

Deno.test('register activates session', async () => {
  const session = createGitServeSession();
  try {
    const res = await session.fetch(new Request('http://do/register', { method: 'POST' }));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(typeof body.session_token, 'string');
    assertEquals(session.state.active, true);
  } finally {
    session.cleanup();
  }
});

Deno.test('info returns session state', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);
    const res = await session.fetch(
      new Request(`http://do/info?session_token=${token}`),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertObjectMatch(body, {
      ok: true,
      active: true,
      pending_requests: 0,
      poll_waiters: 0,
    });
  } finally {
    session.cleanup();
  }
});

Deno.test('git request without active session returns 404', async () => {
  const session = createGitServeSession();
  try {
    const res = await session.fetch(
      new Request('http://do/git/info/refs?service=git-upload-pack'),
    );
    assertEquals(res.status, 404);
    assertObjectMatch(await res.json(), { ok: false, error: 'session not active' });
  } finally {
    session.cleanup();
  }
});

Deno.test('poll without active session returns 404', async () => {
  const session = createGitServeSession();
  try {
    const res = await session.fetch(new Request('http://do/poll?timeout=1'));
    assertEquals(res.status, 404);
    assertObjectMatch(await res.json(), { ok: false, error: 'session not active' });
  } finally {
    session.cleanup();
  }
});

Deno.test('full flow: git request → poll → respond', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);

    // Start a git request (clone side) — will block until responded
    const gitRequestPromise = session.fetch(
      new Request(`http://do/git/info/refs?service=git-upload-pack&session_token=${token}`),
    );

    // Give the event loop a tick for the request to be queued
    await new Promise((r) => setTimeout(r, 10));

    // Poll (serve side) — should get the queued request
    const pollRes = await session.fetch(
      new Request(`http://do/poll?timeout=1&session_token=${token}`),
    );
    assertEquals(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assertEquals(pollBody.ok, true);
    assertEquals(pollBody.requests.length, 1);
    assertEquals(pollBody.requests[0].method, 'GET');
    assertEquals(pollBody.requests[0].path, '/info/refs?service=git-upload-pack');

    const requestId = pollBody.requests[0].request_id;

    // Respond (serve side)
    const fakeRefsBody = '001e# service=git-upload-pack\n';
    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(fakeRefsBody);
    let binary = '';
    for (let i = 0; i < bodyBytes.length; i++) {
      binary += String.fromCharCode(bodyBytes[i]);
    }
    const bodyBase64 = btoa(binary);

    const respondRes = await session.fetch(
      new Request(`http://do/respond?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          body_base64: bodyBase64,
        }),
      }),
    );
    assertEquals(respondRes.status, 200);
    assertObjectMatch(await respondRes.json(), { ok: true });

    // The clone side request should now resolve
    const gitRes = await gitRequestPromise;
    assertEquals(gitRes.status, 200);
    assertEquals(
      gitRes.headers.get('content-type'),
      'application/x-git-upload-pack-advertisement',
    );
    const gitBody = await gitRes.text();
    assertEquals(gitBody, fakeRefsBody);
  } finally {
    session.cleanup();
  }
});

Deno.test('poll returns empty on timeout when no requests', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);

    const pollRes = await session.fetch(
      new Request(`http://do/poll?timeout=1&session_token=${token}`),
    );
    assertEquals(pollRes.status, 200);
    const body = await pollRes.json();
    assertEquals(body.ok, true);
    assertEquals(body.requests.length, 0);
  } finally {
    session.cleanup();
  }
});

Deno.test('respond with invalid request_id returns 404', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);

    const res = await session.fetch(
      new Request(`http://do/respond?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: 'nonexistent',
          status: 200,
          headers: {},
          body_base64: null,
        }),
      }),
    );
    assertEquals(res.status, 404);
    assertObjectMatch(await res.json(), {
      ok: false,
      error: 'request not found or already resolved',
    });
  } finally {
    session.cleanup();
  }
});

Deno.test('respond with missing request_id returns 400', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);

    const res = await session.fetch(
      new Request(`http://do/respond?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 200,
          headers: {},
        }),
      }),
    );
    assertEquals(res.status, 400);
    assertObjectMatch(await res.json(), { ok: false, error: 'missing request_id' });
  } finally {
    session.cleanup();
  }
});

Deno.test('POST git request carries body', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);

    const requestBody = 'some-pack-data';
    const gitRequestPromise = session.fetch(
      new Request(`http://do/git/git-upload-pack?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-upload-pack-request' },
        body: requestBody,
      }),
    );

    await new Promise((r) => setTimeout(r, 10));

    const pollRes = await session.fetch(
      new Request(`http://do/poll?timeout=1&session_token=${token}`),
    );
    const pollBody = await pollRes.json();
    assertEquals(pollBody.requests.length, 1);
    assertEquals(pollBody.requests[0].method, 'POST');
    assertEquals(pollBody.requests[0].path, '/git-upload-pack');

    // Decode the body
    const bodyBase64 = pollBody.requests[0].body_base64;
    const decoded = atob(bodyBase64);
    assertEquals(decoded, requestBody);

    const requestId = pollBody.requests[0].request_id;

    // Respond to unblock
    const responseData = 'pack-response-data';
    const encoder = new TextEncoder();
    const respBytes = encoder.encode(responseData);
    let binary = '';
    for (let i = 0; i < respBytes.length; i++) {
      binary += String.fromCharCode(respBytes[i]);
    }

    await session.fetch(
      new Request(`http://do/respond?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
          body_base64: btoa(binary),
        }),
      }),
    );

    const gitRes = await gitRequestPromise;
    assertEquals(gitRes.status, 200);
    assertEquals(await gitRes.text(), responseData);
  } finally {
    session.cleanup();
  }
});

Deno.test('git-receive-pack request exposes incoming_refs in poll response', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);
    const requestBody = [
      '0000',
      'refs/heads/main',
      'refs/relay/incoming/ci-123',
      'refs/relay/incoming/review/42',
    ].join('\n');

    const gitRequestPromise = session.fetch(
      new Request(`http://do/git/git-receive-pack?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-receive-pack-request' },
        body: requestBody,
      }),
    );

    await new Promise((r) => setTimeout(r, 10));

    const pollRes = await session.fetch(
      new Request(`http://do/poll?timeout=1&session_token=${token}`),
    );
    const pollBody = await pollRes.json();
    assertEquals(pollBody.requests.length, 1);
    assertEquals(pollBody.requests[0].path, '/git-receive-pack');
    assertEquals(pollBody.requests[0].incoming_refs, [
      'refs/relay/incoming/ci-123',
      'refs/relay/incoming/review/42',
    ]);

    await session.fetch(
      new Request(`http://do/respond?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: pollBody.requests[0].request_id,
          status: 200,
          headers: {},
        }),
      }),
    );

    const gitRes = await gitRequestPromise;
    assertEquals(gitRes.status, 200);
  } finally {
    session.cleanup();
  }
});

Deno.test('git-receive-pack can emit incoming_ref events via callback', async () => {
  const seenRefs: string[] = [];
  const session = createGitServeSession({
    onIncomingRef(event) {
      seenRefs.push(event.ref);
    },
  });

  try {
    const token = await registerSession(session);

    const pending = session.fetch(
      new Request(`http://do/git/git-receive-pack?session_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-receive-pack-request' },
        body: 'refs/relay/incoming/ci-999\nrefs/relay/incoming/ci-999',
      }),
    );

    await new Promise((r) => setTimeout(r, 10));
    session.cleanup();
    await pending;

    assertEquals(seenRefs, ['refs/relay/incoming/ci-999']);
  } finally {
    session.cleanup();
  }
});

Deno.test('cleanup resolves pending requests with 410', async () => {
  const session = createGitServeSession();
  const token = await registerSession(session);

  const gitRequestPromise = session.fetch(
    new Request(`http://do/git/info/refs?service=git-upload-pack&session_token=${token}`),
  );

  await new Promise((r) => setTimeout(r, 10));

  // Cleanup should resolve the pending request
  session.cleanup();

  const res = await gitRequestPromise;
  assertEquals(res.status, 410);
  assertObjectMatch(await res.json(), { ok: false, error: 'session closed' });
});

Deno.test('unknown route returns 404', async () => {
  const session = createGitServeSession();
  try {
    const res = await session.fetch(new Request('http://do/unknown'));
    assertEquals(res.status, 404);
  } finally {
    session.cleanup();
  }
});

// --- session_token tests ---

Deno.test('register returns session_token', async () => {
  const session = createGitServeSession();
  try {
    const res = await session.fetch(new Request('http://do/register', { method: 'POST' }));
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(typeof body.session_token, 'string');
    assert(body.session_token.length >= 16, 'token should be at least 16 chars');
  } finally {
    session.cleanup();
  }
});

Deno.test('poll without session_token returns 403', async () => {
  const session = createGitServeSession();
  try {
    await registerSession(session);
    const res = await session.fetch(new Request('http://do/poll?timeout=1'));
    assertEquals(res.status, 403);
    assertObjectMatch(await res.json(), { ok: false, error: 'invalid session token' });
  } finally {
    session.cleanup();
  }
});

Deno.test('poll with wrong session_token returns 403', async () => {
  const session = createGitServeSession();
  try {
    await registerSession(session);
    const res = await session.fetch(
      new Request('http://do/poll?timeout=1&session_token=wrong'),
    );
    assertEquals(res.status, 403);
    assertObjectMatch(await res.json(), { ok: false, error: 'invalid session token' });
  } finally {
    session.cleanup();
  }
});

Deno.test('poll with valid session_token succeeds', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);

    const res = await session.fetch(
      new Request(`http://do/poll?timeout=1&session_token=${token}`),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
  } finally {
    session.cleanup();
  }
});

Deno.test('session_token via x-session-token header works', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);

    const res = await session.fetch(
      new Request('http://do/poll?timeout=1', {
        headers: { 'x-session-token': token },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).ok, true);
  } finally {
    session.cleanup();
  }
});

Deno.test('git request without session_token is allowed', async () => {
  const session = createGitServeSession();
  try {
    const token = await registerSession(session);
    // git requests don't require session_token (clone clients don't have it)
    // Start a poll to consume the request
    const pollP = session.fetch(
      new Request(`http://do/poll?timeout=2&session_token=${token}`),
    );
    const res = await session.fetch(
      new Request('http://do/git/info/refs?service=git-upload-pack'),
    );
    // The request should be accepted (pending response from serve side)
    // We don't need to fully complete the flow, just verify it's not 403
    assertEquals(res.status !== 403, true);
    await pollP;
  } finally {
    session.cleanup();
  }
});

Deno.test('respond without session_token returns 403', async () => {
  const session = createGitServeSession();
  try {
    await registerSession(session);
    const res = await session.fetch(
      new Request('http://do/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: 'x', status: 200, headers: {} }),
      }),
    );
    assertEquals(res.status, 403);
  } finally {
    session.cleanup();
  }
});

Deno.test('info without session_token returns 403', async () => {
  const session = createGitServeSession();
  try {
    await registerSession(session);
    const res = await session.fetch(new Request('http://do/info'));
    assertEquals(res.status, 403);
  } finally {
    session.cleanup();
  }
});

// --- session TTL tests ---

Deno.test('DEFAULT_SESSION_TTL_MS is 24 hours', () => {
  assertEquals(DEFAULT_SESSION_TTL_MS, 24 * 60 * 60 * 1000);
});

Deno.test('session expires after custom TTL', async () => {
  const session = createGitServeSession({ sessionTtlMs: 100 });
  try {
    const token = await registerSession(session);
    assertEquals(session.state.active, true);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 150));

    assertEquals(session.state.active, false);

    // Poll should return 404 (session not active)
    const res = await session.fetch(
      new Request(`http://do/poll?timeout=1&session_token=${token}`),
    );
    assertEquals(res.status, 404);
    assertObjectMatch(await res.json(), { ok: false, error: 'session not active' });
  } finally {
    session.cleanup();
  }
});

Deno.test('session stays active before TTL expires', async () => {
  const session = createGitServeSession({ sessionTtlMs: 500 });
  try {
    const token = await registerSession(session);

    // Wait less than TTL
    await new Promise((r) => setTimeout(r, 50));

    assertEquals(session.state.active, true);

    const res = await session.fetch(
      new Request(`http://do/poll?timeout=1&session_token=${token}`),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).ok, true);
  } finally {
    session.cleanup();
  }
});
