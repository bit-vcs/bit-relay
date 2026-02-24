import { assertEquals } from '@std/assert';
import { createGitHubRelayTarget } from '../src/github_relay_target.ts';
import type { AuthContext } from '../src/contracts.ts';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function adminAuth(): AuthContext {
  return {
    role: 'relay_admin',
    principalId: 'admin',
    scopes: ['relay.admin', 'github.repo.write', 'github.actions.dispatch'],
  };
}

function createFetchStub(status = 200): {
  requests: CapturedRequest[];
  fetchFn: typeof globalThis.fetch;
} {
  const requests: CapturedRequest[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input as RequestInfo | URL, init);
    const bodyText = request.method === 'GET' ? null : await request.text();
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: bodyText ? JSON.parse(bodyText) : null,
    });
    const hasNullBodyStatus = status === 204 || status === 205 || status === 304;
    return hasNullBodyStatus ? new Response(null, { status }) : new Response('{}', { status });
  };
  return { requests, fetchFn };
}

Deno.test('github relay target clone returns remote url', async () => {
  const { fetchFn } = createFetchStub();
  const target = createGitHubRelayTarget({
    repo: 'bit-vcs/bit-relay',
    token: 'ghs_xxx',
    fetchFn,
  });

  const result = await target.execute({
    operation: 'clone',
    repo: 'bit-vcs/bit-relay',
    auth: {
      role: 'anonymous',
      principalId: null,
      scopes: [],
    },
  });

  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(
    (result.data as { remote_url: string }).remote_url,
    'https://github.com/bit-vcs/bit-relay.git',
  );
});

Deno.test('github relay target push rejects anonymous auth', async () => {
  const { fetchFn, requests } = createFetchStub();
  const target = createGitHubRelayTarget({
    repo: 'bit-vcs/bit-relay',
    token: 'ghs_xxx',
    fetchFn,
  });

  const result = await target.execute({
    operation: 'push',
    repo: 'bit-vcs/bit-relay',
    payload: { branch: 'main', sha: 'abc123' },
    auth: {
      role: 'anonymous',
      principalId: null,
      scopes: [],
    },
  });

  assertEquals(result.ok, false);
  assertEquals(result.status, 403);
  assertEquals(requests.length, 0);
});

Deno.test('github relay target push calls refs update API', async () => {
  const { fetchFn, requests } = createFetchStub(200);
  const target = createGitHubRelayTarget({
    repo: 'bit-vcs/bit-relay',
    token: 'ghs_xxx',
    fetchFn,
  });

  const result = await target.execute({
    operation: 'push',
    repo: 'bit-vcs/bit-relay',
    payload: { branch: 'feature/test', sha: 'deadbeef', force: true },
    auth: adminAuth(),
  });

  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(requests.length, 1);
  assertEquals(
    requests[0].url,
    'https://api.github.com/repos/bit-vcs/bit-relay/git/refs/heads%2Ffeature%2Ftest',
  );
  assertEquals(requests[0].method, 'PATCH');
  assertEquals((requests[0].body as Record<string, unknown>).sha, 'deadbeef');
  assertEquals((requests[0].body as Record<string, unknown>).force, true);
  assertEquals(requests[0].headers.get('authorization'), 'Bearer ghs_xxx');
});

Deno.test('github relay target notify supports repository_dispatch', async () => {
  const { fetchFn, requests } = createFetchStub(204);
  const target = createGitHubRelayTarget({
    repo: 'bit-vcs/bit-relay',
    token: 'ghs_xxx',
    fetchFn,
  });

  const result = await target.execute({
    operation: 'notify',
    repo: 'bit-vcs/bit-relay',
    payload: {
      kind: 'repository_dispatch',
      event_type: 'relay.incoming_ref',
      client_payload: { ref: 'refs/relay/incoming/ci-1' },
    },
    auth: adminAuth(),
  });

  assertEquals(result.ok, true);
  assertEquals(result.status, 204);
  assertEquals(requests.length, 1);
  assertEquals(requests[0].url, 'https://api.github.com/repos/bit-vcs/bit-relay/dispatches');
  assertEquals(requests[0].method, 'POST');
  assertEquals((requests[0].body as Record<string, unknown>).event_type, 'relay.incoming_ref');
});

Deno.test('github relay target notify supports workflow_dispatch', async () => {
  const { fetchFn, requests } = createFetchStub(204);
  const target = createGitHubRelayTarget({
    repo: 'bit-vcs/bit-relay',
    token: 'ghs_xxx',
    fetchFn,
  });

  const result = await target.execute({
    operation: 'notify',
    repo: 'bit-vcs/bit-relay',
    payload: {
      kind: 'workflow_dispatch',
      workflow_id: 'ci.yml',
      ref: 'main',
      inputs: { reason: 'incoming-ref' },
    },
    auth: adminAuth(),
  });

  assertEquals(result.ok, true);
  assertEquals(result.status, 204);
  assertEquals(requests.length, 1);
  assertEquals(
    requests[0].url,
    'https://api.github.com/repos/bit-vcs/bit-relay/actions/workflows/ci.yml/dispatches',
  );
  assertEquals(requests[0].method, 'POST');
  assertEquals((requests[0].body as Record<string, unknown>).ref, 'main');
});

Deno.test('github relay target push retries once on 429 and then succeeds', async () => {
  const statuses = [429, 200];
  const requests: Array<{ url: string; method: string }> = [];
  const target = createGitHubRelayTarget({
    repo: 'bit-vcs/bit-relay',
    token: 'ghs_xxx',
    maxRetries: 2,
    fetchFn: async (input, init) => {
      const req = new Request(input as RequestInfo | URL, init);
      requests.push({ url: req.url, method: req.method });
      const status = statuses.shift() ?? 200;
      return new Response('{}', { status });
    },
  });

  const result = await target.execute({
    operation: 'push',
    repo: 'bit-vcs/bit-relay',
    payload: { branch: 'main', sha: 'deadbeef', force: false },
    auth: adminAuth(),
  });

  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(requests.length, 2);
});

Deno.test('github relay target notify does not retry on 422', async () => {
  let called = 0;
  const target = createGitHubRelayTarget({
    repo: 'bit-vcs/bit-relay',
    token: 'ghs_xxx',
    maxRetries: 3,
    fetchFn: async () => {
      called += 1;
      return new Response('{"error":"invalid"}', { status: 422 });
    },
  });

  const result = await target.execute({
    operation: 'notify',
    repo: 'bit-vcs/bit-relay',
    payload: {
      kind: 'repository_dispatch',
      event_type: 'relay.incoming_ref',
      client_payload: { ref: 'refs/relay/incoming/ci-1' },
    },
    auth: adminAuth(),
  });

  assertEquals(result.ok, false);
  assertEquals(result.status, 422);
  assertEquals(called, 1);
});
