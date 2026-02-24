import type {
  AuthContext,
  JsonValue,
  RelayTarget,
  RelayTargetRequest,
  RelayTargetResult,
} from './contracts.ts';
import { createGitHubTransport } from './github_transport.ts';

export interface GitHubRelayTargetOptions {
  repo: string;
  token?: string | null;
  fetchFn?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

interface PushPayload {
  branch: string;
  sha: string;
  force: boolean;
}

interface RepositoryDispatchPayload {
  kind: 'repository_dispatch';
  event_type: string;
  client_payload?: JsonValue;
}

interface WorkflowDispatchPayload {
  kind: 'workflow_dispatch';
  workflow_id: string;
  ref: string;
  inputs?: JsonValue;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hasScope(auth: AuthContext, scope: string): boolean {
  if (auth.role === 'relay_admin') return true;
  return auth.scopes.includes(scope);
}

function unauthorizedResult(
  operation: RelayTargetRequest['operation'],
  message: string,
): RelayTargetResult {
  return {
    ok: false,
    operation,
    status: 403,
    message,
  };
}

function missingTokenResult(operation: RelayTargetRequest['operation']): RelayTargetResult {
  return {
    ok: false,
    operation,
    status: 503,
    message: 'github token is not configured',
  };
}

function invalidPayloadResult(
  operation: RelayTargetRequest['operation'],
  message: string,
): RelayTargetResult {
  return {
    ok: false,
    operation,
    status: 400,
    message,
  };
}

function parsePushPayload(payload: JsonValue | undefined): PushPayload | null {
  const body = asObject(payload);
  if (!body) return null;
  const branch = asString(body.branch);
  const sha = asString(body.sha);
  if (!branch || !sha) return null;
  return {
    branch,
    sha,
    force: typeof body.force === 'boolean' ? body.force : false,
  };
}

function parseNotifyPayload(
  payload: JsonValue | undefined,
): RepositoryDispatchPayload | WorkflowDispatchPayload | null {
  const body = asObject(payload);
  if (!body) return null;
  const kind = asString(body.kind);
  if (kind === 'repository_dispatch') {
    const eventType = asString(body.event_type);
    if (!eventType) return null;
    return {
      kind: 'repository_dispatch',
      event_type: eventType,
      client_payload: body.client_payload as JsonValue | undefined,
    };
  }
  if (kind === 'workflow_dispatch') {
    const workflowId = asString(body.workflow_id);
    const ref = asString(body.ref);
    if (!workflowId || !ref) return null;
    return {
      kind: 'workflow_dispatch',
      workflow_id: workflowId,
      ref,
      inputs: body.inputs as JsonValue | undefined,
    };
  }
  return null;
}

async function toResponseData(response: Response): Promise<JsonValue | undefined> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return { body: text };
  }
}

export function createGitHubRelayTarget(options: GitHubRelayTargetOptions): RelayTarget {
  const repo = options.repo;
  const token = options.token ?? null;
  const transport = token
    ? createGitHubTransport({
      token,
      apiBaseUrl: options.apiBaseUrl,
      fetchFn: options.fetchFn,
      maxRetries: options.maxRetries,
      retryDelayMs: options.retryDelayMs,
      sleepFn: options.sleepFn,
    })
    : null;

  return {
    kind: 'github_repository',
    async execute(request: RelayTargetRequest): Promise<RelayTargetResult> {
      if (request.operation === 'clone' || request.operation === 'fetch') {
        return {
          ok: true,
          operation: request.operation,
          status: 200,
          data: {
            repo,
            remote_url: `https://github.com/${repo}.git`,
          },
        };
      }

      if (request.operation === 'push') {
        if (request.auth.role === 'anonymous' || !hasScope(request.auth, 'github.repo.write')) {
          return unauthorizedResult('push', 'github push requires admin permissions');
        }
        if (!transport) return missingTokenResult('push');
        const payload = parsePushPayload(request.payload);
        if (!payload) return invalidPayloadResult('push', 'invalid push payload');

        const response = await transport.updateRef({
          repo,
          branch: payload.branch,
          sha: payload.sha,
          force: payload.force,
        });
        const data = await toResponseData(response);
        return {
          ok: response.ok,
          operation: 'push',
          status: response.status,
          message: response.ok ? undefined : `github push failed (${response.status})`,
          data,
        };
      }

      if (request.operation === 'notify') {
        if (
          request.auth.role === 'anonymous' || !hasScope(request.auth, 'github.actions.dispatch')
        ) {
          return unauthorizedResult('notify', 'github dispatch requires admin permissions');
        }
        if (!transport) return missingTokenResult('notify');
        const payload = parseNotifyPayload(request.payload);
        if (!payload) return invalidPayloadResult('notify', 'invalid notify payload');

        const response = payload.kind === 'repository_dispatch'
          ? await transport.repositoryDispatch({
            repo,
            eventType: payload.event_type,
            clientPayload: payload.client_payload,
          })
          : await transport.workflowDispatch({
            repo,
            workflowId: payload.workflow_id,
            ref: payload.ref,
            inputs: payload.inputs,
          });

        const data = await toResponseData(response);
        return {
          ok: response.ok,
          operation: 'notify',
          status: response.status,
          message: response.ok ? undefined : `github notify failed (${response.status})`,
          data,
        };
      }

      return {
        ok: false,
        operation: request.operation,
        status: 400,
        message: `unsupported operation: ${request.operation}`,
      };
    },
  };
}
