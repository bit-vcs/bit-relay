import type { JsonValue } from './contracts.ts';

export interface GitHubTransportOptions {
  token: string;
  apiBaseUrl?: string;
  fetchFn?: typeof globalThis.fetch;
  maxRetries?: number;
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface UpdateRefRequest {
  repo: string;
  branch: string;
  sha: string;
  force: boolean;
}

export interface RepositoryDispatchRequest {
  repo: string;
  eventType: string;
  clientPayload?: JsonValue;
}

export interface WorkflowDispatchRequest {
  repo: string;
  workflowId: string;
  ref: string;
  inputs?: JsonValue;
}

export interface GitHubTransport {
  updateRef(request: UpdateRefRequest): Promise<Response>;
  repositoryDispatch(request: RepositoryDispatchRequest): Promise<Response>;
  workflowDispatch(request: WorkflowDispatchRequest): Promise<Response>;
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

export function createGitHubTransport(options: GitHubTransportOptions): GitHubTransport {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
  const maxRetries = Math.max(0, options.maxRetries ?? 1);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  const sleepFn = options.sleepFn ?? defaultSleep;

  async function requestWithRetry(args: {
    method: 'POST' | 'PATCH';
    path: string;
    body: Record<string, unknown>;
  }): Promise<Response> {
    let attempt = 0;
    while (true) {
      const response = await fetchFn(new URL(args.path, apiBaseUrl).toString(), {
        method: args.method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(args.body),
      });

      if (!shouldRetry(response.status) || attempt >= maxRetries) {
        return response;
      }
      attempt += 1;
      if (retryDelayMs > 0) {
        await sleepFn(retryDelayMs * attempt);
      }
    }
  }

  return {
    async updateRef(request: UpdateRefRequest): Promise<Response> {
      const ref = encodeURIComponent(`heads/${request.branch}`);
      return requestWithRetry({
        method: 'PATCH',
        path: `/repos/${request.repo}/git/refs/${ref}`,
        body: {
          sha: request.sha,
          force: request.force,
        },
      });
    },

    async repositoryDispatch(request: RepositoryDispatchRequest): Promise<Response> {
      return requestWithRetry({
        method: 'POST',
        path: `/repos/${request.repo}/dispatches`,
        body: {
          event_type: request.eventType,
          client_payload: request.clientPayload,
        },
      });
    },

    async workflowDispatch(request: WorkflowDispatchRequest): Promise<Response> {
      return requestWithRetry({
        method: 'POST',
        path: `/repos/${request.repo}/actions/workflows/${request.workflowId}/dispatches`,
        body: {
          ref: request.ref,
          inputs: request.inputs,
        },
      });
    },
  };
}
