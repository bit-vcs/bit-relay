import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import { BASE_URL, authHeaders } from "../config.js";
import { roomName, senderName, uuid } from "../helpers.js";

const publishLatency = new Trend("publish_latency", true);
const pollLatency = new Trend("poll_latency", true);
const publishAccepted = new Counter("publish_accepted");

export const options = {
  scenarios: {
    publish_poll: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 10 },
        { duration: "15s", target: 50 },
        { duration: "15s", target: 100 },
        { duration: "15s", target: 200 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    publish_latency: ["p(95)<500"],
    poll_latency: ["p(95)<300"],
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  const vuId = __VU;
  const room = roomName("pubpoll", vuId);
  const sender = senderName("pubpoll", vuId);
  const headers = authHeaders();
  const msgId = uuid();

  // Publish
  const publishRes = http.post(
    `${BASE_URL}/api/v1/publish?room=${room}&sender=${sender}&id=${msgId}`,
    JSON.stringify({ kind: "bench.ping", ts: Date.now() }),
    { headers },
  );

  publishLatency.add(publishRes.timings.duration);

  const publishOk = check(publishRes, {
    "publish status 200": (r) => r.status === 200,
    "publish accepted": (r) => {
      const body = r.json();
      return body.ok === true && body.accepted === true;
    },
  });

  if (publishOk) {
    publishAccepted.add(1);
  }

  // Poll
  const pollRes = http.get(
    `${BASE_URL}/api/v1/poll?room=${room}&limit=10`,
    { headers },
  );

  pollLatency.add(pollRes.timings.duration);

  check(pollRes, {
    "poll status 200": (r) => r.status === 200,
    "poll has envelopes": (r) => {
      const body = r.json();
      return body.ok === true && Array.isArray(body.envelopes);
    },
  });

  // Sleep to stay within rate limits (30 publish/60s/sender)
  sleep(2);
}
