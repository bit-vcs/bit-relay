import { assertEquals, assertMatch, assertObjectMatch } from '@std/assert';
import { createMemoryRelayHandler, createMemoryRelayService } from '../src/memory_handler.ts';
import {
  base64UrlEncode,
  buildPublishSigningMessage,
  buildRotateSigningMessage,
  canonicalizeJson,
  sha256Hex,
  signEd25519,
} from '../src/signing.ts';
import { createGitServeSession } from '../src/git_serve_session.ts';

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

// --- IP rate limit tests ---

Deno.test('ip rate limit - same IP exceeds limit gets 429', async () => {
  const limit = 3;
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    ipPublishLimitPerWindow: limit,
  });

  for (let i = 0; i < limit; i++) {
    const res = await handler(
      new Request(
        `http://relay.local/api/v1/publish?room=main&sender=s${i}&topic=notify&id=ip${i}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '10.0.0.1',
          },
          body: JSON.stringify({ data: i }),
        },
      ),
    );
    assertEquals(res.status, 200);
  }

  const blocked = await handler(
    new Request(
      `http://relay.local/api/v1/publish?room=main&sender=sExtra&topic=notify&id=ip${limit}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: JSON.stringify({ data: 'blocked' }),
      },
    ),
  );
  assertEquals(blocked.status, 429);
  assertObjectMatch(await blocked.json(), { ok: false, error: 'ip rate limit exceeded' });
});

Deno.test('ip rate limit - different IPs are independent', async () => {
  const limit = 2;
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    ipPublishLimitPerWindow: limit,
  });

  for (let i = 0; i < limit; i++) {
    const res = await handler(
      new Request(
        `http://relay.local/api/v1/publish?room=main&sender=a&topic=notify&id=a${i}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '10.0.0.1',
          },
          body: JSON.stringify({ data: i }),
        },
      ),
    );
    assertEquals(res.status, 200);
  }

  // Different IP should still succeed
  const res = await handler(
    new Request(
      'http://relay.local/api/v1/publish?room=main&sender=b&topic=notify&id=b0',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '10.0.0.2',
        },
        body: JSON.stringify({ data: 0 }),
      },
    ),
  );
  assertEquals(res.status, 200);
});

Deno.test('ip rate limit - no IP header skips IP limit', async () => {
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    ipPublishLimitPerWindow: 1,
    publishLimitPerWindow: 100,
    roomPublishLimitPerWindow: 100,
  });

  // Without IP headers, IP limit should be skipped
  for (let i = 0; i < 3; i++) {
    const res = await handler(
      new Request(
        `http://relay.local/api/v1/publish?room=main&sender=noip&topic=notify&id=noip${i}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: i }),
        },
      ),
    );
    assertEquals(res.status, 200);
  }
});

// --- room rate limit tests ---

Deno.test('room rate limit - same room exceeds limit gets 429', async () => {
  const limit = 3;
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomPublishLimitPerWindow: limit,
    publishLimitPerWindow: 100,
    ipPublishLimitPerWindow: 100,
  });

  for (let i = 0; i < limit; i++) {
    const res = await handler(
      new Request(
        `http://relay.local/api/v1/publish?room=crowded&sender=s${i}&topic=notify&id=rm${i}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: i }),
        },
      ),
    );
    assertEquals(res.status, 200);
  }

  const blocked = await handler(
    new Request(
      `http://relay.local/api/v1/publish?room=crowded&sender=sExtra&topic=notify&id=rm${limit}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: 'blocked' }),
      },
    ),
  );
  assertEquals(blocked.status, 429);
  assertObjectMatch(await blocked.json(), { ok: false, error: 'room rate limit exceeded' });
});

Deno.test('room rate limit - different rooms are independent', async () => {
  const limit = 2;
  const handler = createMemoryRelayHandler({
    requireSignatures: false,
    roomPublishLimitPerWindow: limit,
    publishLimitPerWindow: 100,
    ipPublishLimitPerWindow: 100,
  });

  for (let i = 0; i < limit; i++) {
    const res = await handler(
      new Request(
        `http://relay.local/api/v1/publish?room=roomA&sender=s${i}&topic=notify&id=ra${i}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: i }),
        },
      ),
    );
    assertEquals(res.status, 200);
  }

  // Different room should still succeed
  const res = await handler(
    new Request(
      'http://relay.local/api/v1/publish?room=roomB&sender=s0&topic=notify&id=rb0',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: 0 }),
      },
    ),
  );
  assertEquals(res.status, 200);
});

// --- WebSocket heartbeat / reap tests ---

Deno.test('close() stops reap interval without error', () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
    wsPingIntervalMs: 100_000,
    wsIdleTimeoutMs: 300_000,
  });
  // Should not throw
  service.close();
  // Calling twice should also be safe
  service.close();
});

Deno.test('request-driven reap removes stale sessions', async () => {
  // Use very short intervals to test reap behavior
  const service = createMemoryRelayService({
    requireSignatures: false,
    wsPingIntervalMs: 1, // 1ms so request-driven reap triggers every request
    wsIdleTimeoutMs: 1, // 1ms timeout — any session is considered dead
  });

  // Publish a message to create a room
  const publish = await service.fetch(
    new Request('http://relay.local/api/v1/publish?room=main&sender=bit&topic=notify&id=reap1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 1 }),
    }),
  );
  assertEquals(publish.status, 200);

  // Make another request after a small delay to trigger reap
  await new Promise((resolve) => setTimeout(resolve, 5));
  const poll = await service.fetch(
    new Request('http://relay.local/api/v1/poll?room=main&after=0&limit=10'),
  );
  assertEquals(poll.status, 200);

  service.close();
});

Deno.test('service with custom ws options starts and stops cleanly', async () => {
  const service = createMemoryRelayService({
    requireSignatures: false,
    wsPingIntervalMs: 5_000,
    wsIdleTimeoutMs: 15_000,
  });

  const res = await service.fetch(
    new Request('http://relay.local/health'),
  );
  assertEquals(res.status, 200);

  service.close();
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

// --- Named session tests ---

const SESSION_ID_PATTERN = /^[A-Za-z0-9]{6,16}$/;
const NAMED_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id) || NAMED_SESSION_PATTERN.test(id);
}

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

/**
 * Creates a test handler that mirrors deno_main.ts routing logic
 * for named session testing.
 */
function createServeTestHandler(relayService: ReturnType<typeof createMemoryRelayService>) {
  const gitServeSessions = new Map<string, ReturnType<typeof createGitServeSession>>();

  function getOrCreateSession(sessionId: string) {
    let session = gitServeSessions.get(sessionId);
    if (!session) {
      session = createGitServeSession();
      gitServeSessions.set(sessionId, session);
    }
    return session;
  }

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Named session git route
    const namedGitMatch = pathname.match(
      /^\/git\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(.*)/,
    );
    if (namedGitMatch) {
      const candidateId = `${namedGitMatch[1]}/${namedGitMatch[2]}`;
      if (gitServeSessions.has(candidateId)) {
        const session = gitServeSessions.get(candidateId)!;
        const sessionUrl = new URL(request.url);
        sessionUrl.pathname = '/git/' + namedGitMatch[3];
        return session.fetch(new Request(sessionUrl.toString(), request));
      }
    }

    // Random session git route
    const randomGitMatch = pathname.match(/^\/git\/([A-Za-z0-9]{6,16})\/(.*)/);
    if (randomGitMatch) {
      const session = gitServeSessions.get(randomGitMatch[1]);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const sessionUrl = new URL(request.url);
      sessionUrl.pathname = '/git/' + randomGitMatch[2];
      return session.fetch(new Request(sessionUrl.toString(), request));
    }

    // Register
    if (pathname === '/api/v1/serve/register' && request.method === 'POST') {
      const sender = url.searchParams.get('sender') ?? '';
      const repo = url.searchParams.get('repo') ?? '';
      let sessionId: string;

      if (sender && repo) {
        const keyInfoRes = await relayService.fetch(
          new Request(`http://localhost/api/v1/key/info?sender=${encodeURIComponent(sender)}`),
        );
        const keyInfo = await keyInfoRes.json() as Record<string, unknown>;
        const keyRecord = keyInfo.key as Record<string, unknown> | undefined;
        if (keyInfoRes.status === 200 && keyRecord?.github_verified_at) {
          sessionId = `${sender}/${repo}`;
        } else {
          sessionId = generateSessionId();
        }
      } else {
        sessionId = generateSessionId();
      }

      const session = getOrCreateSession(sessionId);
      const result = await session.fetch(
        new Request('http://localhost/register', { method: 'POST' }),
      );
      const body = await result.json() as Record<string, unknown>;
      return Response.json({ ...body, session_id: sessionId });
    }

    // Poll
    if (pathname === '/api/v1/serve/poll' && request.method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      if (!isValidSessionId(sessionId)) {
        return Response.json({ ok: false, error: 'invalid session' }, { status: 400 });
      }
      const session = gitServeSessions.get(sessionId);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const timeout = url.searchParams.get('timeout') ?? '30';
      const token = url.searchParams.get('session_token') ??
        request.headers.get('x-session-token') ?? '';
      return session.fetch(
        new Request(
          `http://localhost/poll?timeout=${timeout}&session_token=${encodeURIComponent(token)}`,
        ),
      );
    }

    // Respond
    if (pathname === '/api/v1/serve/respond' && request.method === 'POST') {
      const sessionId = url.searchParams.get('session') ?? '';
      if (!isValidSessionId(sessionId)) {
        return Response.json({ ok: false, error: 'invalid session' }, { status: 400 });
      }
      const session = gitServeSessions.get(sessionId);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const token = url.searchParams.get('session_token') ??
        request.headers.get('x-session-token') ?? '';
      return session.fetch(
        new Request(`http://localhost/respond?session_token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        }),
      );
    }

    // Info
    if (pathname === '/api/v1/serve/info' && request.method === 'GET') {
      const sessionId = url.searchParams.get('session') ?? '';
      if (!isValidSessionId(sessionId)) {
        return Response.json({ ok: false, error: 'invalid session' }, { status: 400 });
      }
      const session = gitServeSessions.get(sessionId);
      if (!session) {
        return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
      }
      const token = url.searchParams.get('session_token') ??
        request.headers.get('x-session-token') ?? '';
      return session.fetch(
        new Request(`http://localhost/info?session_token=${encodeURIComponent(token)}`),
      );
    }

    // Fallback to relay service
    return relayService.fetch(request);
  }

  function cleanup() {
    for (const session of gitServeSessions.values()) {
      session.cleanup();
    }
    gitServeSessions.clear();
  }

  return { handleRequest, gitServeSessions, cleanup };
}

Deno.test('named session - register with verified sender returns sender/repo session_id', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });
  const { handleRequest, cleanup } = createServeTestHandler(service);

  try {
    // Register key
    await service.fetch(
      await signedPublishRequest({
        url: 'http://relay.local/api/v1/publish',
        signer,
        sender: 'mizchi',
        room: 'main',
        id: 'ns1',
        payload: { data: 1 },
      }),
    );

    // Verify GitHub
    await service.fetch(
      new Request('http://relay.local/api/v1/key/verify-github', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
      }),
    );

    // Register named session
    const res = await handleRequest(
      new Request('http://relay.local/api/v1/serve/register?sender=mizchi&repo=bit-relay', {
        method: 'POST',
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.session_id, 'mizchi/bit-relay');
  } finally {
    cleanup();
  }
});

Deno.test('named session - register with unverified sender returns random session_id', async () => {
  const service = createMemoryRelayService({});
  const { handleRequest, cleanup } = createServeTestHandler(service);

  try {
    // Register without any key registration / verification
    const res = await handleRequest(
      new Request('http://relay.local/api/v1/serve/register?sender=unknown&repo=my-repo', {
        method: 'POST',
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    // Should be a random ID (not named)
    assertMatch(body.session_id, SESSION_ID_PATTERN);
  } finally {
    cleanup();
  }
});

Deno.test('named session - register without sender/repo returns random session_id', async () => {
  const service = createMemoryRelayService({});
  const { handleRequest, cleanup } = createServeTestHandler(service);

  try {
    const res = await handleRequest(
      new Request('http://relay.local/api/v1/serve/register', { method: 'POST' }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertMatch(body.session_id, SESSION_ID_PATTERN);
  } finally {
    cleanup();
  }
});

Deno.test('named session - git route routes to named session', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });
  const { handleRequest, cleanup } = createServeTestHandler(service);

  try {
    // Register key + verify
    await service.fetch(
      await signedPublishRequest({
        url: 'http://relay.local/api/v1/publish',
        signer,
        sender: 'mizchi',
        room: 'main',
        id: 'ns-git1',
        payload: { data: 1 },
      }),
    );
    await service.fetch(
      new Request('http://relay.local/api/v1/key/verify-github', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
      }),
    );

    // Register named session
    const regRes = await handleRequest(
      new Request('http://relay.local/api/v1/serve/register?sender=mizchi&repo=bit-relay', {
        method: 'POST',
      }),
    );
    const regBody = await regRes.json();
    assertEquals(regBody.session_id, 'mizchi/bit-relay');
    const sessionToken = regBody.session_token;

    // Use a short timeout poll to verify the session is reachable
    const pollRes = await handleRequest(
      new Request(
        `http://relay.local/api/v1/serve/poll?session=mizchi/bit-relay&timeout=1&session_token=${sessionToken}`,
      ),
    );
    assertEquals(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assertEquals(pollBody.ok, true);
    assertEquals(Array.isArray(pollBody.requests), true);
  } finally {
    cleanup();
  }
});

Deno.test('named session - poll/respond/info with owner/repo session param', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });
  const { handleRequest, cleanup } = createServeTestHandler(service);

  try {
    // Register key + verify
    await service.fetch(
      await signedPublishRequest({
        url: 'http://relay.local/api/v1/publish',
        signer,
        sender: 'mizchi',
        room: 'main',
        id: 'ns-api1',
        payload: { data: 1 },
      }),
    );
    await service.fetch(
      new Request('http://relay.local/api/v1/key/verify-github', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
      }),
    );

    // Register named session
    const regRes = await handleRequest(
      new Request('http://relay.local/api/v1/serve/register?sender=mizchi&repo=bit-relay', {
        method: 'POST',
      }),
    );
    const regBody = await regRes.json();
    const sessionToken = regBody.session_token;

    // Info
    const infoRes = await handleRequest(
      new Request(
        `http://relay.local/api/v1/serve/info?session=mizchi/bit-relay&session_token=${sessionToken}`,
      ),
    );
    assertEquals(infoRes.status, 200);
    const infoBody = await infoRes.json();
    assertEquals(infoBody.ok, true);
    assertEquals(infoBody.active, true);
  } finally {
    cleanup();
  }
});

Deno.test('named session - re-register overwrites existing session', async () => {
  const signer = await createSignerWithRawKey();
  const mockFetch = createMockGitHubFetch([signer.rawKey]);
  const service = createMemoryRelayService({ fetchFn: mockFetch });
  const { handleRequest, cleanup } = createServeTestHandler(service);

  try {
    // Register key + verify
    await service.fetch(
      await signedPublishRequest({
        url: 'http://relay.local/api/v1/publish',
        signer,
        sender: 'mizchi',
        room: 'main',
        id: 'ns-reregister1',
        payload: { data: 1 },
      }),
    );
    await service.fetch(
      new Request('http://relay.local/api/v1/key/verify-github', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender: 'mizchi', github_username: 'mizchi' }),
      }),
    );

    // First register
    const reg1 = await handleRequest(
      new Request('http://relay.local/api/v1/serve/register?sender=mizchi&repo=bit-relay', {
        method: 'POST',
      }),
    );
    const body1 = await reg1.json();
    assertEquals(body1.session_id, 'mizchi/bit-relay');
    const token1 = body1.session_token;

    // Second register (re-register)
    const reg2 = await handleRequest(
      new Request('http://relay.local/api/v1/serve/register?sender=mizchi&repo=bit-relay', {
        method: 'POST',
      }),
    );
    const body2 = await reg2.json();
    assertEquals(body2.session_id, 'mizchi/bit-relay');
    const token2 = body2.session_token;

    // Old token should no longer work
    const infoOld = await handleRequest(
      new Request(
        `http://relay.local/api/v1/serve/info?session=mizchi/bit-relay&session_token=${token1}`,
      ),
    );
    assertEquals(infoOld.status, 403);

    // New token should work
    const infoNew = await handleRequest(
      new Request(
        `http://relay.local/api/v1/serve/info?session=mizchi/bit-relay&session_token=${token2}`,
      ),
    );
    assertEquals(infoNew.status, 200);
    const infoBody = await infoNew.json();
    assertEquals(infoBody.ok, true);
  } finally {
    cleanup();
  }
});

Deno.test('isValidSessionId accepts both random and named formats', () => {
  // Random IDs
  assertEquals(isValidSessionId('abcDEF12'), true);
  assertEquals(isValidSessionId('ABCDEF'), true);
  assertEquals(isValidSessionId('1234567890123456'), true);

  // Named IDs
  assertEquals(isValidSessionId('mizchi/bit-relay'), true);
  assertEquals(isValidSessionId('user.name/repo_name'), true);
  assertEquals(isValidSessionId('a/b'), true);

  // Invalid
  assertEquals(isValidSessionId(''), false);
  assertEquals(isValidSessionId('abc'), false); // too short for random
  assertEquals(isValidSessionId('/repo'), false); // no owner
  assertEquals(isValidSessionId('owner/'), false); // no repo
  assertEquals(isValidSessionId('a//b'), false); // double slash
});
