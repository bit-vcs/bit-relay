import { assertEquals } from '@std/assert';
import worker from '../src/cloudflare_worker.ts';
import { createMemoryRelayService } from '../src/memory_handler.ts';

interface TestDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface TestDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): TestDurableObjectStub;
}

function createRelayRoomNamespaceRecorder(): {
  namespace: TestDurableObjectNamespace;
  roomNames: string[];
} {
  const roomNames: string[] = [];
  const namespace: TestDurableObjectNamespace = {
    idFromName(name: string): unknown {
      roomNames.push(name);
      return name;
    },
    get(id: unknown): TestDurableObjectStub {
      const room = String(id);
      return {
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url);
          return Response.json({
            ok: true,
            room,
            path: url.pathname,
          });
        },
      };
    },
  };
  return { namespace, roomNames };
}

Deno.test('cloudflare worker routes trigger callback to room derived from body when query room is absent', async () => {
  const recorded = createRelayRoomNamespaceRecorder();
  const response = await worker.fetch(
    new Request('https://relay.example/api/v1/trigger/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        room: 'release-smoke',
        ref: 'refs/relay/incoming/release-smoke',
        status: 'success',
      }),
    }),
    {
      RELAY_ROOM: recorded.namespace as never,
    },
  );

  assertEquals(response.status, 200);
  assertEquals(recorded.roomNames.length, 1);
  assertEquals(recorded.roomNames[0], 'release-smoke');
});

Deno.test('cloudflare worker routes trigger callback to room derived from incoming ref when body room is absent', async () => {
  const recorded = createRelayRoomNamespaceRecorder();
  const response = await worker.fetch(
    new Request('https://relay.example/api/v1/trigger/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: 'refs/relay/incoming/repo-ci/build-1',
        status: 'success',
      }),
    }),
    {
      RELAY_ROOM: recorded.namespace as never,
    },
  );

  assertEquals(response.status, 200);
  assertEquals(recorded.roomNames.length, 1);
  assertEquals(recorded.roomNames[0], 'repo-ci');
});

function createRelayRoomNamespaceWithMemoryServices(): TestDurableObjectNamespace {
  const services = new Map<string, ReturnType<typeof createMemoryRelayService>>();
  const resolveService = (room: string): ReturnType<typeof createMemoryRelayService> => {
    let service = services.get(room);
    if (!service) {
      service = createMemoryRelayService({ requireSignatures: false } as any);
      services.set(room, service);
    }
    return service;
  };
  return {
    idFromName(name: string): unknown {
      return name;
    },
    get(id: unknown): TestDurableObjectStub {
      const room = String(id);
      const service = resolveService(room);
      return {
        async fetch(request: Request): Promise<Response> {
          return await service.fetch(request);
        },
      };
    },
  };
}

Deno.test('cloudflare worker routes cache exchange push to entry room when query room is absent', async () => {
  const namespace = createRelayRoomNamespaceWithMemoryServices();
  const room = 'cache-room-a';
  const id = 'cache-room-entry-1';

  const pushRes = await worker.fetch(
    new Request('https://relay.example/api/v1/cache/exchange/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: [
          {
            room,
            id,
            sender: 'relay-b',
            topic: 'notify',
            payload: { value: 1 },
            signature: null,
            origin: 'relay-b',
            hop_count: 0,
            max_hops: 4,
          },
        ],
      }),
    }),
    {
      RELAY_ROOM: namespace as never,
    },
  );
  assertEquals(pushRes.status, 200);

  const pollRes = await worker.fetch(
    new Request(`https://relay.example/api/v1/poll?room=${room}&after=0&limit=10`),
    {
      RELAY_ROOM: namespace as never,
    },
  );
  assertEquals(pollRes.status, 200);
  const pollBody = await pollRes.json() as { envelopes: Array<{ id: string }> };
  assertEquals(pollBody.envelopes.length, 1);
  assertEquals(pollBody.envelopes[0].id, id);
});
