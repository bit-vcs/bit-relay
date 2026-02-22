import { assertEquals, assertObjectMatch } from '@std/assert';
import {
  createMemoryRelayHandler,
  createMemoryRelayService,
} from '../src/memory_handler.ts';
import {
  base64UrlEncode,
  buildPublishSigningMessage,
  buildRotateSigningMessage,
  canonicalizeJson,
  sha256Hex,
  signEd25519,
} from '../src/signing.ts';

interface TestSigner {
  publicKey: string;
  privateKey: CryptoKey;
}

async function createSigner(): Promise<TestSigner> {
  const generated = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  if (!('privateKey' in generated) || !('publicKey' in generated)) {
    throw new Error('failed to generate ed25519 key pair');
  }
  const keyPair = generated as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    publicKey: base64UrlEncode(publicKeyRaw),
    privateKey: keyPair.privateKey,
  };
}

async function signedPublishRequest(args: {
  url: string;
  signer: TestSigner;
  sender: string;
  room: string;
  id: string;
  topic?: string;
  payload: unknown;
  body?: unknown;
  nonce?: string;
  ts?: number;
}): Promise<Request> {
  const topic = args.topic ?? 'notify';
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  const nonce = args.nonce ?? crypto.randomUUID();
  const payloadHash = await sha256Hex(canonicalizeJson(args.payload));
  const message = buildPublishSigningMessage({
    sender: args.sender,
    room: args.room,
    id: args.id,
    topic,
    ts,
    nonce,
    payloadHash,
  });
  const signature = await signEd25519(args.signer.privateKey, message);

  const url = new URL(args.url);
  url.searchParams.set('room', args.room);
  url.searchParams.set('sender', args.sender);
  url.searchParams.set('topic', topic);
  url.searchParams.set('id', args.id);

  return new Request(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-public-key': args.signer.publicKey,
      'x-relay-signature': signature,
      'x-relay-timestamp': String(ts),
      'x-relay-nonce': nonce,
    },
    body: JSON.stringify(args.body ?? args.payload),
  });
}

async function rotateRequest(args: {
  sender: string;
  oldSigner: TestSigner;
  newSigner: TestSigner;
  ts?: number;
  nonce?: string;
}): Promise<Request> {
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  const nonce = args.nonce ?? crypto.randomUUID();
  const message = buildRotateSigningMessage({
    sender: args.sender,
    newPublicKey: args.newSigner.publicKey,
    ts,
    nonce,
  });
  const oldSignature = await signEd25519(args.oldSigner.privateKey, message);
  const newSignature = await signEd25519(args.newSigner.privateKey, message);
  return new Request('http://relay.local/api/v1/key/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: args.sender,
      new_public_key: args.newSigner.publicKey,
      ts,
      nonce,
      old_signature: oldSignature,
      new_signature: newSignature,
    }),
  });
}

Deno.test('health endpoint returns ok', async () => {
  const handler = createMemoryRelayHandler({});
  const res = await handler(new Request('http://relay.local/health'));
  assertEquals(res.status, 200);
  assertObjectMatch(await res.json(), { status: 'ok', service: 'bit-relay' });
});

Deno.test('publish requires signature by default', async () => {
  const handler = createMemoryRelayHandler({});
  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=notify&id=m1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'hub.record', record: 'record-1' }),
    }),
  );
  assertEquals(publish.status, 401);
  assertObjectMatch(await publish.json(), { ok: false, error: 'missing signature headers' });
});

Deno.test('signed publish and poll with direct payload', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();

  const publish = await handler(
    await signedPublishRequest({
      url: 'http://relay.local/api/v1/publish',
      signer,
      sender: 'bit',
      room: 'main',
      id: 'm1',
      payload: { kind: 'hub.record', record: 'record-1' },
    }),
  );
  assertEquals(publish.status, 200);
  assertObjectMatch(await publish.json(), { ok: true, accepted: true, cursor: 1 });

  const poll = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=200'),
  );
  assertEquals(poll.status, 200);
  const body = await poll.json();
  assertEquals(body.next_cursor, 1);
  assertEquals(body.envelopes.length, 1);
  assertObjectMatch(body.envelopes[0], {
    room: 'main',
    id: 'm1',
    sender: 'bit',
    topic: 'notify',
    payload: { kind: 'hub.record', record: 'record-1' },
  });
});

Deno.test('signed publish accepts wrapped payload for bithub compatibility', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();
  const payload = {
    kind: 'bithub.node',
    url: 'http://127.0.0.1:3100',
    name: 'node-a',
  };

  const publish = await handler(
    await signedPublishRequest({
      url: 'http://relay.local/api/v1/publish',
      signer,
      sender: 'node-a',
      room: 'main',
      id: 'b1',
      payload,
      body: { payload },
    }),
  );
  assertEquals(publish.status, 200);

  const poll = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=200'),
  );
  const body = await poll.json();
  assertEquals(body.envelopes.length, 1);
  assertObjectMatch(body.envelopes[0].payload, payload);
});

Deno.test('TOFU rejects different public key for same sender', async () => {
  const handler = createMemoryRelayHandler({});
  const signerA = await createSigner();
  const signerB = await createSigner();

  const publishA = await handler(
    await signedPublishRequest({
      url: 'http://relay.local/api/v1/publish',
      signer: signerA,
      sender: 'alice',
      room: 'main',
      id: 'm1',
      payload: { kind: 'hub.record', record: 'r1' },
    }),
  );
  assertEquals(publishA.status, 200);

  const publishB = await handler(
    await signedPublishRequest({
      url: 'http://relay.local/api/v1/publish',
      signer: signerB,
      sender: 'alice',
      room: 'main',
      id: 'm2',
      payload: { kind: 'hub.record', record: 'r2' },
    }),
  );
  assertEquals(publishB.status, 409);
  assertObjectMatch(await publishB.json(), { ok: false, error: 'sender key mismatch' });
});

Deno.test('nonce replay is rejected', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();
  const nonce = 'nonce-1';

  const publish1 = await handler(
    await signedPublishRequest({
      url: 'http://relay.local/api/v1/publish',
      signer,
      sender: 'alice',
      room: 'main',
      id: 'm1',
      payload: { kind: 'hub.record', record: 'r1' },
      nonce,
    }),
  );
  assertEquals(publish1.status, 200);

  const publish2 = await handler(
    await signedPublishRequest({
      url: 'http://relay.local/api/v1/publish',
      signer,
      sender: 'alice',
      room: 'main',
      id: 'm2',
      payload: { kind: 'hub.record', record: 'r2' },
      nonce,
    }),
  );
  assertEquals(publish2.status, 409);
  assertObjectMatch(await publish2.json(), { ok: false, error: 'replayed nonce' });
});

Deno.test('key rotate updates sender public key', async () => {
  const handler = createMemoryRelayHandler({});
  const signerA = await createSigner();
  const signerB = await createSigner();

  const initialPublish = await handler(
    await signedPublishRequest({
      url: 'http://relay.local/api/v1/publish',
      signer: signerA,
      sender: 'alice',
      room: 'main',
      id: 'm1',
      payload: { kind: 'hub.record', record: 'r1' },
    }),
  );
  assertEquals(initialPublish.status, 200);

  const rotate = await handler(
    await rotateRequest({
      sender: 'alice',
      oldSigner: signerA,
      newSigner: signerB,
    }),
  );
  assertEquals(rotate.status, 200);
  assertObjectMatch(await rotate.json(), { ok: true, sender: 'alice' });

  const oldKeyPublish = await handler(
    await signedPublishRequest({
      url: 'http://relay.local/api/v1/publish',
      signer: signerA,
      sender: 'alice',
      room: 'main',
      id: 'm2',
      payload: { kind: 'hub.record', record: 'r2' },
    }),
  );
  assertEquals(oldKeyPublish.status, 409);

  const newKeyPublish = await handler(
    await signedPublishRequest({
      url: 'http://relay.local/api/v1/publish',
      signer: signerB,
      sender: 'alice',
      room: 'main',
      id: 'm3',
      payload: { kind: 'hub.record', record: 'r3' },
    }),
  );
  assertEquals(newKeyPublish.status, 200);
});

Deno.test('unsigned mode keeps backward compatibility', async () => {
  const handler = createMemoryRelayHandler({ requireSignatures: false });
  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=notify&id=m1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'hub.record', record: 'record-1' }),
    }),
  );
  assertEquals(publish.status, 200);
});

Deno.test('requires bearer token when auth token configured', async () => {
  const handler = createMemoryRelayHandler({ authToken: 'secret-token', requireSignatures: false });

  const unauthorized = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=10'),
  );
  assertEquals(unauthorized.status, 401);

  const authorized = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=10', {
      headers: {
        authorization: 'Bearer secret-token',
      },
    }),
  );
  assertEquals(authorized.status, 200);
});

Deno.test('publish and poll with topic=issue', async () => {
  const handler = createMemoryRelayHandler({ requireSignatures: false });

  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=issue&id=i1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'issue.created', title: 'bug report' }),
    }),
  );
  assertEquals(publish.status, 200);
  assertObjectMatch(await publish.json(), { ok: true, accepted: true });

  const poll = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=10'),
  );
  assertEquals(poll.status, 200);
  const body = await poll.json();
  assertEquals(body.envelopes.length, 1);
  assertObjectMatch(body.envelopes[0], {
    topic: 'issue',
    payload: { kind: 'issue.created', title: 'bug report' },
  });
});

Deno.test('publish with dotted topic succeeds', async () => {
  const handler = createMemoryRelayHandler({ requireSignatures: false });

  const publish = await handler(
    new Request(
      'http://relay.local/api/v1/publish?room=main&sender=bit&topic=issue.created&id=d1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'test' }),
      },
    ),
  );
  assertEquals(publish.status, 200);
  assertObjectMatch(await publish.json(), { ok: true, accepted: true });

  const poll = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=10'),
  );
  const body = await poll.json();
  assertEquals(body.envelopes[0].topic, 'issue.created');
});

Deno.test('publish rejects invalid topic - empty string', async () => {
  const handler = createMemoryRelayHandler({ requireSignatures: false });

  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=&id=e1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 1 }),
    }),
  );
  // empty topic falls back to 'notify' default
  assertEquals(publish.status, 200);
});

Deno.test('publish rejects invalid topic - special characters', async () => {
  const handler = createMemoryRelayHandler({ requireSignatures: false });

  const publish = await handler(
    new Request(
      'http://relay.local/api/v1/publish?room=main&sender=bit&topic=foo%2Fbar&id=s1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: 1 }),
      },
    ),
  );
  assertEquals(publish.status, 400);
  assertObjectMatch(await publish.json(), { ok: false, error: 'invalid topic: foo/bar' });
});

Deno.test('publish rejects invalid topic - starts with digit', async () => {
  const handler = createMemoryRelayHandler({ requireSignatures: false });

  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=1abc&id=n1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 1 }),
    }),
  );
  assertEquals(publish.status, 400);
  assertObjectMatch(await publish.json(), { ok: false, error: 'invalid topic: 1abc' });
});

Deno.test('publish rejects invalid topic - uppercase', async () => {
  const handler = createMemoryRelayHandler({ requireSignatures: false });

  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=Notify&id=u1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 1 }),
    }),
  );
  assertEquals(publish.status, 400);
  assertObjectMatch(await publish.json(), { ok: false, error: 'invalid topic: Notify' });
});

// --- room token tests ---

Deno.test('room token - publish without token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=notify&id=t1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 1 }),
    }),
  );
  assertEquals(res.status, 403);
  assertObjectMatch(await res.json(), { ok: false, error: 'forbidden' });
});

Deno.test('room token - poll without token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/poll?room=main'),
  );
  assertEquals(res.status, 403);
  assertObjectMatch(await res.json(), { ok: false, error: 'forbidden' });
});

Deno.test('room token - publish with correct x-room-token header succeeds', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=notify&id=t2', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-room-token': 'secret123',
      },
      body: JSON.stringify({ data: 1 }),
    }),
  );
  assertEquals(res.status, 200);
  assertObjectMatch(await res.json(), { ok: true, accepted: true });
});

Deno.test('room token - poll with correct query param succeeds', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/poll?room=main&room_token=secret123'),
  );
  assertEquals(res.status, 200);
  assertObjectMatch(await res.json(), { ok: true, room: 'main' });
});

Deno.test('room token - room without token configured allows access', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { protected: 'secret123' },
  });

  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=notify&id=t3', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 1 }),
    }),
  );
  assertEquals(publish.status, 200);
  assertObjectMatch(await publish.json(), { ok: true, accepted: true });

  const poll = await handler(
    new Request('http://relay.local/api/v1/poll?room=main'),
  );
  assertEquals(poll.status, 200);
  assertObjectMatch(await poll.json(), { ok: true, room: 'main' });
});

Deno.test('room token - wrong token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/poll?room=main', {
      headers: { 'x-room-token': 'wrong-token' },
    }),
  );
  assertEquals(res.status, 403);
  assertObjectMatch(await res.json(), { ok: false, error: 'forbidden' });
});

Deno.test('room token - inbox/pending without token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/inbox/pending?room=main&consumer=c1'),
  );
  assertEquals(res.status, 403);
  assertObjectMatch(await res.json(), { ok: false, error: 'forbidden' });
});

Deno.test('room token - inbox/ack without token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/inbox/ack?room=main&consumer=c1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['m1'] }),
    }),
  );
  assertEquals(res.status, 403);
  assertObjectMatch(await res.json(), { ok: false, error: 'forbidden' });
});

Deno.test('room token - presence/heartbeat without token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/presence/heartbeat?room=main&participant=p1', {
      method: 'POST',
    }),
  );
  assertEquals(res.status, 403);
  assertObjectMatch(await res.json(), { ok: false, error: 'forbidden' });
});

Deno.test('room token - presence GET without token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/presence?room=main'),
  );
  assertEquals(res.status, 403);
  assertObjectMatch(await res.json(), { ok: false, error: 'forbidden' });
});

Deno.test('room token - presence DELETE without token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });

  const res = await handler(
    new Request('http://relay.local/api/v1/presence?room=main&participant=p1', {
      method: 'DELETE',
    }),
  );
  assertEquals(res.status, 403);
  assertObjectMatch(await res.json(), { ok: false, error: 'forbidden' });
});

Deno.test('room token - all endpoints succeed with correct header token', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomTokens: { main: 'secret123' },
  });
  const tokenHeader = { 'x-room-token': 'secret123' };

  // publish
  const publish = await handler(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=notify&id=rt1', {
      method: 'POST',
      headers: { ...tokenHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ data: 1 }),
    }),
  );
  assertEquals(publish.status, 200);

  // poll
  const poll = await handler(
    new Request('http://relay.local/api/v1/poll?room=main', { headers: tokenHeader }),
  );
  assertEquals(poll.status, 200);

  // inbox/pending
  const pending = await handler(
    new Request('http://relay.local/api/v1/inbox/pending?room=main&consumer=c1', {
      headers: tokenHeader,
    }),
  );
  assertEquals(pending.status, 200);

  // inbox/ack
  const ack = await handler(
    new Request('http://relay.local/api/v1/inbox/ack?room=main&consumer=c1', {
      method: 'POST',
      headers: { ...tokenHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['rt1'] }),
    }),
  );
  assertEquals(ack.status, 200);

  // presence/heartbeat
  const heartbeat = await handler(
    new Request('http://relay.local/api/v1/presence/heartbeat?room=main&participant=p1', {
      method: 'POST',
      headers: tokenHeader,
    }),
  );
  assertEquals(heartbeat.status, 200);

  // presence GET
  const presence = await handler(
    new Request('http://relay.local/api/v1/presence?room=main', { headers: tokenHeader }),
  );
  assertEquals(presence.status, 200);

  // presence DELETE
  const leave = await handler(
    new Request('http://relay.local/api/v1/presence?room=main&participant=p1', {
      method: 'DELETE',
      headers: tokenHeader,
    }),
  );
  assertEquals(leave.status, 200);
});

// --- GitHub SSH key verification tests ---

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

function createMockGitHubFetch(rawKeys: Uint8Array[]): typeof globalThis.fetch {
  return (_url: string | URL | Request) => {
    const lines = rawKeys.map((k) => `ssh-ed25519 ${buildSshEd25519Blob(k)} user@host`).join('\n');
    return Promise.resolve(new Response(lines, { status: 200 }));
  };
}

async function createSignerWithRawKey(): Promise<TestSigner & { rawKey: Uint8Array }> {
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

Deno.test('verify-github - success with matching key', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });

  // First publish to register the key
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer,
    sender: 'mizchi',
    room: 'main',
    id: 'v1',
    payload: { data: 1 },
  });
  const publishRes = await service.fetch(publishReq);
  assertEquals(publishRes.status, 200);

  // Verify GitHub
  const verifyRes = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );
  assertEquals(verifyRes.status, 200);
  const body = await verifyRes.json();
  assertEquals(body.ok, true);
  assertEquals(body.verified, true);
  assertEquals(body.sender, 'mizchi');
  assertEquals(body.github_username, 'mizchi');
  assertEquals(typeof body.github_verified_at, 'number');
});

Deno.test('verify-github - key mismatch returns verified false', async () => {
  const signer = await createSignerWithRawKey();
  const differentKey = new Uint8Array(32);
  crypto.getRandomValues(differentKey);
  const mockFetch = createMockGitHubFetch([differentKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });

  // Register key
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer,
    sender: 'mizchi',
    room: 'main',
    id: 'v2',
    payload: { data: 1 },
  });
  await service.fetch(publishReq);

  const verifyRes = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );
  assertEquals(verifyRes.status, 200);
  const body = await verifyRes.json();
  assertEquals(body.ok, false);
  assertEquals(body.verified, false);
  assertEquals(body.error, 'key not found in github keys');
});

Deno.test('verify-github - sender not found returns 404', async () => {
  const mockFetch = createMockGitHubFetch([]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });

  const verifyRes = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'unknown', github_username: 'unknown' }),
    }),
  );
  assertEquals(verifyRes.status, 404);
  assertObjectMatch(await verifyRes.json(), { ok: false, error: 'sender key not found' });
});

Deno.test('verify-github - sender != github_username returns 400', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });

  // Register key
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer,
    sender: 'mizchi',
    room: 'main',
    id: 'v3',
    payload: { data: 1 },
  });
  await service.fetch(publishReq);

  const verifyRes = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'other-user' }),
    }),
  );
  assertEquals(verifyRes.status, 400);
  assertObjectMatch(await verifyRes.json(), {
    ok: false,
    error: 'sender must match github_username',
  });
});

Deno.test('key/info reflects github fields after verification', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });

  // Register key
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer,
    sender: 'mizchi',
    room: 'main',
    id: 'info1',
    payload: { data: 1 },
  });
  await service.fetch(publishReq);

  // Check key/info before verification
  const infoBefore = await service.fetch(
    new Request('http://relay.local/api/v1/key/info?sender=mizchi'),
  );
  assertEquals(infoBefore.status, 200);
  const beforeBody = await infoBefore.json();
  assertEquals(beforeBody.key.github_username, null);
  assertEquals(beforeBody.key.github_verified_at, null);

  // Verify
  await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );

  // Check key/info after verification
  const infoAfter = await service.fetch(
    new Request('http://relay.local/api/v1/key/info?sender=mizchi'),
  );
  assertEquals(infoAfter.status, 200);
  const afterBody = await infoAfter.json();
  assertEquals(afterBody.key.github_username, 'mizchi');
  assertEquals(typeof afterBody.key.github_verified_at, 'number');
});

Deno.test('snapshot/restore preserves github fields', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });

  // Register key and verify
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer,
    sender: 'mizchi',
    room: 'main',
    id: 'snap1',
    payload: { data: 1 },
  });
  await service.fetch(publishReq);
  await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );

  // Snapshot
  const snap = service.snapshot();
  assertEquals(snap.keys_by_sender['mizchi'].github_username, 'mizchi');
  assertEquals(typeof snap.keys_by_sender['mizchi'].github_verified_at, 'number');

  // Restore into a new service
  const service2 = createMemoryRelayService({ fetchFn: mockFetch });
  service2.restore(snap);

  // key/info should still have github fields
  const infoRes = await service2.fetch(
    new Request('http://relay.local/api/v1/key/info?sender=mizchi'),
  );
  assertEquals(infoRes.status, 200);
  const body = await infoRes.json();
  assertEquals(body.key.github_username, 'mizchi');
  assertEquals(typeof body.key.github_verified_at, 'number');
});

Deno.test('verify-github - GET method returns 405', async () => {
  const service = createMemoryRelayService({});
  const res = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github'),
  );
  assertEquals(res.status, 405);
  assertObjectMatch(await res.json(), { ok: false, error: 'method not allowed' });
});

Deno.test('verify-github - invalid json body returns 400', async () => {
  const service = createMemoryRelayService({});
  const res = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    }),
  );
  assertEquals(res.status, 400);
  assertObjectMatch(await res.json(), { ok: false, error: 'invalid json payload' });
});

Deno.test('verify-github - missing sender field returns 400', async () => {
  const service = createMemoryRelayService({});
  const res = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ github_username: 'mizchi' }),
    }),
  );
  assertEquals(res.status, 400);
  assertObjectMatch(await res.json(), { ok: false, error: 'missing field: sender' });
});

Deno.test('verify-github - missing github_username field returns 400', async () => {
  const service = createMemoryRelayService({});
  const res = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi' }),
    }),
  );
  assertEquals(res.status, 400);
  assertObjectMatch(await res.json(), { ok: false, error: 'missing field: github_username' });
});

Deno.test('verify-github - github fetch failure returns 502', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = (_url: string | URL | Request) =>
    Promise.reject(new Error('connection refused'));
  const service = createMemoryRelayService({ fetchFn: mockFetch as typeof globalThis.fetch });

  // Register key
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer,
    sender: 'mizchi',
    room: 'main',
    id: 'err1',
    payload: { data: 1 },
  });
  await service.fetch(publishReq);

  const res = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(body.error.includes('connection refused'), true);
});

Deno.test('verify-github - re-verification updates timestamp', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });

  // Register key
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer,
    sender: 'mizchi',
    room: 'main',
    id: 'rev1',
    payload: { data: 1 },
  });
  await service.fetch(publishReq);

  // First verification
  const res1 = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );
  assertEquals(res1.status, 200);
  const body1 = await res1.json();
  assertEquals(body1.verified, true);
  const firstTimestamp = body1.github_verified_at;

  // Second verification (re-verify)
  const res2 = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );
  assertEquals(res2.status, 200);
  const body2 = await res2.json();
  assertEquals(body2.verified, true);
  // Timestamp should be >= first (same second or later)
  assertEquals(body2.github_verified_at >= firstTimestamp, true);
});

Deno.test('verify-github - key mismatch does not set github fields', async () => {
  const signer = await createSignerWithRawKey();
  const differentKey = new Uint8Array(32);
  crypto.getRandomValues(differentKey);
  const mockFetch = createMockGitHubFetch([differentKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });

  // Register key
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer,
    sender: 'mizchi',
    room: 'main',
    id: 'nomatch1',
    payload: { data: 1 },
  });
  await service.fetch(publishReq);

  // Attempt verification (mismatch)
  await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );

  // key/info should still have null github fields
  const infoRes = await service.fetch(
    new Request('http://relay.local/api/v1/key/info?sender=mizchi'),
  );
  const body = await infoRes.json();
  assertEquals(body.key.github_username, null);
  assertEquals(body.key.github_verified_at, null);
});

Deno.test('verify-github - works with auth token', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({
    authToken: 'secret',
    fetchFn: mockFetch,
  });

  // Register key (with auth)
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer,
    sender: 'mizchi',
    room: 'main',
    id: 'auth1',
    payload: { data: 1 },
  });
  // Add auth header
  const authedPublish = new Request(publishReq.url, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(publishReq.headers.entries()),
      'authorization': 'Bearer secret',
    },
    body: await publishReq.text(),
  });
  const publishRes = await service.fetch(authedPublish);
  assertEquals(publishRes.status, 200);

  // verify-github without auth → 401
  const noAuthRes = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );
  assertEquals(noAuthRes.status, 401);

  // verify-github with auth → success
  const authRes = await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer secret',
      },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );
  assertEquals(authRes.status, 200);
  const body = await authRes.json();
  assertEquals(body.verified, true);
});

Deno.test('snapshot/restore - old snapshot without github fields defaults to null', () => {
  const service = createMemoryRelayService({});
  // Simulate an old snapshot that lacks github fields
  const oldSnapshot = {
    rooms: {},
    keys_by_sender: {
      alice: {
        public_key: 'AAAA',
        status: 'active' as const,
        first_seen_at: 1000,
        last_seen_at: 1000,
        rotated_at: null,
        revoked_at: null,
        // no github_username or github_verified_at
      },
    },
    nonces_by_sender: {},
  };

  // deno-lint-ignore no-explicit-any
  service.restore(oldSnapshot as any);
  const snap = service.snapshot();
  assertEquals(snap.keys_by_sender['alice'].github_username, null);
  assertEquals(snap.keys_by_sender['alice'].github_verified_at, null);
});

Deno.test('key rotate resets github verification', async () => {
  const signerA = await createSignerWithRawKey();
  const signerB = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signerA.rawKey, signerB.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });

  // Register and verify
  const publishReq = await signedPublishRequest({
    url: 'http://relay.local/api/v1/publish',
    signer: signerA,
    sender: 'mizchi',
    room: 'main',
    id: 'rot1',
    payload: { data: 1 },
  });
  await service.fetch(publishReq);
  await service.fetch(
    new Request('http://relay.local/api/v1/key/verify-github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
    }),
  );

  // Rotate key
  const rotateReq = await rotateRequest({
    sender: 'mizchi',
    oldSigner: signerA,
    newSigner: signerB,
  });
  const rotateRes = await service.fetch(rotateReq);
  assertEquals(rotateRes.status, 200);

  // key/info should have github fields reset
  const infoRes = await service.fetch(
    new Request('http://relay.local/api/v1/key/info?sender=mizchi'),
  );
  const body = await infoRes.json();
  assertEquals(body.key.github_username, null);
  assertEquals(body.key.github_verified_at, null);
});
