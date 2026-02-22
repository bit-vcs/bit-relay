import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";
import { BASE_URL, authHeaders } from "../config.js";

const registerLatency = new Trend("git_register_latency", true);
const infoLatency = new Trend("git_info_latency", true);
const pollLatency = new Trend("git_poll_latency", true);

export const options = {
  scenarios: {
    git_serve: {
      executor: "constant-vus",
      vus: 5,
      duration: "60s",
    },
  },
  thresholds: {
    git_register_latency: ["p(95)<500"],
    git_info_latency: ["p(95)<300"],
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  const headers = authHeaders();

  // Register a new session
  const registerRes = http.post(
    `${BASE_URL}/api/v1/serve/register`,
    null,
    { headers },
  );

  registerLatency.add(registerRes.timings.duration);

  const registerOk = check(registerRes, {
    "register status 200": (r) => r.status === 200,
    "register has session": (r) => {
      const body = r.json();
      return body.ok === true && body.session_id;
    },
  });

  if (!registerOk) {
    sleep(2);
    return;
  }

  const { session_id, session_token } = registerRes.json();
  const sessionHeaders = Object.assign({}, headers, {
    "x-session-token": session_token,
  });

  // Get session info
  const infoRes = http.get(
    `${BASE_URL}/api/v1/serve/info?session=${session_id}`,
    { headers: sessionHeaders },
  );

  infoLatency.add(infoRes.timings.duration);

  check(infoRes, {
    "info status 200": (r) => r.status === 200,
    "info session active": (r) => {
      const body = r.json();
      return body.ok === true && body.active === true;
    },
  });

  // Poll with short timeout (no pending requests expected)
  const pollRes = http.get(
    `${BASE_URL}/api/v1/serve/poll?session=${session_id}&timeout=1`,
    { headers: sessionHeaders, timeout: "5s" },
  );

  pollLatency.add(pollRes.timings.duration);

  check(pollRes, {
    "poll status 200": (r) => r.status === 200,
    "poll ok": (r) => r.json().ok === true,
  });

  sleep(2);
}
