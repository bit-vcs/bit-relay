import { assertEquals } from '@std/assert';
import { createAdminGitHubApi } from '../src/admin_github_api.ts';

interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

function createFetchStub(
  status = 200,
): { calls: CapturedCall[]; fetchFn: typeof globalThis.fetch } {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input as RequestInfo | URL, init);
    const bodyText = request.method === 'GET' ? null : await request.text();
    calls.push({
      url: request.url,
      method: request.method,
      body: bodyText ? JSON.parse(bodyText) : null,
      auth: request.headers.get('authorization'),
    });
    const hasNullBodyStatus = status === 204 || status === 205 || status === 304;
    return hasNullBodyStatus ? new Response(null, { status }) : new Response('{}', { status });
  };
  return { calls, fetchFn };
}

function withAuth(path: string, body: unknown, token = 'admin-token'): Request {
  return new Request(`http://relay.local${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

Deno.test('admin github api rejects request without auth', async () => {
  const { fetchFn } = createFetchStub();
  const api = createAdminGitHubApi({
    adminToken: 'admin-token',
    fetchFn,
  });

  const res = await api.handle(
    new Request('http://relay.local/api/v1/admin/github/repos/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'bit-vcs/bit-relay', token: 'ghs_xxx' }),
    }),
  );

  assertEquals(res?.status, 401);
});

Deno.test('admin github api registers target and returns metadata', async () => {
  const { fetchFn } = createFetchStub();
  const api = createAdminGitHubApi({
    adminToken: 'admin-token',
    fetchFn,
  });

  const res = await api.handle(
    withAuth('/api/v1/admin/github/repos/register', {
      id: 'origin',
      repo: 'bit-vcs/bit-relay',
      token: 'ghs_xxx',
    }),
  );
  assertEquals(res?.status, 200);
  const body = await res?.json() as Record<string, unknown>;
  assertEquals(body.ok, true);
  const target = body.target as Record<string, unknown>;
  assertEquals(target.id, 'origin');
  assertEquals(target.repo, 'bit-vcs/bit-relay');
  assertEquals(target.has_token, true);
});

Deno.test('admin github api push calls github refs update for registered target', async () => {
  const { fetchFn, calls } = createFetchStub(200);
  const api = createAdminGitHubApi({
    adminToken: 'admin-token',
    fetchFn,
  });

  await api.handle(
    withAuth('/api/v1/admin/github/repos/register', {
      id: 'origin',
      repo: 'bit-vcs/bit-relay',
      token: 'ghs_origin',
    }),
  );

  const res = await api.handle(
    withAuth('/api/v1/admin/github/repos/origin/push', {
      branch: 'main',
      sha: 'deadbeef',
      force: false,
    }),
  );

  assertEquals(res?.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'PATCH');
  assertEquals(
    calls[0].url,
    'https://api.github.com/repos/bit-vcs/bit-relay/git/refs/heads%2Fmain',
  );
  assertEquals((calls[0].body as Record<string, unknown>).sha, 'deadbeef');
  assertEquals(calls[0].auth, 'Bearer ghs_origin');
});

Deno.test('admin github api dispatch calls github repository dispatch', async () => {
  const { fetchFn, calls } = createFetchStub(204);
  const api = createAdminGitHubApi({
    adminToken: 'admin-token',
    fetchFn,
  });

  await api.handle(
    withAuth('/api/v1/admin/github/repos/register', {
      id: 'origin',
      repo: 'bit-vcs/bit-relay',
      token: 'ghs_origin',
    }),
  );

  const res = await api.handle(
    withAuth('/api/v1/admin/github/repos/origin/actions/dispatch', {
      kind: 'repository_dispatch',
      event_type: 'relay.incoming_ref',
      client_payload: { ref: 'refs/relay/incoming/ci-1' },
    }),
  );

  assertEquals(res?.status, 204);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[0].url, 'https://api.github.com/repos/bit-vcs/bit-relay/dispatches');
  assertEquals((calls[0].body as Record<string, unknown>).event_type, 'relay.incoming_ref');
});
