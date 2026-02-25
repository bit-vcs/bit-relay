import { assertEquals, assertMatch } from '@std/assert';
import { createMemoryRelayService } from '../src/memory_handler.ts';
import { createGitServeSession } from '../src/git_serve_session.ts';
import { parseRelayRuntimeConfigFromEnv } from '../src/runtime_config.ts';
import {
  base64UrlEncode,
  buildPublishSigningMessage,
  canonicalizeJson,
  sha256Hex,
  signEd25519,
} from '../src/signing.ts';

const RANDOM_SESSION_PATTERN = /^[A-Za-z0-9]{6,16}$/;

interface TestSigner {
  publicKey: string;
  privateKey: CryptoKey;
  rawKey: Uint8Array;
}

function envFrom(entries: Record<string, string | undefined>): (key: string) => string | undefined {
  return (key: string) => entries[key];
}

function buildSshEd25519Blob(rawKey: Uint8Array): string {
  const typeStr = new TextEncoder().encode('ssh-ed25519');
  const buf = new Uint8Array(4 + typeStr.length + 4 + rawKey.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, typeStr.length);
  buf.set(typeStr, 4);
  view.setUint32(4 + typeStr.length, rawKey.length);
  buf.set(rawKey, 4 + typeStr.length + 4);
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

function createMockGitHubFetchByUser(
  userKeys: Record<string, Uint8Array[]>,
): typeof globalThis.fetch {
  return (input: string | URL | Request) => {
    const rawUrl = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/^\//, '');
    const username = pathname.endsWith('.keys') ? pathname.slice(0, -5) : '';
    const keys = userKeys[username] ?? [];
    const lines = keys.map((k) => `ssh-ed25519 ${buildSshEd25519Blob(k)} ${username}@host`).join(
      '\n',
    );
    return Promise.resolve(new Response(lines, { status: 200 }));
  };
}

async function createSignerWithRawKey(): Promise<TestSigner> {
  const generated = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  const keyPair = generated as CryptoKeyPair;
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    publicKey: base64UrlEncode(rawKey),
    privateKey: keyPair.privateKey,
    rawKey,
  };
}

async function signedPublish(baseUrl: string, args: {
  signer: TestSigner;
  sender: string;
  id: string;
  topic?: string;
  room?: string;
  payload: unknown;
}): Promise<Response> {
  const topic = args.topic ?? 'notify';
  const room = args.room ?? 'main';
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const payloadHash = await sha256Hex(canonicalizeJson(args.payload));
  const message = buildPublishSigningMessage({
    sender: args.sender,
    room,
    id: args.id,
    topic,
    ts,
    nonce,
    payloadHash,
  });
  const signature = await signEd25519(args.signer.privateKey, message);
  const url = new URL(`${baseUrl}/api/v1/publish`);
  url.searchParams.set('room', room);
  url.searchParams.set('sender', args.sender);
  url.searchParams.set('topic', topic);
  url.searchParams.set('id', args.id);
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-public-key': args.signer.publicKey,
      'x-relay-signature': signature,
      'x-relay-timestamp': String(ts),
      'x-relay-nonce': nonce,
    },
    body: JSON.stringify(args.payload),
  });
}

async function unsignedPublish(
  baseUrl: string,
  args: { sender: string; id: string; payload: unknown; topic?: string; room?: string },
): Promise<Response> {
  const topic = args.topic ?? 'notify';
  const room = args.room ?? 'main';
  const url = new URL(`${baseUrl}/api/v1/publish`);
  url.searchParams.set('room', room);
  url.searchParams.set('sender', args.sender);
  url.searchParams.set('topic', topic);
  url.searchParams.set('id', args.id);
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args.payload),
  });
}

async function verifyGitHub(baseUrl: string, sender: string): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/key/verify-github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender, github_username: sender }),
  });
}

async function registerServe(baseUrl: string, sender: string, repo: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(
    `${baseUrl}/api/v1/serve/register?sender=${encodeURIComponent(sender)}&repo=${
      encodeURIComponent(repo)
    }`,
    { method: 'POST' },
  );
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

function createTestRelayServer(args: {
  requireSignatureFlag: 'true' | 'false';
  fetchFn?: typeof globalThis.fetch;
}): {
  baseUrl: string;
  shutdown: () => Promise<void>;
} {
  const runtimeConfig = parseRelayRuntimeConfigFromEnv(
    envFrom({
      RELAY_REQUIRE_SIGNATURE: args.requireSignatureFlag,
    }),
  );
  const service = createMemoryRelayService({
    ...runtimeConfig.relay,
    fetchFn: args.fetchFn,
  });
  const sessions = new Map<string, ReturnType<typeof createGitServeSession>>();

  function generateSessionId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      result += chars[bytes[i] % chars.length];
    }
    return result;
  }

  function getOrCreateSession(sessionId: string): ReturnType<typeof createGitServeSession> {
    let session = sessions.get(sessionId);
    if (!session) {
      session = createGitServeSession();
      sessions.set(sessionId, session);
    }
    return session;
  }

  function extractToken(request: Request): string {
    const url = new URL(request.url);
    return url.searchParams.get('session_token') ?? request.headers.get('x-session-token') ?? '';
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const namedGitMatch = pathname.match(
      /^\/git\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(.*)/,
    );
    if (namedGitMatch) {
      const candidateId = `${namedGitMatch[1]}/${namedGitMatch[2]}`;
      const session = sessions.get(candidateId);
      if (session) {
        const doUrl = new URL(request.url);
        doUrl.pathname = '/git/' + namedGitMatch[3];
        return session.fetch(new Request(doUrl.toString(), request));
      }
    }

    const randomGitMatch = pathname.match(/^\/git\/([A-Za-z0-9]{6,16})\/(.*)/);
    if (randomGitMatch) {
      const session = sessions.get(randomGitMatch[1]);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const doUrl = new URL(request.url);
      doUrl.pathname = '/git/' + randomGitMatch[2];
      return session.fetch(new Request(doUrl.toString(), request));
    }

    if (pathname === '/api/v1/serve/register' && request.method === 'POST') {
      const sender = url.searchParams.get('sender') ?? '';
      const repo = url.searchParams.get('repo') ?? '';
      let sessionId = generateSessionId();
      if (sender && repo) {
        const keyInfoRes = await service.fetch(
          new Request(`http://relay.local/api/v1/key/info?sender=${encodeURIComponent(sender)}`),
        );
        const keyInfo = await keyInfoRes.json() as Record<string, unknown>;
        const keyRecord = keyInfo.key as Record<string, unknown> | undefined;
        if (keyInfoRes.status === 200 && keyRecord?.github_verified_at) {
          sessionId = `${sender}/${repo}`;
        }
      }

      const session = getOrCreateSession(sessionId);
      const result = await session.fetch(
        new Request('http://relay.local/register', { method: 'POST' }),
      );
      const body = await result.json() as Record<string, unknown>;
      return Response.json({ ...body, session_id: sessionId });
    }

    if (pathname === '/api/v1/serve/poll' && request.method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      const session = sessions.get(sessionId);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const timeout = url.searchParams.get('timeout') ?? '30';
      const token = extractToken(request);
      return session.fetch(
        new Request(
          `http://relay.local/poll?timeout=${timeout}&session_token=${encodeURIComponent(token)}`,
        ),
      );
    }

    if (pathname === '/api/v1/serve/respond' && request.method === 'POST') {
      const sessionId = url.searchParams.get('session') ?? '';
      const session = sessions.get(sessionId);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const token = extractToken(request);
      return session.fetch(
        new Request(`http://relay.local/respond?session_token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        }),
      );
    }

    if (pathname === '/api/v1/serve/info' && request.method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      const session = sessions.get(sessionId);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const token = extractToken(request);
      return session.fetch(
        new Request(`http://relay.local/info?session_token=${encodeURIComponent(token)}`),
      );
    }

    return service.fetch(request);
  }

  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, handler);
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    async shutdown() {
      for (const session of sessions.values()) {
        session.cleanup();
      }
      sessions.clear();
      service.close();
      await server.shutdown();
    },
  };
}

Deno.test('e2e: RELAY_REQUIRE_SIGNATURE=true permission boundary for verified/unverified users', async () => {
  const aliceSigner = await createSignerWithRawKey();
  const relay = createTestRelayServer({
    requireSignatureFlag: 'true',
    fetchFn: createMockGitHubFetchByUser({ alice: [aliceSigner.rawKey] }),
  });

  try {
    const unsignedPublishRes = await unsignedPublish(relay.baseUrl, {
      sender: 'bob',
      id: 'unsigned-1',
      payload: { body: 'unsigned publish should fail' },
    });
    assertEquals(unsignedPublishRes.status, 401);
    await unsignedPublishRes.json();

    const signedPublishRes = await signedPublish(relay.baseUrl, {
      signer: aliceSigner,
      sender: 'alice',
      id: 'signed-1',
      payload: { body: 'signed publish should pass' },
    });
    assertEquals(signedPublishRes.status, 200);
    await signedPublishRes.json();

    const beforeVerify = await registerServe(relay.baseUrl, 'alice', 'bit-relay');
    assertEquals(beforeVerify.status, 200);
    assertMatch(String(beforeVerify.body.session_id), RANDOM_SESSION_PATTERN);

    const verifyAlice = await verifyGitHub(relay.baseUrl, 'alice');
    assertEquals(verifyAlice.status, 200);
    const verifyAliceBody = await verifyAlice.json() as Record<string, unknown>;
    assertEquals(verifyAliceBody.verified, true);

    const afterVerify = await registerServe(relay.baseUrl, 'alice', 'bit-relay');
    assertEquals(afterVerify.status, 200);
    assertEquals(afterVerify.body.session_id, 'alice/bit-relay');

    const verifyBob = await verifyGitHub(relay.baseUrl, 'bob');
    assertEquals(verifyBob.status, 404);
    await verifyBob.json();

    const bobRegister = await registerServe(relay.baseUrl, 'bob', 'bit-relay');
    assertEquals(bobRegister.status, 200);
    assertMatch(String(bobRegister.body.session_id), RANDOM_SESSION_PATTERN);
  } finally {
    await relay.shutdown();
  }
});

Deno.test('e2e: RELAY_REQUIRE_SIGNATURE=false still requires GitHub verification for named session', async () => {
  const aliceSigner = await createSignerWithRawKey();
  const relay = createTestRelayServer({
    requireSignatureFlag: 'false',
    fetchFn: createMockGitHubFetchByUser({ alice: [aliceSigner.rawKey] }),
  });

  try {
    const unsignedPublishRes = await unsignedPublish(relay.baseUrl, {
      sender: 'bob',
      id: 'unsigned-2',
      payload: { body: 'unsigned publish should pass' },
    });
    assertEquals(unsignedPublishRes.status, 200);
    await unsignedPublishRes.json();

    const bobRegister = await registerServe(relay.baseUrl, 'bob', 'bit-relay');
    assertEquals(bobRegister.status, 200);
    assertMatch(String(bobRegister.body.session_id), RANDOM_SESSION_PATTERN);

    const verifyBob = await verifyGitHub(relay.baseUrl, 'bob');
    assertEquals(verifyBob.status, 404);
    await verifyBob.json();

    const signedPublishRes = await signedPublish(relay.baseUrl, {
      signer: aliceSigner,
      sender: 'alice',
      id: 'signed-2',
      payload: { body: 'signed publish for key registration' },
    });
    assertEquals(signedPublishRes.status, 200);
    await signedPublishRes.json();

    const verifyAlice = await verifyGitHub(relay.baseUrl, 'alice');
    assertEquals(verifyAlice.status, 200);
    const verifyAliceBody = await verifyAlice.json() as Record<string, unknown>;
    assertEquals(verifyAliceBody.verified, true);

    const afterVerify = await registerServe(relay.baseUrl, 'alice', 'bit-relay');
    assertEquals(afterVerify.status, 200);
    assertEquals(afterVerify.body.session_id, 'alice/bit-relay');
  } finally {
    await relay.shutdown();
  }
});
