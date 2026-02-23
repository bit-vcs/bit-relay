import { assertEquals } from '@std/assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBitMcpServer, type RunFn } from '../src/mcp_server.ts';
import { createMemoryRelayService } from '../src/memory_handler.ts';

// --- helpers ---

function mockRun(
  table: Record<string, { stdout?: string; stderr?: string; code?: number }>,
): RunFn {
  // deno-lint-ignore require-await
  return async (cmd) => {
    const key = cmd.join(' ');
    for (const [pattern, result] of Object.entries(table)) {
      if (key.startsWith(pattern)) {
        return {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          code: result.code ?? 0,
        };
      }
    }
    return { stdout: '', stderr: `unknown command: ${key}`, code: 1 };
  };
}

async function setupClient(opts: {
  run?: RunFn;
  fetch?: typeof globalThis.fetch;
} = {}): Promise<Client> {
  const server = createBitMcpServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await client.connect(clientTransport);
  return client;
}

// --- tests ---

Deno.test('listTools returns all registered tools', async () => {
  const client = await setupClient({ run: mockRun({}) });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assertEquals(names, ['add', 'commit', 'issue_list', 'relay_status', 'relay_sync']);
  await client.close();
});

Deno.test('add tool stages files and returns status', async () => {
  const client = await setupClient({
    run: mockRun({
      'git add': { stdout: '' },
      'git status': { stdout: 'M  src/main.ts\nA  src/new.ts\n' },
    }),
  });

  const result = await client.callTool({ name: 'add', arguments: { paths: ['src/'] } });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assertEquals(text.includes('Staged.'), true);
  assertEquals(text.includes('src/main.ts'), true);
  assertEquals(result.isError, undefined);
  await client.close();
});

Deno.test('add tool returns error on failure', async () => {
  const client = await setupClient({
    run: mockRun({
      'git add': { stderr: 'fatal: not a git repo', code: 128 },
    }),
  });

  const result = await client.callTool({ name: 'add', arguments: { paths: ['.'] } });
  assertEquals(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assertEquals(text.includes('git add failed'), true);
  await client.close();
});

Deno.test('commit tool creates commit', async () => {
  const client = await setupClient({
    run: mockRun({
      'git commit': { stdout: '[main abc1234] fix: test\n 1 file changed\n' },
    }),
  });

  const result = await client.callTool({
    name: 'commit',
    arguments: { message: 'fix: test' },
  });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assertEquals(text.includes('abc1234'), true);
  assertEquals(result.isError, undefined);
  await client.close();
});

Deno.test('commit tool returns error on failure', async () => {
  const client = await setupClient({
    run: mockRun({
      'git commit': { stderr: 'nothing to commit', code: 1 },
    }),
  });

  const result = await client.callTool({
    name: 'commit',
    arguments: { message: 'empty' },
  });
  assertEquals(result.isError, true);
  await client.close();
});

Deno.test('issue_list fetches from relay', async () => {
  const service = createMemoryRelayService({ requireSignatures: false });
  // Publish an issue
  await service.fetch(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bot&topic=issue&id=i1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bug report', status: 'open' }),
    }),
  );

  const mockFetch: typeof globalThis.fetch = (input, init?) => {
    const req = new Request(input as string | URL, init);
    return service.fetch(req);
  };

  const client = await setupClient({ run: mockRun({}), fetch: mockFetch });
  const result = await client.callTool({
    name: 'issue_list',
    arguments: { relay_url: 'http://relay.local', room: 'main' },
  });

  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assertEquals(text.includes('Bug report'), true);
  assertEquals(result.isError, undefined);
  await client.close();
});

Deno.test('issue_list returns empty message when no issues', async () => {
  const service = createMemoryRelayService({ requireSignatures: false });

  const mockFetch: typeof globalThis.fetch = (input, init?) => {
    const req = new Request(input as string | URL, init);
    return service.fetch(req);
  };

  const client = await setupClient({ run: mockRun({}), fetch: mockFetch });
  const result = await client.callTool({
    name: 'issue_list',
    arguments: { relay_url: 'http://relay.local', room: 'main' },
  });

  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assertEquals(text, 'No issues found.');
  await client.close();
});

Deno.test('relay_sync calls bit hub sync', async () => {
  const calls: string[][] = [];
  // deno-lint-ignore require-await
  const run: RunFn = async (cmd) => {
    calls.push(cmd);
    return { stdout: 'synced 3 records', stderr: '', code: 0 };
  };

  const client = await setupClient({ run });
  const result = await client.callTool({
    name: 'relay_sync',
    arguments: {
      relay_url: 'relay+https://example.com',
      direction: 'fetch',
      auth_token: 'secret',
    },
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0], [
    'bit',
    'hub',
    'sync',
    'fetch',
    'relay+https://example.com',
    '--auth-token',
    'secret',
  ]);

  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assertEquals(text.includes('synced 3 records'), true);
  await client.close();
});

Deno.test('relay_status checks health endpoint', async () => {
  const service = createMemoryRelayService({ requireSignatures: false });

  const mockFetch: typeof globalThis.fetch = (input, init?) => {
    const req = new Request(input as string | URL, init);
    return service.fetch(req);
  };

  const client = await setupClient({ run: mockRun({}), fetch: mockFetch });
  const result = await client.callTool({
    name: 'relay_status',
    arguments: { relay_url: 'http://relay.local' },
  });

  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  const data = JSON.parse(text);
  assertEquals(data.status, 'ok');
  assertEquals(data.service, 'bit-relay');
  await client.close();
});

Deno.test('relay_status returns error when unreachable', async () => {
  const mockFetch: typeof globalThis.fetch = () => {
    throw new Error('connection refused');
  };

  const client = await setupClient({ run: mockRun({}), fetch: mockFetch });
  const result = await client.callTool({
    name: 'relay_status',
    arguments: { relay_url: 'http://unreachable:9999' },
  });

  assertEquals(result.isError, true);
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assertEquals(text.includes('Failed to reach relay'), true);
  await client.close();
});
