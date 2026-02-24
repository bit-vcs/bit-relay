import { assertEquals } from '@std/assert';
import { logRelayAudit, logRelayEvent } from '../src/relay_observability.ts';
import type { RelayEvent } from '../src/contracts.ts';

function captureLines(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    sink(line: string) {
      lines.push(line);
    },
  };
}

Deno.test('logRelayEvent emits json line for incoming_ref', () => {
  const { lines, sink } = captureLines();
  const event: RelayEvent = {
    type: 'incoming_ref',
    eventId: 'evt-1',
    occurredAt: 1_736_000_000,
    room: 'main',
    source: 'relay-a',
    ref: 'refs/relay/incoming/ci-1',
    target: 'session:abc123',
  };

  logRelayEvent(event, sink);
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assertEquals(parsed.kind, 'relay_event');
  assertEquals(parsed.type, 'incoming_ref');
  assertEquals(parsed.event_id, 'evt-1');
  assertEquals(parsed.ref, 'refs/relay/incoming/ci-1');
  assertEquals(parsed.target, 'session:abc123');
});

Deno.test('logRelayAudit emits json line', () => {
  const { lines, sink } = captureLines();
  logRelayAudit(
    {
      action: 'publish.accepted',
      occurredAt: 1_736_000_010,
      status: 200,
      room: 'main',
      sender: 'alice',
      target: '/api/v1/publish',
      id: 'm1',
      detail: { topic: 'notify' },
    },
    sink,
  );

  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assertEquals(parsed.kind, 'relay_audit');
  assertEquals(parsed.action, 'publish.accepted');
  assertEquals(parsed.room, 'main');
  assertEquals(parsed.sender, 'alice');
  assertEquals(parsed.status, 200);
  assertEquals(parsed.target, '/api/v1/publish');
  assertEquals(parsed.id, 'm1');
  const detail = parsed.detail as Record<string, unknown>;
  assertEquals(detail.topic, 'notify');
});
