import { assertEquals } from '@std/assert';
import { createGitHubTransport } from '../src/github_transport.ts';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function createFetchStub(statuses: number[]): {
  requests: CapturedRequest[];
  fetchFn: typeof globalThis.fetch;
} {
  const requests: CapturedRequest[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input as RequestInfo | URL, init);
    const text = request.method === 'GET' ? null : await request.text();
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: text ? JSON.parse(text) : null,
    });
    const status = statuses.length > 0 ? statuses.shift()! : 200;
    const hasNullBodyStatus = status === 204 || status === 205 || status === 304;
    return hasNullBodyStatus ? new Response(null, { status }) : new Response('{}', { status });
  };
  return { requests, fetchFn };
}

Deno.test('github transport updateRef sends PATCH request', async () => {
  const { requests, fetchFn } = createFetchStub([200]);
  const transport = createGitHubTransport({
    token: 'ghs_test',
    apiBaseUrl: 'https://api.github.com',
    fetchFn,
    maxRetries: 0,
  });

  const response = await transport.updateRef({
    repo: 'bit-vcs/bit-relay',
    branch: 'main',
    sha: 'deadbeef',
    force: false,
  });

  assertEquals(response.status, 200);
  assertEquals(requests.length, 1);
  assertEquals(requests[0].method, 'PATCH');
  assertEquals(
    requests[0].url,
    'https://api.github.com/repos/bit-vcs/bit-relay/git/refs/heads%2Fmain',
  );
  assertEquals((requests[0].body as Record<string, unknown>).sha, 'deadbeef');
  assertEquals(requests[0].headers.get('authorization'), 'Bearer ghs_test');
});

Deno.test('github transport repositoryDispatch retries on 503', async () => {
  const { requests, fetchFn } = createFetchStub([503, 204]);
  const transport = createGitHubTransport({
    token: 'ghs_test',
    apiBaseUrl: 'https://api.github.com',
    fetchFn,
    maxRetries: 2,
    retryDelayMs: 0,
  });

  const response = await transport.repositoryDispatch({
    repo: 'bit-vcs/bit-relay',
    eventType: 'relay.incoming_ref',
    clientPayload: { ref: 'refs/relay/incoming/ci-1' },
  });

  assertEquals(response.status, 204);
  assertEquals(requests.length, 2);
  assertEquals(requests[0].method, 'POST');
  assertEquals(requests[1].method, 'POST');
});

Deno.test('github transport workflowDispatch does not retry on 422', async () => {
  const { requests, fetchFn } = createFetchStub([422]);
  const transport = createGitHubTransport({
    token: 'ghs_test',
    apiBaseUrl: 'https://api.github.com',
    fetchFn,
    maxRetries: 3,
    retryDelayMs: 0,
  });

  const response = await transport.workflowDispatch({
    repo: 'bit-vcs/bit-relay',
    workflowId: 'ci.yml',
    ref: 'main',
    inputs: { reason: 'test' },
  });

  assertEquals(response.status, 422);
  assertEquals(requests.length, 1);
});
