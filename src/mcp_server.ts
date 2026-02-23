import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// --- helpers ---

export type RunFn = (
  cmd: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export async function runCommand(
  cmd: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts?.cwd,
    stdout: 'piped',
    stderr: 'piped',
  });
  const out = await p.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

// --- factory ---

export interface McpServerOptions {
  run?: RunFn;
  fetch?: typeof globalThis.fetch;
}

export function createBitMcpServer(opts: McpServerOptions = {}): McpServer {
  const exec = opts.run ?? runCommand;
  const fetchFn = opts.fetch ?? globalThis.fetch;

  const server = new McpServer({
    name: 'bit',
    version: '0.3.0',
  });

  server.registerTool('add', {
    title: 'Git Add',
    description: 'Stage files for commit (git add)',
    inputSchema: {
      paths: z.array(z.string()).default(['.'])
        .describe('File paths to stage. Defaults to ["."]'),
    },
  }, async ({ paths }) => {
    const add = await exec(['git', 'add', ...paths]);
    if (add.code !== 0) {
      return errorResult(`git add failed:\n${add.stderr}`);
    }
    const status = await exec(['git', 'status', '--short']);
    return textResult(`Staged.\n${status.stdout}`);
  });

  server.registerTool('commit', {
    title: 'Git Commit',
    description: 'Create a git commit with the given message',
    inputSchema: {
      message: z.string().describe('Commit message'),
    },
  }, async ({ message }) => {
    const result = await exec(['git', 'commit', '-m', message]);
    if (result.code !== 0) {
      return errorResult(`git commit failed:\n${result.stderr}`);
    }
    return textResult(result.stdout);
  });

  server.registerTool('issue_list', {
    title: 'Issue List',
    description: 'List issues from a bit-relay server',
    inputSchema: {
      relay_url: z.string().describe('Relay server URL (e.g. http://localhost:8788)'),
      room: z.string().default('main').describe('Room name'),
      auth_token: z.string().optional().describe('Bearer auth token'),
      limit: z.number().default(50).describe('Max number of envelopes'),
    },
  }, async ({ relay_url, room, auth_token, limit }) => {
    const url = new URL('/api/v1/poll', relay_url);
    url.searchParams.set('room', room);
    url.searchParams.set('after', '0');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('topic', 'issue');

    const headers: Record<string, string> = {};
    if (auth_token) {
      headers['Authorization'] = `Bearer ${auth_token}`;
    }

    try {
      const res = await fetchFn(url, { headers });
      if (!res.ok) {
        const body = await res.text();
        return errorResult(`relay responded ${res.status}: ${body}`);
      }
      const data = await res.json();
      const envelopes = (data as { envelopes?: unknown[] }).envelopes ?? [];
      if (envelopes.length === 0) {
        return textResult('No issues found.');
      }
      return textResult(JSON.stringify(envelopes, null, 2));
    } catch (e) {
      return errorResult(`Failed to fetch issues: ${e}`);
    }
  });

  server.registerTool('relay_sync', {
    title: 'Relay Sync',
    description: 'Sync hub metadata with a bit-relay server (bit hub sync)',
    inputSchema: {
      relay_url: z.string().describe('Relay URL (e.g. relay+https://example.com)'),
      direction: z.enum(['fetch', 'push']).describe('Sync direction'),
      auth_token: z.string().optional().describe('Bearer auth token'),
      signing_key: z.string().optional().describe('Ed25519 signing key'),
    },
  }, async ({ relay_url, direction, auth_token, signing_key }) => {
    const cmd = ['bit', 'hub', 'sync', direction, relay_url];
    if (auth_token) cmd.push('--auth-token', auth_token);
    if (signing_key) cmd.push('--signing-key', signing_key);

    const result = await exec(cmd);
    if (result.code !== 0) {
      return errorResult(`bit hub sync ${direction} failed:\n${result.stderr}\n${result.stdout}`);
    }
    return textResult(result.stdout || 'Sync completed.');
  });

  server.registerTool('relay_status', {
    title: 'Relay Status',
    description: 'Check bit-relay server health and status',
    inputSchema: {
      relay_url: z.string().default('http://localhost:8788')
        .describe('Relay server URL'),
    },
  }, async ({ relay_url }) => {
    try {
      const res = await fetchFn(new URL('/health', relay_url));
      const data = await res.json();
      return textResult(JSON.stringify(data, null, 2));
    } catch (e) {
      return errorResult(`Failed to reach relay: ${e}`);
    }
  });

  return server;
}

// --- main ---

if (import.meta.main) {
  const mcpServer = createBitMcpServer();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
