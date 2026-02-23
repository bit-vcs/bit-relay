import { assertEquals } from '@std/assert';
import { createMemoryRelayService, type MemoryRelayOptions } from '../src/memory_handler.ts';
import { base64UrlEncode, buildReviewSigningMessage, signEd25519 } from '../src/signing.ts';

/**
 * publish → WebSocket broadcast の統合テスト
 *
 * 実サーバーを起動し、WebSocket で subscribe → HTTP POST で publish
 * → WebSocket クライアントが broadcast を受信するフローを検証する。
 */

const sanitize = { sanitizeOps: false, sanitizeResources: false };

function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

interface TestServer {
  port: number;
  server: Deno.HttpServer;
  service: ReturnType<typeof createMemoryRelayService>;
  close(): Promise<void>;
}

function startTestServer(opts?: MemoryRelayOptions): TestServer {
  const port = randomPort();
  const service = createMemoryRelayService({
    requireSignatures: false,
    ...opts,
  });
  const server = Deno.serve({ port, hostname: '127.0.0.1', onListen() {} }, (request) =>
    service.fetch(request));
  return {
    port,
    server,
    service,
    async close() {
      service.close();
      await server.shutdown();
    },
  };
}

function connectWs(port: number, room: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'ready') {
        resolve(ws);
      }
    };
    ws.onerror = () => reject(new Error('ws connect failed'));
    setTimeout(() => reject(new Error('ws connect timeout')), 3000);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.addEventListener('close', () => resolve(), { once: true });
    ws.close();
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wait timeout')), timeoutMs);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (predicate(data)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(data);
      }
    };
    ws.addEventListener('message', handler);
  });
}

async function publish(
  port: number,
  opts: { room: string; sender: string; topic: string; id: string; payload: unknown },
): Promise<number> {
  const url =
    `http://127.0.0.1:${port}/api/v1/publish?room=${opts.room}&sender=${opts.sender}&topic=${opts.topic}&id=${opts.id}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.payload),
  });
  await res.body?.cancel();
  return res.status;
}

// --- Tests ---

Deno.test({
  name: 'publish broadcasts to WebSocket subscriber',
  ...sanitize,
  async fn() {
    const srv = startTestServer();
    try {
      const ws = await connectWs(srv.port, 'main');
      const waiter = waitForMessage(ws, (msg) => msg.type === 'notify');

      const status = await publish(srv.port, {
        room: 'main',
        sender: 'alice',
        topic: 'notify',
        id: 'msg-1',
        payload: { kind: 'hub.record', record: 'rec-1' },
      });
      assertEquals(status, 200);

      const received = await waiter;
      assertEquals(received.type, 'notify');
      assertEquals(received.room, 'main');
      const envelope = received.envelope as Record<string, unknown>;
      assertEquals(envelope.sender, 'alice');
      assertEquals(envelope.topic, 'notify');
      assertEquals(envelope.id, 'msg-1');
      assertEquals((envelope.payload as Record<string, unknown>).kind, 'hub.record');

      await closeWs(ws);
    } finally {
      await srv.close();
    }
  },
});

Deno.test({
  name: 'issue topic publish broadcasts to subscriber',
  ...sanitize,
  async fn() {
    const srv = startTestServer();
    try {
      const ws = await connectWs(srv.port, 'myrepo');
      const waiter = waitForMessage(ws, (msg) => msg.type === 'issue');

      const status = await publish(srv.port, {
        room: 'myrepo',
        sender: 'mizchi',
        topic: 'issue',
        id: 'issue-42',
        payload: { kind: 'issue.created', title: 'fix login bug', labels: ['bug'] },
      });
      assertEquals(status, 200);

      const received = await waiter;
      assertEquals(received.type, 'issue');
      assertEquals(received.room, 'myrepo');
      const envelope = received.envelope as Record<string, unknown>;
      assertEquals(envelope.sender, 'mizchi');
      assertEquals(envelope.id, 'issue-42');
      const payload = envelope.payload as Record<string, unknown>;
      assertEquals(payload.kind, 'issue.created');
      assertEquals(payload.title, 'fix login bug');

      await closeWs(ws);
    } finally {
      await srv.close();
    }
  },
});

Deno.test({
  name: 'multiple subscribers receive broadcast',
  ...sanitize,
  async fn() {
    const srv = startTestServer();
    try {
      const ws1 = await connectWs(srv.port, 'shared');
      const ws2 = await connectWs(srv.port, 'shared');

      const waiter1 = waitForMessage(ws1, (msg) => msg.type === 'notify');
      const waiter2 = waitForMessage(ws2, (msg) => msg.type === 'notify');

      await publish(srv.port, {
        room: 'shared',
        sender: 'bot',
        topic: 'notify',
        id: 'sync-1',
        payload: { kind: 'sync.update', ref: 'main' },
      });

      const [r1, r2] = await Promise.all([waiter1, waiter2]);
      assertEquals((r1.envelope as Record<string, unknown>).id, 'sync-1');
      assertEquals((r2.envelope as Record<string, unknown>).id, 'sync-1');

      await closeWs(ws1);
      await closeWs(ws2);
    } finally {
      await srv.close();
    }
  },
});

Deno.test({
  name: 'subscriber in different room does NOT receive broadcast',
  ...sanitize,
  async fn() {
    const srv = startTestServer();
    try {
      const wsRoomA = await connectWs(srv.port, 'room-a');
      const wsRoomB = await connectWs(srv.port, 'room-b');

      const waiterA = waitForMessage(wsRoomA, (msg) => msg.type === 'notify');

      await publish(srv.port, {
        room: 'room-a',
        sender: 'alice',
        topic: 'notify',
        id: 'ra-1',
        payload: { data: 'for room-a' },
      });

      // room-a subscriber receives it
      const received = await waiterA;
      assertEquals((received.envelope as Record<string, unknown>).id, 'ra-1');

      // room-b subscriber should NOT receive it
      const gotUnexpected = await Promise.race([
        waitForMessage(wsRoomB, (msg) => msg.type === 'notify').then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      assertEquals(gotUnexpected, false);

      await closeWs(wsRoomA);
      await closeWs(wsRoomB);
    } finally {
      await srv.close();
    }
  },
});

Deno.test({
  name: 'full flow: subscribe → multiple publishes → receive in order',
  ...sanitize,
  async fn() {
    const srv = startTestServer();
    try {
      const ws = await connectWs(srv.port, 'flow-test');
      const messages: Record<string, unknown>[] = [];

      // collect 3 messages
      const allReceived = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for 3 messages')), 5000);
        ws.addEventListener('message', (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          if (data.type === 'notify' || data.type === 'issue') {
            messages.push(data);
            if (messages.length >= 3) {
              clearTimeout(timer);
              resolve();
            }
          }
        });
      });

      // publish 3 messages in sequence
      await publish(srv.port, {
        room: 'flow-test',
        sender: 'alice',
        topic: 'notify',
        id: 'step-1',
        payload: { step: 1 },
      });
      await publish(srv.port, {
        room: 'flow-test',
        sender: 'alice',
        topic: 'issue',
        id: 'step-2',
        payload: { kind: 'issue.created', title: 'new issue' },
      });
      await publish(srv.port, {
        room: 'flow-test',
        sender: 'bob',
        topic: 'notify',
        id: 'step-3',
        payload: { step: 3 },
      });

      await allReceived;

      assertEquals(messages.length, 3);
      assertEquals((messages[0].envelope as Record<string, unknown>).id, 'step-1');
      assertEquals(messages[0].type, 'notify');
      assertEquals((messages[1].envelope as Record<string, unknown>).id, 'step-2');
      assertEquals(messages[1].type, 'issue');
      assertEquals((messages[2].envelope as Record<string, unknown>).id, 'step-3');
      assertEquals((messages[2].envelope as Record<string, unknown>).sender, 'bob');

      await closeWs(ws);
    } finally {
      await srv.close();
    }
  },
});

// --- Review broadcast test ---

async function createTestSigner(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const generated = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  const keyPair = generated as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    publicKey: base64UrlEncode(publicKeyRaw),
    privateKey: keyPair.privateKey,
  };
}

async function postReview(
  port: number,
  opts: {
    room: string;
    sender: string;
    prId: string;
    verdict: string;
    signer: { publicKey: string; privateKey: CryptoKey };
  },
): Promise<number> {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const message = buildReviewSigningMessage({
    sender: opts.sender,
    room: opts.room,
    prId: opts.prId,
    verdict: opts.verdict,
    ts,
    nonce,
  });
  const signature = await signEd25519(opts.signer.privateKey, message);

  const url =
    `http://127.0.0.1:${port}/api/v1/review?room=${opts.room}&sender=${opts.sender}&pr_id=${opts.prId}&verdict=${opts.verdict}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-relay-public-key': opts.signer.publicKey,
      'x-relay-signature': signature,
      'x-relay-timestamp': String(ts),
      'x-relay-nonce': nonce,
    },
  });
  await res.body?.cancel();
  return res.status;
}

Deno.test({
  name: 'review vote broadcasts to WebSocket subscriber',
  ...sanitize,
  async fn() {
    const srv = startTestServer();
    try {
      const ws = await connectWs(srv.port, 'myrepo');
      const waiter = waitForMessage(ws, (msg) => msg.type === 'review');

      const signer = await createTestSigner();
      const status = await postReview(srv.port, {
        room: 'myrepo',
        sender: 'alice',
        prId: 'pr-1',
        verdict: 'approve',
        signer,
      });
      assertEquals(status, 200);

      const received = await waiter;
      assertEquals(received.type, 'review');
      assertEquals(received.room, 'myrepo');
      assertEquals(received.pr_id, 'pr-1');
      assertEquals(received.sender, 'alice');
      assertEquals(received.verdict, 'approve');
      assertEquals(received.event, 'submitted');
      assertEquals(received.resolved, true);
      assertEquals(received.approve_count, 1);
      assertEquals(received.deny_count, 0);

      await closeWs(ws);
    } finally {
      await srv.close();
    }
  },
});
