import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";
import { BASE_URL, RUN_ID, authHeaders } from "../config.js";

const heartbeatLatency = new Trend("heartbeat_latency", true);
const presenceListLatency = new Trend("presence_list_latency", true);
const presenceDeleteLatency = new Trend("presence_delete_latency", true);

// 5 shared rooms for realistic multi-participant presence
const ROOM_POOL_SIZE = 5;

function sharedRoom(vuId) {
  const idx = vuId % ROOM_POOL_SIZE;
  return `bench-${RUN_ID}-presence-room${idx}`;
}

export const options = {
  scenarios: {
    presence: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 10 },
        { duration: "15s", target: 50 },
        { duration: "15s", target: 100 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    heartbeat_latency: ["p(95)<300"],
    presence_list_latency: ["p(95)<500"],
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  const vuId = __VU;
  const room = sharedRoom(vuId);
  const participant = `bench-participant-vu${vuId}`;
  const headers = authHeaders();

  // Heartbeat
  const heartbeatRes = http.post(
    `${BASE_URL}/api/v1/presence/heartbeat?room=${room}&participant=${participant}`,
    JSON.stringify({ status: "online", metadata: { vu: vuId } }),
    { headers },
  );

  heartbeatLatency.add(heartbeatRes.timings.duration);

  check(heartbeatRes, {
    "heartbeat status 200": (r) => r.status === 200,
    "heartbeat ok": (r) => r.json().ok === true,
  });

  // List presence
  const listRes = http.get(
    `${BASE_URL}/api/v1/presence?room=${room}`,
    { headers },
  );

  presenceListLatency.add(listRes.timings.duration);

  check(listRes, {
    "presence list 200": (r) => r.status === 200,
    "presence has participants": (r) => {
      const body = r.json();
      return body.ok === true && Array.isArray(body.participants);
    },
  });

  // Delete presence (cleanup)
  const deleteRes = http.del(
    `${BASE_URL}/api/v1/presence?room=${room}&participant=${participant}`,
    null,
    { headers },
  );

  presenceDeleteLatency.add(deleteRes.timings.duration);

  check(deleteRes, {
    "presence delete 200": (r) => r.status === 200,
  });

  sleep(1);
}
