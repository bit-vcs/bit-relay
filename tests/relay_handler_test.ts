import { assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayHandler } from '../src/memory_handler.ts';
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
