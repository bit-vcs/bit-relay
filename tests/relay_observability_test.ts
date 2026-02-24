import { assertEquals } from '@std/assert';
import {
  createRelayRequestMetricRecorder,
  logRelayAudit,
  logRelayEvent,
  logRelayMetric,
} from '../src/relay_observability.ts';
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

Deno.test('logRelayMetric emits json line', () => {
  const { lines, sink } = captureLines();
  logRelayMetric(
    {
      metric: 'relay.cache.persist.retry',
      occurredAt: 1_736_000_020,
      value: 1,
      unit: 'count',
      target: 'cache.persist',
      detail: {
        retry_count: 2,
        delay_ms: 10,
      },
    },
    sink,
  );

  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assertEquals(parsed.kind, 'relay_metric');
  assertEquals(parsed.metric, 'relay.cache.persist.retry');
  assertEquals(parsed.occurred_at, 1_736_000_020);
  assertEquals(parsed.value, 1);
  assertEquals(parsed.unit, 'count');
  assertEquals(parsed.target, 'cache.persist');
  const detail = parsed.detail as Record<string, unknown>;
  assertEquals(detail.retry_count, 2);
  assertEquals(detail.delay_ms, 10);
});

Deno.test('request metric recorder tracks success rate latency and retry counts', () => {
  const { lines, sink } = captureLines();
  const recorder = createRelayRequestMetricRecorder(sink);
  const first = recorder.record({
    operation: 'POST /api/v1/publish',
    occurredAt: 1_736_000_100,
    status: 200,
    latencyMs: 40,
    retryCount: 1,
  });
  assertEquals(first.totalCount, 1);
  assertEquals(first.successCount, 1);
  assertEquals(first.failureCount, 0);
  assertEquals(first.successRate, 1);
  assertEquals(first.avgLatencyMs, 40);
  assertEquals(first.retryCountTotal, 1);

  const second = recorder.record({
    operation: 'POST /api/v1/publish',
    occurredAt: 1_736_000_101,
    status: 500,
    latencyMs: 20,
    retryCount: 2,
  });
  assertEquals(second.totalCount, 2);
  assertEquals(second.successCount, 1);
  assertEquals(second.failureCount, 1);
  assertEquals(second.successRate, 0.5);
  assertEquals(second.avgLatencyMs, 30);
  assertEquals(second.retryCountTotal, 3);

  const snapshot = recorder.snapshot('POST /api/v1/publish');
  assertEquals(snapshot.totalCount, 2);
  assertEquals(snapshot.successRate, 0.5);
  assertEquals(snapshot.avgLatencyMs, 30);
  assertEquals(snapshot.retryCountTotal, 3);

  assertEquals(lines.length, 2);
  const parsed = JSON.parse(lines[1]) as Record<string, unknown>;
  assertEquals(parsed.kind, 'relay_metric');
  assertEquals(parsed.metric, 'relay.request.success_rate');
  assertEquals(parsed.target, 'POST /api/v1/publish');
  assertEquals(parsed.unit, 'ratio');
  assertEquals(parsed.value, 0.5);
  const detail = parsed.detail as Record<string, unknown>;
  assertEquals(detail.status, 500);
  assertEquals(detail.latency_ms, 20);
  assertEquals(detail.retry_count, 2);
  assertEquals(detail.total_count, 2);
  assertEquals(detail.success_count, 1);
  assertEquals(detail.failure_count, 1);
  assertEquals(detail.average_latency_ms, 30);
  assertEquals(detail.retry_count_total, 3);
});
