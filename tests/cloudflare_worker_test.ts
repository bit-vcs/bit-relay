import { assertEquals } from '@std/assert';
import worker from '../src/cloudflare_worker.ts';

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
