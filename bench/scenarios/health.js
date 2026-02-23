import http from 'k6/http';
import { check, sleep } from 'k6';
import { authHeaders, BASE_URL } from '../config.js';

export const options = {
  scenarios: {
    health: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '10s', target: 50 },
        { duration: '10s', target: 100 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const headers = authHeaders();

  const healthRes = http.get(`${BASE_URL}/health`, { headers });
  check(healthRes, {
    'health status 200': (r) => r.status === 200,
    'health body ok': (r) => {
      const body = r.json();
      return body.status === 'ok';
    },
  });

  const rootRes = http.get(`${BASE_URL}/`, { headers });
  check(rootRes, {
    'root status 200': (r) => r.status === 200,
  });

  sleep(0.5);
}
