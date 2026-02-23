import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { authHeaders, BASE_URL } from '../config.js';
import { roomName, senderName, uuid } from '../helpers.js';

const inboxPendingLatency = new Trend('inbox_pending_latency', true);
const inboxAckLatency = new Trend('inbox_ack_latency', true);

export const options = {
  scenarios: {
    inbox: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '15s', target: 50 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    inbox_pending_latency: ['p(95)<500'],
    inbox_ack_latency: ['p(95)<500'],
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  const vuId = __VU;
  const room = roomName('inbox', vuId);
  const sender = senderName('inbox', vuId);
  const consumer = `bench-consumer-vu${vuId}`;
  const headers = authHeaders();

  // Publish a message first
  const msgId = uuid();
  const publishRes = http.post(
    `${BASE_URL}/api/v1/publish?room=${room}&sender=${sender}&id=${msgId}`,
    JSON.stringify({ kind: 'bench.inbox', iteration: __ITER }),
    { headers },
  );

  check(publishRes, {
    'inbox publish 200': (r) => r.status === 200,
  });

  // Get pending messages
  const pendingRes = http.get(
    `${BASE_URL}/api/v1/inbox/pending?room=${room}&consumer=${consumer}&limit=10`,
    { headers },
  );

  inboxPendingLatency.add(pendingRes.timings.duration);

  const pendingOk = check(pendingRes, {
    'pending status 200': (r) => r.status === 200,
    'pending has envelopes': (r) => {
      const body = r.json();
      return body.ok === true && Array.isArray(body.envelopes);
    },
  });

  // Ack the messages
  if (pendingOk) {
    const pending = pendingRes.json();
    if (pending.envelopes && pending.envelopes.length > 0) {
      const ids = pending.envelopes.map((e) => e.id);
      const ackRes = http.post(
        `${BASE_URL}/api/v1/inbox/ack?room=${room}&consumer=${consumer}`,
        JSON.stringify({ ids }),
        { headers },
      );

      inboxAckLatency.add(ackRes.timings.duration);

      check(ackRes, {
        'ack status 200': (r) => r.status === 200,
        'ack ok': (r) => r.json().ok === true,
      });
    }
  }

  // Verify pending is now empty (or reduced)
  const verifyRes = http.get(
    `${BASE_URL}/api/v1/inbox/pending?room=${room}&consumer=${consumer}&limit=10`,
    { headers },
  );

  check(verifyRes, {
    'verify pending 200': (r) => r.status === 200,
  });

  sleep(2);
}
