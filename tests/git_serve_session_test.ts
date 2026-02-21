import { assertEquals, assertObjectMatch } from '@std/assert';
import { createGitServeSession } from '../src/git_serve_session.ts';

Deno.test('register activates session', async () => {
  const session = createGitServeSession();
  try {
    const res = await session.fetch(new Request('http://do/register', { method: 'POST' }));
    assertEquals(res.status, 200);
    assertObjectMatch(await res.json(), { ok: true });
    assertEquals(session.state.active, true);
  } finally {
    session.cleanup();
  }
});

Deno.test('info returns session state', async () => {
  const session = createGitServeSession();
  try {
    await session.fetch(new Request('http://do/register', { method: 'POST' }));
    const res = await session.fetch(new Request('http://do/info'));
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
    // Register session
    await session.fetch(new Request('http://do/register', { method: 'POST' }));

    // Start a git request (clone side) — will block until responded
    const gitRequestPromise = session.fetch(
      new Request('http://do/git/info/refs?service=git-upload-pack'),
    );

    // Give the event loop a tick for the request to be queued
    await new Promise((r) => setTimeout(r, 10));

    // Poll (serve side) — should get the queued request
    const pollRes = await session.fetch(new Request('http://do/poll?timeout=1'));
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
      new Request('http://do/respond', {
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
    await session.fetch(new Request('http://do/register', { method: 'POST' }));

    const pollRes = await session.fetch(new Request('http://do/poll?timeout=1'));
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
    await session.fetch(new Request('http://do/register', { method: 'POST' }));

    const res = await session.fetch(
      new Request('http://do/respond', {
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
    assertObjectMatch(await res.json(), { ok: false, error: 'request not found or already resolved' });
  } finally {
    session.cleanup();
  }
});

Deno.test('respond with missing request_id returns 400', async () => {
  const session = createGitServeSession();
  try {
    await session.fetch(new Request('http://do/register', { method: 'POST' }));

    const res = await session.fetch(
      new Request('http://do/respond', {
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
    await session.fetch(new Request('http://do/register', { method: 'POST' }));

    const requestBody = 'some-pack-data';
    const gitRequestPromise = session.fetch(
      new Request('http://do/git/git-upload-pack', {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-upload-pack-request' },
        body: requestBody,
      }),
    );

    await new Promise((r) => setTimeout(r, 10));

    const pollRes = await session.fetch(new Request('http://do/poll?timeout=1'));
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
      new Request('http://do/respond', {
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

Deno.test('cleanup resolves pending requests with 410', async () => {
  const session = createGitServeSession();
  await session.fetch(new Request('http://do/register', { method: 'POST' }));

  const gitRequestPromise = session.fetch(
    new Request('http://do/git/info/refs?service=git-upload-pack'),
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
