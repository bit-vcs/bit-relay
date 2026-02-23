import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { authHeaders, BASE_URL, RUN_ID } from '../config.js';
import { uuid } from '../helpers.js';

const publishLatency = new Trend('publish_latency', true);
const pollLatency = new Trend('poll_latency', true);
const publishAccepted = new Counter('publish_accepted');
const publishRejected = new Counter('publish_rejected');

// All VUs share a single room — this stresses Durable Object serialization
const SHARED_ROOM = `bench-${RUN_ID}-contention`;

export const options = {
  scenarios: {
    contention: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '15s', target: 50 },
        { duration: '15s', target: 100 },
        { duration: '15s', target: 200 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    publish_latency: ['p(95)<2000'],
    poll_latency: ['p(95)<1000'],
    http_req_failed: ['rate<0.10'],
  },
};

export default function () {
  const vuId = __VU;
  // Each VU still has its own sender to avoid rate limits
  const sender = `bench-contention-vu${vuId}`;
  const headers = authHeaders();
  const msgId = uuid();

  // Publish to shared room
  const publishRes = http.post(
    `${BASE_URL}/api/v1/publish?room=${SHARED_ROOM}&sender=${sender}&id=${msgId}`,
    JSON.stringify({ kind: 'bench.contention', vu: vuId, ts: Date.now() }),
    { headers },
  );

  publishLatency.add(publishRes.timings.duration);

  const ok = check(publishRes, {
    'publish status 200': (r) => r.status === 200,
  });

  if (ok) {
    const body = publishRes.json();
    if (body.accepted) {
      publishAccepted.add(1);
    } else {
      publishRejected.add(1);
    }
  }

  // Poll from shared room
  const pollRes = http.get(
    `${BASE_URL}/api/v1/poll?room=${SHARED_ROOM}&limit=10`,
    { headers },
  );

  pollLatency.add(pollRes.timings.duration);

  check(pollRes, {
    'poll status 200': (r) => r.status === 200,
  });

  sleep(2);
}
