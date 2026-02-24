import { assertEquals } from '@std/assert';
import { createIssueSyncEngine } from '../src/issue_sync_engine.ts';

Deno.test('issue sync engine applies mapped delivery and deduplicates by delivery_id', async () => {
  const engine = createIssueSyncEngine({ nowSec: () => 100 });
  const published: Array<{ room: string; topic: string; issueId: string; action: string }> = [];

  const first = await engine.applyDelivery({
    event: 'issues',
    deliveryId: 'd-1',
    requestBody: JSON.stringify({ action: 'opened' }),
    map(input) {
      return {
        ok: true,
        mapped: {
          room: 'acme-api',
          sender: 'github:octocat',
          topic: 'issue',
          issueId: 'acme/api#1',
          action: 'opened',
          envelopeId: `gh-${input.deliveryId}`,
          payload: { event: input.event },
        },
      };
    },
    async publish(mapped) {
      published.push({
        room: mapped.room,
        topic: mapped.topic,
        issueId: mapped.issueId,
        action: mapped.action,
      });
      return { status: 200, accepted: true, cursor: 1 };
    },
  });

  assertEquals(first.ok, true);
  if (first.ok) {
    assertEquals(first.accepted, true);
    assertEquals(first.duplicate, false);
    assertEquals(first.deliveryId, 'd-1');
    assertEquals(first.topic, 'issue');
    assertEquals(first.room, 'acme-api');
    assertEquals(first.issueId, 'acme/api#1');
    assertEquals(first.cursor, 1);
  }

  const second = await engine.applyDelivery({
    event: 'issues',
    deliveryId: 'd-1',
    requestBody: JSON.stringify({ action: 'opened' }),
    map() {
      return { ok: false, error: 'should not be called for duplicate' };
    },
    async publish() {
      return { status: 200, accepted: true, cursor: 99 };
    },
  });

  assertEquals(second.ok, true);
  if (second.ok) {
    assertEquals(second.accepted, false);
    assertEquals(second.duplicate, true);
    assertEquals(second.topic, null);
  }
  assertEquals(published.length, 1);
});

Deno.test('issue sync engine handles invalid payload and DLQ lifecycle', async () => {
  const nowValues = [200, 201, 202, 203];
  const engine = createIssueSyncEngine({ nowSec: () => nowValues.shift() ?? 203 });

  const invalid = await engine.applyDelivery({
    event: 'issues',
    deliveryId: 'd-invalid',
    requestBody: '{broken',
    map() {
      return { ok: false, error: 'unreachable' };
    },
    async publish() {
      return { status: 200, accepted: true, cursor: 1 };
    },
  });
  assertEquals(invalid.ok, false);
  if (!invalid.ok) {
    assertEquals(invalid.error, 'invalid json payload');
  }

  const queued = engine.enqueueDlq({
    deliveryId: 'd-dlq',
    event: 'issues',
    body: '{"action":"opened"}',
    error: 'unsupported event',
    incrementRetry: false,
  });
  assertEquals(queued.retry_count, 0);
  assertEquals(queued.next_retry_at, 230);

  const retried = engine.enqueueDlq({
    deliveryId: 'd-dlq',
    event: 'issues',
    body: '{"action":"opened"}',
    error: 'still failing',
    incrementRetry: true,
  });
  assertEquals(retried.retry_count, 1);
  assertEquals(retried.next_retry_at, 261);

  const listed = engine.listDlq(0, 10);
  assertEquals(listed.entries.length, 1);
  assertEquals(listed.entries[0].delivery_id, 'd-dlq');
  assertEquals(listed.entries[0].last_error, 'still failing');

  engine.removeDlq('d-dlq');
  const afterRemove = engine.listDlq(0, 10);
  assertEquals(afterRemove.entries.length, 0);
});

Deno.test('issue sync engine snapshot/restore keeps delivery and dlq state', async () => {
  const engine = createIssueSyncEngine({ nowSec: () => 300 });

  await engine.applyDelivery({
    event: 'issues',
    deliveryId: 'd-keep',
    requestBody: '{"action":"opened"}',
    map(input) {
      return {
        ok: true,
        mapped: {
          room: 'main',
          sender: 'github:webhook',
          topic: 'issue',
          issueId: `delivery:${input.deliveryId}`,
          action: 'opened',
          envelopeId: `gh-${input.deliveryId}`,
          payload: { source: 'github' },
        },
      };
    },
    async publish() {
      return { status: 200, accepted: true, cursor: 1 };
    },
  });

  engine.enqueueDlq({
    deliveryId: 'd-dlq',
    event: 'fork',
    body: '{}',
    error: 'unsupported',
    incrementRetry: false,
  });

  const snapshot = engine.snapshot();

  const restored = createIssueSyncEngine({ nowSec: () => 400 });
  restored.restore(snapshot);

  assertEquals(restored.hasDeliveryId('d-keep'), true);
  const listed = restored.listDlq(0, 10);
  assertEquals(listed.entries.length, 1);
  assertEquals(listed.entries[0].delivery_id, 'd-dlq');
  assertEquals(listed.entries[0].event, 'fork');
});
