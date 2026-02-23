import { assertEquals, assertObjectMatch } from '@std/assert';
import { createMemoryRelayHandler, createMemoryRelayService } from '../src/memory_handler.ts';
import { base64UrlEncode, buildReviewSigningMessage, signEd25519 } from '../src/signing.ts';

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

async function signedReviewRequest(args: {
  signer: TestSigner;
  sender: string;
  room: string;
  prId: string;
  verdict: string;
  nonce?: string;
  ts?: number;
  roomToken?: string;
  authToken?: string;
}): Promise<Request> {
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  const nonce = args.nonce ?? crypto.randomUUID();
  const message = buildReviewSigningMessage({
    sender: args.sender,
    room: args.room,
    prId: args.prId,
    verdict: args.verdict,
    ts,
    nonce,
  });
  const signature = await signEd25519(args.signer.privateKey, message);

  const url = new URL('http://relay.local/api/v1/review');
  url.searchParams.set('room', args.room);
  url.searchParams.set('sender', args.sender);
  url.searchParams.set('pr_id', args.prId);
  url.searchParams.set('verdict', args.verdict);
  if (args.roomToken) {
    url.searchParams.set('room_token', args.roomToken);
  }

  const headers: Record<string, string> = {
    'x-relay-public-key': args.signer.publicKey,
    'x-relay-signature': signature,
    'x-relay-timestamp': String(ts),
    'x-relay-nonce': nonce,
  };
  if (args.authToken) {
    headers['authorization'] = `Bearer ${args.authToken}`;
  }

  return new Request(url.toString(), {
    method: 'POST',
    headers,
  });
}

function reviewGetRequest(args: {
  room: string;
  prId: string;
  roomToken?: string;
  authToken?: string;
}): Request {
  const url = new URL('http://relay.local/api/v1/review');
  url.searchParams.set('room', args.room);
  url.searchParams.set('pr_id', args.prId);
  if (args.roomToken) {
    url.searchParams.set('room_token', args.roomToken);
  }
  const headers: Record<string, string> = {};
  if (args.authToken) {
    headers['authorization'] = `Bearer ${args.authToken}`;
  }
  return new Request(url.toString(), { method: 'GET', headers });
}

// --- Basic flow tests ---

Deno.test('review: approve vote is recorded and retrievable', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();

  const postRes = await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'myrepo',
      prId: 'pr-1',
      verdict: 'approve',
    }),
  );
  assertEquals(postRes.status, 200);
  const postBody = await postRes.json();
  assertObjectMatch(postBody, {
    ok: true,
    room: 'myrepo',
    pr_id: 'pr-1',
    sender: 'alice',
    verdict: 'approve',
    event: 'submitted',
    resolved: true,
    approve_count: 1,
    deny_count: 0,
  });

  const getRes = await handler(reviewGetRequest({ room: 'myrepo', prId: 'pr-1' }));
  assertEquals(getRes.status, 200);
  const getBody = await getRes.json();
  assertObjectMatch(getBody, {
    ok: true,
    room: 'myrepo',
    pr_id: 'pr-1',
    resolved: true,
    approve_count: 1,
    deny_count: 0,
  });
  assertEquals(getBody.reviews.length, 1);
  assertEquals(getBody.reviews[0].sender, 'alice');
  assertEquals(getBody.reviews[0].verdict, 'approve');
});

Deno.test('review: deny vote is recorded', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();

  const postRes = await handler(
    await signedReviewRequest({
      signer,
      sender: 'bob',
      room: 'myrepo',
      prId: 'pr-2',
      verdict: 'deny',
    }),
  );
  assertEquals(postRes.status, 200);
  const postBody = await postRes.json();
  assertObjectMatch(postBody, {
    ok: true,
    verdict: 'deny',
    event: 'submitted',
    resolved: false,
    approve_count: 0,
    deny_count: 1,
  });
});

Deno.test('review: same sender can overwrite vote', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();

  await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'myrepo',
      prId: 'pr-3',
      verdict: 'deny',
    }),
  );

  const updateRes = await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'myrepo',
      prId: 'pr-3',
      verdict: 'approve',
    }),
  );
  assertEquals(updateRes.status, 200);
  const body = await updateRes.json();
  assertObjectMatch(body, {
    ok: true,
    event: 'updated',
    verdict: 'approve',
    resolved: true,
    approve_count: 1,
    deny_count: 0,
  });

  const getRes = await handler(reviewGetRequest({ room: 'myrepo', prId: 'pr-3' }));
  const getBody = await getRes.json();
  assertEquals(getBody.reviews.length, 1);
  assertEquals(getBody.reviews[0].verdict, 'approve');
});

// --- Threshold tests ---

Deno.test('review: 1 approve + 1 deny → resolved (50%)', async () => {
  const handler = createMemoryRelayHandler({});
  const signerA = await createSigner();
  const signerB = await createSigner();

  await handler(
    await signedReviewRequest({
      signer: signerA,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-t1',
      verdict: 'approve',
    }),
  );
  await handler(
    await signedReviewRequest({
      signer: signerB,
      sender: 'bob',
      room: 'repo',
      prId: 'pr-t1',
      verdict: 'deny',
    }),
  );

  const getRes = await handler(reviewGetRequest({ room: 'repo', prId: 'pr-t1' }));
  const body = await getRes.json();
  assertEquals(body.resolved, true);
  assertEquals(body.approve_count, 1);
  assertEquals(body.deny_count, 1);
});

Deno.test('review: 1 approve + 2 deny → unresolved', async () => {
  const handler = createMemoryRelayHandler({});
  const signerA = await createSigner();
  const signerB = await createSigner();
  const signerC = await createSigner();

  await handler(
    await signedReviewRequest({
      signer: signerA,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-t2',
      verdict: 'approve',
    }),
  );
  await handler(
    await signedReviewRequest({
      signer: signerB,
      sender: 'bob',
      room: 'repo',
      prId: 'pr-t2',
      verdict: 'deny',
    }),
  );
  await handler(
    await signedReviewRequest({
      signer: signerC,
      sender: 'carol',
      room: 'repo',
      prId: 'pr-t2',
      verdict: 'deny',
    }),
  );

  const getRes = await handler(reviewGetRequest({ room: 'repo', prId: 'pr-t2' }));
  const body = await getRes.json();
  assertEquals(body.resolved, false);
  assertEquals(body.approve_count, 1);
  assertEquals(body.deny_count, 2);
});

Deno.test('review: 2 approve + 1 deny → resolved', async () => {
  const handler = createMemoryRelayHandler({});
  const signerA = await createSigner();
  const signerB = await createSigner();
  const signerC = await createSigner();

  await handler(
    await signedReviewRequest({
      signer: signerA,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-t3',
      verdict: 'approve',
    }),
  );
  await handler(
    await signedReviewRequest({
      signer: signerB,
      sender: 'bob',
      room: 'repo',
      prId: 'pr-t3',
      verdict: 'approve',
    }),
  );
  await handler(
    await signedReviewRequest({
      signer: signerC,
      sender: 'carol',
      room: 'repo',
      prId: 'pr-t3',
      verdict: 'deny',
    }),
  );

  const getRes = await handler(reviewGetRequest({ room: 'repo', prId: 'pr-t3' }));
  const body = await getRes.json();
  assertEquals(body.resolved, true);
  assertEquals(body.approve_count, 2);
  assertEquals(body.deny_count, 1);
});

Deno.test('review: no votes → unresolved with empty reviews', async () => {
  const handler = createMemoryRelayHandler({});

  const getRes = await handler(reviewGetRequest({ room: 'repo', prId: 'pr-none' }));
  assertEquals(getRes.status, 200);
  const body = await getRes.json();
  assertEquals(body.resolved, false);
  assertEquals(body.approve_count, 0);
  assertEquals(body.deny_count, 0);
  assertEquals(body.reviews.length, 0);
});

// --- Validation tests ---

Deno.test('review: missing sender returns 400', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const message = buildReviewSigningMessage({
    sender: '',
    room: 'repo',
    prId: 'pr-1',
    verdict: 'approve',
    ts,
    nonce,
  });
  const signature = await signEd25519(signer.privateKey, message);

  const res = await handler(
    new Request(
      'http://relay.local/api/v1/review?room=repo&pr_id=pr-1&verdict=approve',
      {
        method: 'POST',
        headers: {
          'x-relay-public-key': signer.publicKey,
          'x-relay-signature': signature,
          'x-relay-timestamp': String(ts),
          'x-relay-nonce': nonce,
        },
      },
    ),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'missing query: sender');
});

Deno.test('review: missing pr_id returns 400', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const message = buildReviewSigningMessage({
    sender: 'alice',
    room: 'repo',
    prId: '',
    verdict: 'approve',
    ts,
    nonce,
  });
  const signature = await signEd25519(signer.privateKey, message);

  const res = await handler(
    new Request(
      'http://relay.local/api/v1/review?room=repo&sender=alice&verdict=approve',
      {
        method: 'POST',
        headers: {
          'x-relay-public-key': signer.publicKey,
          'x-relay-signature': signature,
          'x-relay-timestamp': String(ts),
          'x-relay-nonce': nonce,
        },
      },
    ),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'missing query: pr_id');
});

Deno.test('review: invalid verdict returns 400', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const message = buildReviewSigningMessage({
    sender: 'alice',
    room: 'repo',
    prId: 'pr-1',
    verdict: 'maybe',
    ts,
    nonce,
  });
  const signature = await signEd25519(signer.privateKey, message);

  const res = await handler(
    new Request(
      'http://relay.local/api/v1/review?room=repo&sender=alice&pr_id=pr-1&verdict=maybe',
      {
        method: 'POST',
        headers: {
          'x-relay-public-key': signer.publicKey,
          'x-relay-signature': signature,
          'x-relay-timestamp': String(ts),
          'x-relay-nonce': nonce,
        },
      },
    ),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'invalid verdict');
});

Deno.test('review: invalid pr_id format returns 400', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const message = buildReviewSigningMessage({
    sender: 'alice',
    room: 'repo',
    prId: '!invalid',
    verdict: 'approve',
    ts,
    nonce,
  });
  const signature = await signEd25519(signer.privateKey, message);

  const res = await handler(
    new Request(
      'http://relay.local/api/v1/review?room=repo&sender=alice&pr_id=!invalid&verdict=approve',
      {
        method: 'POST',
        headers: {
          'x-relay-public-key': signer.publicKey,
          'x-relay-signature': signature,
          'x-relay-timestamp': String(ts),
          'x-relay-nonce': nonce,
        },
      },
    ),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'invalid pr_id');
});

Deno.test('review: GET with missing pr_id returns 400', async () => {
  const handler = createMemoryRelayHandler({});
  const res = await handler(new Request('http://relay.local/api/v1/review?room=repo'));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'missing query: pr_id');
});

// --- Auth tests ---

Deno.test('review: POST without signature returns 401', async () => {
  const handler = createMemoryRelayHandler({ requireSignatures: false });
  const res = await handler(
    new Request(
      'http://relay.local/api/v1/review?room=repo&sender=alice&pr_id=pr-1&verdict=approve',
      { method: 'POST' },
    ),
  );
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, 'missing signature headers');
});

Deno.test('review: POST with invalid signature returns 401', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();
  const wrongSigner = await createSigner();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  // Sign with wrong key
  const message = buildReviewSigningMessage({
    sender: 'alice',
    room: 'repo',
    prId: 'pr-1',
    verdict: 'approve',
    ts,
    nonce,
  });
  const signature = await signEd25519(wrongSigner.privateKey, message);

  const res = await handler(
    new Request(
      'http://relay.local/api/v1/review?room=repo&sender=alice&pr_id=pr-1&verdict=approve',
      {
        method: 'POST',
        headers: {
          'x-relay-public-key': signer.publicKey,
          'x-relay-signature': signature,
          'x-relay-timestamp': String(ts),
          'x-relay-nonce': nonce,
        },
      },
    ),
  );
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, 'invalid signature');
});

Deno.test('review: TOFU mismatch returns 409', async () => {
  const handler = createMemoryRelayHandler({});
  const signerA = await createSigner();
  const signerB = await createSigner();

  // First request establishes TOFU
  await handler(
    await signedReviewRequest({
      signer: signerA,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-tofu',
      verdict: 'approve',
    }),
  );

  // Second request with different key for same sender
  const res = await handler(
    await signedReviewRequest({
      signer: signerB,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-tofu2',
      verdict: 'approve',
    }),
  );
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, 'sender key mismatch');
});

Deno.test('review: nonce replay returns 409', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();
  const fixedNonce = crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000);

  await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-nonce',
      verdict: 'approve',
      nonce: fixedNonce,
      ts,
    }),
  );

  const res = await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-nonce',
      verdict: 'deny',
      nonce: fixedNonce,
      ts,
    }),
  );
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, 'replayed nonce');
});

// --- Room token tests ---

Deno.test('review: POST without room token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    roomTokens: { repo: 'secret-token' },
  });
  const signer = await createSigner();

  const res = await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-rt',
      verdict: 'approve',
    }),
  );
  assertEquals(res.status, 403);
});

Deno.test('review: POST with valid room token succeeds', async () => {
  const handler = createMemoryRelayHandler({
    roomTokens: { repo: 'secret-token' },
  });
  const signer = await createSigner();

  const res = await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-rt2',
      verdict: 'approve',
      roomToken: 'secret-token',
    }),
  );
  assertEquals(res.status, 200);
});

Deno.test('review: GET without room token returns 403', async () => {
  const handler = createMemoryRelayHandler({
    roomTokens: { repo: 'secret-token' },
  });

  const res = await handler(reviewGetRequest({ room: 'repo', prId: 'pr-rt3' }));
  assertEquals(res.status, 403);
});

// --- Auth token tests ---

Deno.test('review: POST without auth token returns 401 when authToken set', async () => {
  const handler = createMemoryRelayHandler({ authToken: 'cluster-secret' });
  const signer = await createSigner();

  const res = await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-at',
      verdict: 'approve',
    }),
  );
  assertEquals(res.status, 401);
});

Deno.test('review: POST with valid auth token succeeds', async () => {
  const handler = createMemoryRelayHandler({ authToken: 'cluster-secret' });
  const signer = await createSigner();

  const res = await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-at2',
      verdict: 'approve',
      authToken: 'cluster-secret',
    }),
  );
  assertEquals(res.status, 200);
});

// --- Snapshot/restore tests ---

Deno.test('review: snapshot includes review data', async () => {
  const service = createMemoryRelayService({});
  const signer = await createSigner();

  await service.fetch(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'myrepo',
      prId: 'pr-snap',
      verdict: 'approve',
    }),
  );

  const snap = service.snapshot();
  const roomSnap = snap.rooms['myrepo'];
  assertEquals(Array.isArray(roomSnap.reviews), true);
  assertEquals(roomSnap.reviews!.length, 1);
  assertObjectMatch(roomSnap.reviews![0], {
    sender: 'alice',
    verdict: 'approve',
    pr_id: 'pr-snap',
  });
  service.close();
});

Deno.test('review: restore recovers review data', async () => {
  const service1 = createMemoryRelayService({});
  const signer = await createSigner();

  await service1.fetch(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'myrepo',
      prId: 'pr-restore',
      verdict: 'approve',
    }),
  );

  const snap = service1.snapshot();
  service1.close();

  const service2 = createMemoryRelayService({});
  service2.restore(snap);

  const getRes = await service2.fetch(reviewGetRequest({ room: 'myrepo', prId: 'pr-restore' }));
  assertEquals(getRes.status, 200);
  const body = await getRes.json();
  assertEquals(body.resolved, true);
  assertEquals(body.approve_count, 1);
  assertEquals(body.reviews.length, 1);
  assertEquals(body.reviews[0].sender, 'alice');
  assertEquals(body.reviews[0].verdict, 'approve');
  service2.close();
});

Deno.test('review: restore skips invalid verdict', () => {
  const service = createMemoryRelayService({});
  service.restore({
    rooms: {
      myrepo: {
        messages: [],
        acks_by_consumer: {},
        reviews: [
          {
            sender: 'alice',
            verdict: 'maybe',
            pr_id: 'pr-bad',
            submitted_at: 1000,
            updated_at: 1000,
          },
        ],
      },
    },
    keys_by_sender: {},
    nonces_by_sender: {},
  });

  const snap = service.snapshot();
  const roomSnap = snap.rooms['myrepo'];
  assertEquals(roomSnap.reviews, undefined);
  service.close();
});

// --- Method not allowed ---

Deno.test('review: PUT returns 405', async () => {
  const handler = createMemoryRelayHandler({});
  const res = await handler(
    new Request(
      'http://relay.local/api/v1/review?room=repo&pr_id=pr-1',
      { method: 'PUT' },
    ),
  );
  assertEquals(res.status, 405);
});

// --- Multiple PRs in same room ---

Deno.test('review: multiple PRs tracked independently', async () => {
  const handler = createMemoryRelayHandler({});
  const signer = await createSigner();

  await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-a',
      verdict: 'approve',
    }),
  );
  await handler(
    await signedReviewRequest({
      signer,
      sender: 'alice',
      room: 'repo',
      prId: 'pr-b',
      verdict: 'deny',
    }),
  );

  const getA = await handler(reviewGetRequest({ room: 'repo', prId: 'pr-a' }));
  const bodyA = await getA.json();
  assertEquals(bodyA.resolved, true);
  assertEquals(bodyA.approve_count, 1);

  const getB = await handler(reviewGetRequest({ room: 'repo', prId: 'pr-b' }));
  const bodyB = await getB.json();
  assertEquals(bodyB.resolved, false);
  assertEquals(bodyB.deny_count, 1);
});
