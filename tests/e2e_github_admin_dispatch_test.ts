import { assertEquals } from '@std/assert';
import { createAdminGitHubApi } from '../src/admin_github_api.ts';

interface MockCall {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

function withAdminAuth(path: string, body: unknown): Request {
  return new Request(`http://relay.local${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer relay-admin',
    },
    body: JSON.stringify(body),
  });
}

function startGitHubMock(): {
  baseUrl: string;
  calls: MockCall[];
  shutdown: () => Promise<void>;
} {
  const calls: MockCall[] = [];
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, async (request) => {
    const url = new URL(request.url);
    const text = await request.text();
    calls.push({
      method: request.method,
      path: url.pathname,
      auth: request.headers.get('authorization'),
      body: text.length > 0 ? JSON.parse(text) : null,
    });

    if (
      request.method === 'PATCH' &&
      (url.pathname.includes('/git/refs/heads/main') ||
        url.pathname.includes('/git/refs/heads%2Fmain'))
    ) {
      return new Response('{}', { status: 200 });
    }
    if (request.method === 'POST' && url.pathname.endsWith('/dispatches')) {
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 404 });
  });

  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    calls,
    async shutdown() {
      await server.shutdown();
    },
  };
}

Deno.test('e2e: admin api register -> push -> dispatch against github mock', async () => {
  const mock = startGitHubMock();
  try {
    const api = createAdminGitHubApi({
      adminToken: 'relay-admin',
      apiBaseUrl: mock.baseUrl,
      fetchFn: fetch,
    });

    const register = await api.handle(
      withAdminAuth('/api/v1/admin/github/repos/register', {
        id: 'origin',
        repo: 'bit-vcs/bit-relay',
        token: 'ghs_origin',
      }),
    );
    assertEquals(register?.status, 200);

    const push = await api.handle(
      withAdminAuth('/api/v1/admin/github/repos/origin/push', {
        branch: 'main',
        sha: 'deadbeef',
        force: true,
      }),
    );
    assertEquals(push?.status, 200);

    const dispatch = await api.handle(
      withAdminAuth('/api/v1/admin/github/repos/origin/actions/dispatch', {
        kind: 'repository_dispatch',
        event_type: 'relay.incoming_ref',
        client_payload: { ref: 'refs/relay/incoming/ci-1' },
      }),
    );
    assertEquals(dispatch?.status, 204);

    assertEquals(mock.calls.length, 2);
    assertEquals(mock.calls[0].method, 'PATCH');
    assertEquals(mock.calls[0].auth, 'Bearer ghs_origin');
    assertEquals((mock.calls[0].body as Record<string, unknown>).sha, 'deadbeef');
    assertEquals(mock.calls[1].method, 'POST');
    assertEquals((mock.calls[1].body as Record<string, unknown>).event_type, 'relay.incoming_ref');
  } finally {
    await mock.shutdown();
  }
});
