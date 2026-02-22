import { assertEquals } from '@std/assert';
import { createMemoryRelayService, type MemoryRelayOptions } from '../src/memory_handler.ts';

const BASE = 'http://localhost';

function createService(opts: MemoryRelayOptions = {}) {
  return createMemoryRelayService({ requireSignatures: false, ...opts });
}

function heartbeatUrl(room: string, participant: string): string {
  return `${BASE}/api/v1/presence/heartbeat?room=${room}&participant=${participant}`;
}

function presenceUrl(room: string, participant?: string): string {
  const base = `${BASE}/api/v1/presence?room=${room}`;
  return participant ? `${base}&participant=${participant}` : base;
}

async function heartbeat(
  service: ReturnType<typeof createService>,
  room: string,
  participant: string,
  body?: { status?: string; metadata?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method: 'POST' };
  if (body) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await service.fetch(new Request(heartbeatUrl(room, participant), init));
  return { status: res.status, body: await res.json() };
}

async function getPresence(
  service: ReturnType<typeof createService>,
  room: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await service.fetch(new Request(presenceUrl(room), { method: 'GET' }));
  return { status: res.status, body: await res.json() };
}

async function deletePresence(
  service: ReturnType<typeof createService>,
  room: string,
  participant: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await service.fetch(
    new Request(presenceUrl(room, participant), { method: 'DELETE' }),
  );
  return { status: res.status, body: await res.json() };
}

Deno.test('heartbeat creates presence record', async () => {
  const service = createService();
  const result = await heartbeat(service, 'main', 'agent-1');
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals(result.body.participant, 'agent-1');
  assertEquals(result.body.event, 'joined');

  const list = await getPresence(service, 'main');
  assertEquals(list.status, 200);
  const participants = list.body.participants as Array<Record<string, unknown>>;
  assertEquals(participants.length, 1);
  assertEquals(participants[0].participant_id, 'agent-1');
  assertEquals(participants[0].status, 'online');
});

Deno.test('heartbeat updates status', async () => {
  const service = createService();
  await heartbeat(service, 'main', 'agent-1');

  const update = await heartbeat(service, 'main', 'agent-1', { status: 'busy' });
  assertEquals(update.status, 200);
  assertEquals(update.body.event, 'updated');

  const list = await getPresence(service, 'main');
  const participants = list.body.participants as Array<Record<string, unknown>>;
  assertEquals(participants.length, 1);
  assertEquals(participants[0].status, 'busy');
});

Deno.test('GET presence returns all participants', async () => {
  const service = createService();
  await heartbeat(service, 'main', 'agent-1');
  await heartbeat(service, 'main', 'agent-2', { status: 'coding', metadata: { file: 'main.ts' } });
  await heartbeat(service, 'main', 'agent-3');

  const list = await getPresence(service, 'main');
  assertEquals(list.status, 200);
  const participants = list.body.participants as Array<Record<string, unknown>>;
  assertEquals(participants.length, 3);
  const ids = participants.map((p) => p.participant_id).sort();
  assertEquals(ids, ['agent-1', 'agent-2', 'agent-3']);

  const agent2 = participants.find((p) => p.participant_id === 'agent-2')!;
  assertEquals(agent2.status, 'coding');
  assertEquals(agent2.metadata, { file: 'main.ts' });
});

Deno.test('TTL expiry prunes stale presence', async () => {
  const service = createService({ presenceTtlSec: 1 });
  await heartbeat(service, 'main', 'agent-1');

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, 1200));

  const list = await getPresence(service, 'main');
  const participants = list.body.participants as Array<Record<string, unknown>>;
  assertEquals(participants.length, 0);
});

Deno.test('DELETE removes participant', async () => {
  const service = createService();
  await heartbeat(service, 'main', 'agent-1');
  await heartbeat(service, 'main', 'agent-2');

  const del = await deletePresence(service, 'main', 'agent-1');
  assertEquals(del.status, 200);
  assertEquals(del.body.ok, true);
  assertEquals(del.body.removed, true);

  const list = await getPresence(service, 'main');
  const participants = list.body.participants as Array<Record<string, unknown>>;
  assertEquals(participants.length, 1);
  assertEquals(participants[0].participant_id, 'agent-2');
});

Deno.test('DELETE non-existent participant returns removed: false', async () => {
  const service = createService();
  const del = await deletePresence(service, 'main', 'ghost');
  assertEquals(del.status, 200);
  assertEquals(del.body.removed, false);
});

Deno.test('missing participant query returns 400', async () => {
  const service = createService();

  // heartbeat without participant
  const res1 = await service.fetch(
    new Request(`${BASE}/api/v1/presence/heartbeat?room=main`, { method: 'POST' }),
  );
  assertEquals(res1.status, 400);

  // DELETE without participant
  const res2 = await service.fetch(
    new Request(`${BASE}/api/v1/presence?room=main`, { method: 'DELETE' }),
  );
  assertEquals(res2.status, 400);
});

Deno.test('snapshot includes presence', async () => {
  const service = createService();
  await heartbeat(service, 'main', 'agent-1', { status: 'coding', metadata: { task: 'refactor' } });
  await heartbeat(service, 'main', 'agent-2');

  const snap = service.snapshot();
  const roomSnap = snap.rooms['main'];
  assertEquals(roomSnap.presence !== undefined, true);
  assertEquals(roomSnap.presence!.length, 2);
  const ids = roomSnap.presence!.map((p) => p.participant_id).sort();
  assertEquals(ids, ['agent-1', 'agent-2']);

  const a1 = roomSnap.presence!.find((p) => p.participant_id === 'agent-1')!;
  assertEquals(a1.status, 'coding');
  assertEquals(a1.metadata, { task: 'refactor' });
});

Deno.test('restore recovers presence', async () => {
  const service1 = createService();
  await heartbeat(service1, 'main', 'agent-1', { status: 'coding' });
  await heartbeat(service1, 'main', 'agent-2');
  const snap = service1.snapshot();

  const service2 = createService();
  service2.restore(snap);

  const list = await getPresence(service2, 'main');
  const participants = list.body.participants as Array<Record<string, unknown>>;
  assertEquals(participants.length, 2);
  const ids = participants.map((p) => p.participant_id).sort();
  assertEquals(ids, ['agent-1', 'agent-2']);
});

Deno.test('restore prunes stale presence records', async () => {
  const service1 = createService();
  await heartbeat(service1, 'main', 'agent-1');
  const snap = service1.snapshot();

  // Wait, then restore with short TTL
  await new Promise((r) => setTimeout(r, 1200));

  const service2 = createService({ presenceTtlSec: 1 });
  service2.restore(snap);

  const list = await getPresence(service2, 'main');
  const participants = list.body.participants as Array<Record<string, unknown>>;
  assertEquals(participants.length, 0);
});

Deno.test('rooms without presence have no presence key in snapshot', async () => {
  const service = createService();
  // Publish a message to create the room but no presence
  await service.fetch(
    new Request(`${BASE}/api/v1/publish?room=main&sender=s1&id=m1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    }),
  );
  const snap = service.snapshot();
  assertEquals(snap.rooms['main'].presence, undefined);
});
