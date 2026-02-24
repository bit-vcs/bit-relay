import type { AuthContext, JsonValue, RelayTargetRequest } from './contracts.ts';
import { createGitHubRelayTarget } from './github_relay_target.ts';
import type { RelayAuditLog } from './relay_observability.ts';

interface RegisteredGitHubRepo {
  id: string;
  repo: string;
  token: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AdminGitHubApiOptions {
  adminToken?: string;
  defaultGitHubToken?: string | null;
  fetchFn?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  nowSec?: () => number;
  audit?: (entry: RelayAuditLog) => void;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseBearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await request.text()) as unknown;
    return asObject(parsed);
  } catch {
    return null;
  }
}

function adminAuthContext(): AuthContext {
  return {
    role: 'relay_admin',
    principalId: 'admin',
    scopes: ['relay.admin', 'github.repo.write', 'github.actions.dispatch'],
  };
}

export function createAdminGitHubApi(options: AdminGitHubApiOptions): {
  handle(request: Request): Promise<Response | null>;
} {
  const repos = new Map<string, RegisteredGitHubRepo>();
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const defaultGitHubToken = options.defaultGitHubToken ?? null;
  const audit = options.audit ?? (() => {});

  function unauthorizedResponse(): Response {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  function ensureAuthorized(request: Request): Response | null {
    if (!options.adminToken || options.adminToken.length === 0) {
      return Response.json(
        { ok: false, error: 'admin auth not configured' },
        { status: 503 },
      );
    }
    const providedToken = parseBearerToken(request);
    if (providedToken !== options.adminToken) return unauthorizedResponse();
    return null;
  }

  async function handleRegister(request: Request): Promise<Response> {
    const parsed = await parseJsonBody(request);
    if (!parsed) {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    const repo = asString(parsed.repo);
    if (!repo) {
      return Response.json({ ok: false, error: 'missing field: repo' }, { status: 400 });
    }
    const id = asString(parsed.id) ?? repo;
    const token = asString(parsed.token) ?? defaultGitHubToken;
    const now = nowSec();

    const existing = repos.get(id);
    const createdAt = existing?.createdAt ?? now;
    repos.set(id, {
      id,
      repo,
      token,
      createdAt,
      updatedAt: now,
    });
    audit({
      action: 'admin.github.register',
      occurredAt: now,
      status: 200,
      room: null,
      sender: 'relay-admin',
      target: '/api/v1/admin/github/repos/register',
      id,
      detail: {
        has_token: token !== null,
      },
    });

    return Response.json({
      ok: true,
      target: {
        id,
        kind: 'github_repository',
        repo,
        has_token: token !== null,
        created_at: createdAt,
        updated_at: now,
      },
    });
  }

  async function handlePushOrDispatch(args: {
    request: Request;
    targetId: string;
    operation: 'push' | 'notify';
  }): Promise<Response> {
    const repo = repos.get(args.targetId);
    if (!repo) {
      return Response.json({ ok: false, error: 'target not found' }, { status: 404 });
    }

    const parsed = await parseJsonBody(args.request);
    if (!parsed) {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }

    const target = createGitHubRelayTarget({
      repo: repo.repo,
      token: repo.token,
      fetchFn: options.fetchFn,
      apiBaseUrl: options.apiBaseUrl,
    });
    const relayRequest: RelayTargetRequest = {
      operation: args.operation,
      repo: repo.repo,
      payload: parsed as JsonValue,
      auth: adminAuthContext(),
    };
    const result = await target.execute(relayRequest);
    audit({
      action: args.operation === 'push' ? 'admin.github.push' : 'admin.github.dispatch',
      occurredAt: nowSec(),
      status: result.status,
      room: null,
      sender: 'relay-admin',
      target: args.operation === 'push'
        ? `/api/v1/admin/github/repos/${args.targetId}/push`
        : `/api/v1/admin/github/repos/${args.targetId}/actions/dispatch`,
      id: args.targetId,
      detail: {
        ok: result.ok,
      },
    });
    if (result.status === 204 || result.status === 205 || result.status === 304) {
      return new Response(null, { status: result.status });
    }
    return Response.json(result, { status: result.status });
  }

  async function handleList(): Promise<Response> {
    const items = Array.from(repos.values()).map((repo) => ({
      id: repo.id,
      kind: 'github_repository' as const,
      repo: repo.repo,
      has_token: repo.token !== null,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
    }));
    return Response.json({ ok: true, targets: items });
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/v1/admin/github/')) return null;

    const denied = ensureAuthorized(request);
    if (denied) return denied;

    if (path === '/api/v1/admin/github/repos' && request.method === 'GET') {
      return handleList();
    }

    if (path === '/api/v1/admin/github/repos/register' && request.method === 'POST') {
      return handleRegister(request);
    }

    const pushMatch = path.match(/^\/api\/v1\/admin\/github\/repos\/([^/]+)\/push$/);
    if (pushMatch && request.method === 'POST') {
      return handlePushOrDispatch({
        request,
        targetId: decodeURIComponent(pushMatch[1]),
        operation: 'push',
      });
    }

    const dispatchMatch = path.match(
      /^\/api\/v1\/admin\/github\/repos\/([^/]+)\/actions\/dispatch$/,
    );
    if (dispatchMatch && request.method === 'POST') {
      return handlePushOrDispatch({
        request,
        targetId: decodeURIComponent(dispatchMatch[1]),
        operation: 'notify',
      });
    }

    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  return { handle };
}
