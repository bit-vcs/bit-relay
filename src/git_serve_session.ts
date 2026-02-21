interface PendingGitRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64: string | null;
  resolve: (response: Response) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  createdAt: number;
}

interface PollWaiter {
  resolve: (requests: PendingGitRequest[]) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface GitServeSessionState {
  active: boolean;
  pendingRequests: Map<string, PendingGitRequest>;
  pollWaiters: PollWaiter[];
  registeredAt: number | null;
}

const REQUEST_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 60 * 60 * 1000;

function generateRequestId(): string {
  return crypto.randomUUID();
}

function toBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function createGitServeSession(): {
  state: GitServeSessionState;
  fetch: (request: Request) => Promise<Response>;
  cleanup: () => void;
} {
  const state: GitServeSessionState = {
    active: false,
    pendingRequests: new Map(),
    pollWaiters: [],
    registeredAt: null,
  };

  let sessionTimer: ReturnType<typeof setTimeout> | null = null;

  function cleanup(): void {
    if (sessionTimer !== null) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
    for (const req of state.pendingRequests.values()) {
      clearTimeout(req.timeoutId);
      req.resolve(
        Response.json({ ok: false, error: 'session closed' }, { status: 410 }),
      );
    }
    state.pendingRequests.clear();
    for (const waiter of state.pollWaiters) {
      clearTimeout(waiter.timeoutId);
      waiter.resolve([]);
    }
    state.pollWaiters = [];
    state.active = false;
  }

  function resetSessionTimer(): void {
    if (sessionTimer !== null) {
      clearTimeout(sessionTimer);
    }
    sessionTimer = setTimeout(() => {
      cleanup();
    }, SESSION_TTL_MS);
  }

  function handleRegister(): Response {
    state.active = true;
    state.registeredAt = Date.now();
    resetSessionTimer();
    return Response.json({ ok: true });
  }

  function handleInfo(): Response {
    return Response.json({
      ok: true,
      active: state.active,
      pending_requests: state.pendingRequests.size,
      poll_waiters: state.pollWaiters.length,
      registered_at: state.registeredAt,
    });
  }

  function drainPendingToPollWaiters(): void {
    if (state.pollWaiters.length === 0 || state.pendingRequests.size === 0) {
      return;
    }

    const pending = Array.from(state.pendingRequests.values());
    const waiter = state.pollWaiters.shift()!;
    clearTimeout(waiter.timeoutId);
    waiter.resolve(pending);
  }

  async function handleGitRequest(request: Request, gitPath: string): Promise<Response> {
    if (!state.active) {
      return Response.json(
        { ok: false, error: 'session not active' },
        { status: 404 },
      );
    }

    const requestId = generateRequestId();
    let bodyBase64: string | null = null;
    if (request.method === 'POST') {
      const bodyBytes = new Uint8Array(await request.arrayBuffer());
      bodyBase64 = toBase64(bodyBytes);
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        lower === 'content-type' ||
        lower === 'content-encoding' ||
        lower === 'git-protocol' ||
        lower === 'accept'
      ) {
        headers[key] = value;
      }
    }

    const url = new URL(request.url);
    const queryString = url.search;
    const fullPath = gitPath + queryString;

    return new Promise<Response>((resolve) => {
      const timeoutId = setTimeout(() => {
        state.pendingRequests.delete(requestId);
        resolve(
          Response.json(
            { ok: false, error: 'request timeout' },
            { status: 504 },
          ),
        );
      }, REQUEST_TIMEOUT_MS);

      const pending: PendingGitRequest = {
        requestId,
        method: request.method,
        path: fullPath,
        headers,
        bodyBase64,
        resolve,
        timeoutId,
        createdAt: Date.now(),
      };

      state.pendingRequests.set(requestId, pending);
      drainPendingToPollWaiters();
    });
  }

  function handlePoll(request: Request): Promise<Response> {
    if (!state.active) {
      return Promise.resolve(
        Response.json(
          { ok: false, error: 'session not active' },
          { status: 404 },
        ),
      );
    }

    const url = new URL(request.url);
    const timeoutParam = parseInt(url.searchParams.get('timeout') ?? '30', 10);
    const timeoutMs = Math.min(
      Math.max(timeoutParam, 1) * 1000,
      POLL_TIMEOUT_MS,
    );

    if (state.pendingRequests.size > 0) {
      const pending = Array.from(state.pendingRequests.values());
      return Promise.resolve(formatPollResponse(pending));
    }

    return new Promise<Response>((resolve) => {
      const timeoutId = setTimeout(() => {
        const idx = state.pollWaiters.findIndex((w) => w.resolve === resolveWaiter);
        if (idx !== -1) {
          state.pollWaiters.splice(idx, 1);
        }
        resolve(formatPollResponse([]));
      }, timeoutMs);

      const resolveWaiter = (requests: PendingGitRequest[]) => {
        resolve(formatPollResponse(requests));
      };

      state.pollWaiters.push({ resolve: resolveWaiter, timeoutId });
    });
  }

  function formatPollResponse(requests: PendingGitRequest[]): Response {
    return Response.json({
      ok: true,
      requests: requests.map((r) => ({
        request_id: r.requestId,
        method: r.method,
        path: r.path,
        headers: r.headers,
        body_base64: r.bodyBase64,
      })),
    });
  }

  async function handleRespond(request: Request): Promise<Response> {
    if (!state.active) {
      return Response.json(
        { ok: false, error: 'session not active' },
        { status: 404 },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      return Response.json(
        { ok: false, error: 'invalid json' },
        { status: 400 },
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return Response.json(
        { ok: false, error: 'invalid json' },
        { status: 400 },
      );
    }

    const body = parsed as Record<string, unknown>;
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    const status = typeof body.status === 'number' ? body.status : 200;
    const responseHeaders =
      typeof body.headers === 'object' && body.headers !== null && !Array.isArray(body.headers)
        ? (body.headers as Record<string, string>)
        : {};
    const bodyBase64 = typeof body.body_base64 === 'string' ? body.body_base64 : null;

    if (requestId.length === 0) {
      return Response.json(
        { ok: false, error: 'missing request_id' },
        { status: 400 },
      );
    }

    const pending = state.pendingRequests.get(requestId);
    if (!pending) {
      return Response.json(
        { ok: false, error: 'request not found or already resolved' },
        { status: 404 },
      );
    }

    state.pendingRequests.delete(requestId);
    clearTimeout(pending.timeoutId);

    const responseBody: ArrayBuffer | null = bodyBase64
      ? fromBase64(bodyBase64).buffer as ArrayBuffer
      : null;
    const httpHeaders = new Headers();
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (typeof value === 'string') {
        httpHeaders.set(key, value);
      }
    }

    pending.resolve(new Response(responseBody, { status, headers: httpHeaders }));

    return Response.json({ ok: true });
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/register' && request.method === 'POST') {
      return handleRegister();
    }

    if (path === '/info' && request.method === 'GET') {
      return handleInfo();
    }

    if (path === '/poll' && request.method === 'GET') {
      return handlePoll(request);
    }

    if (path === '/respond' && request.method === 'POST') {
      return handleRespond(request);
    }

    const gitMatch = path.match(/^\/git\/(.*)/);
    if (gitMatch) {
      const gitPath = '/' + gitMatch[1];
      return handleGitRequest(request, gitPath);
    }

    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  return { state, fetch, cleanup };
}

export class GitServeSession {
  private session: ReturnType<typeof createGitServeSession>;

  constructor() {
    this.session = createGitServeSession();
  }

  async fetch(request: Request): Promise<Response> {
    return this.session.fetch(request);
  }
}
