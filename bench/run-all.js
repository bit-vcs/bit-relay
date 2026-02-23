import healthFn from './scenarios/health.js';
import publishPollFn from './scenarios/publish-poll.js';
import inboxFn from './scenarios/inbox.js';
import presenceFn from './scenarios/presence.js';
import websocketFn from './scenarios/websocket.js';
import gitServeFn from './scenarios/git-serve.js';

// Combined runner: each scenario starts at a staggered offset.
// Individual scenario files also work standalone with their own `options`.

export const options = {
  scenarios: {
    health: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '5s', target: 10 },
        { duration: '5s', target: 50 },
        { duration: '5s', target: 0 },
      ],
      startTime: '0s',
      exec: 'health',
    },
    publish_poll: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '10s', target: 50 },
        { duration: '10s', target: 0 },
      ],
      startTime: '10s',
      exec: 'publishPoll',
    },
    inbox: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '10s', target: 30 },
        { duration: '5s', target: 0 },
      ],
      startTime: '40s',
      exec: 'inbox',
    },
    presence: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '10s', target: 50 },
        { duration: '5s', target: 0 },
      ],
      startTime: '40s',
      exec: 'presence',
    },
    websocket: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '10s', target: 50 },
        { duration: '5s', target: 0 },
      ],
      startTime: '70s',
      exec: 'websocket',
    },
    git_serve: {
      executor: 'constant-vus',
      vus: 5,
      duration: '30s',
      startTime: '100s',
      exec: 'gitServe',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.05'],
  },
};

export function health() {
  healthFn();
}

export function publishPoll() {
  publishPollFn();
}

export function inbox() {
  inboxFn();
}

export function presence() {
  presenceFn();
}

export function websocket() {
  websocketFn();
}

export function gitServe() {
  gitServeFn();
}
