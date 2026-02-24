import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { authHeaders, RELAY_URLS, RUN_ID } from '../config.js';
import { uuid } from '../helpers.js';

const issuePublishLatency = new Trend('mr_issue_publish_latency', true);
const exchangePullLatency = new Trend('mr_exchange_pull_latency', true);
const exchangePushLatency = new Trend('mr_exchange_push_latency', true);
const cacheIssuePullHitLatency = new Trend('mr_cache_issue_pull_hit_latency', true);
const cacheIssuePullMissLatency = new Trend('mr_cache_issue_pull_miss_latency', true);
const issueSyncLatency = new Trend('mr_issue_sync_latency', true);

const cacheHitCount = new Counter('mr_cache_hit_count');
const cacheMissCount = new Counter('mr_cache_miss_count');
const exchangedEntryCount = new Counter('mr_exchange_entries_total');

const roomPoolSize = normalizePositiveInt(__ENV.BENCH_ROOM_POOL, 6);
const exchangeLimit = normalizePositiveInt(__ENV.BENCH_EXCHANGE_LIMIT, 50);

function normalizePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function relayAt(index) {
  if (RELAY_URLS.length === 0) return 'http://localhost:8788';
  return RELAY_URLS[index % RELAY_URLS.length];
}

function safeJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function sharedRoom(vuId) {
  return `bench-${RUN_ID}-multi-relay-room${vuId % roomPoolSize}`;
}

function issueRoom(vuId, iteration) {
  return `${sharedRoom(vuId)}-iter-${iteration % 12}`;
}

function issuePayload(vuId, iteration) {
  return {
    issue_id: `issue-${vuId}-${iteration}`,
    title: `bench issue ${iteration}`,
    state: 'open',
    sequence: iteration,
  };
}

function pairRelays(vuId, iteration) {
  const index = (vuId + iteration) % RELAY_URLS.length;
  return {
    source: relayAt(index),
    target: relayAt(index + 1),
  };
}

function publishIssueEvent(args) {
  const room = encodeURIComponent(args.room);
  const sender = encodeURIComponent(args.sender);
  const topic = encodeURIComponent(args.topic);
  const id = encodeURIComponent(args.id);
  const url =
    `${args.baseUrl}/api/v1/publish?room=${room}&sender=${sender}&topic=${topic}&id=${id}`;
  const response = http.post(url, JSON.stringify(args.payload), { headers: args.headers });
  issuePublishLatency.add(response.timings.duration);
  return response;
}

function exchangeBetweenRelays(args) {
  const pullUrl = `${args.source}/api/v1/cache/exchange/pull?after=0&limit=${exchangeLimit}&peer=${
    encodeURIComponent(args.peer)
  }&room=${encodeURIComponent(args.room)}`;
  const pullResponse = http.get(pullUrl, { headers: args.headers });
  exchangePullLatency.add(pullResponse.timings.duration);

  const pullBody = safeJson(pullResponse);
  const pullOk = check(pullResponse, {
    'exchange pull status 200': (r) => r.status === 200,
    'exchange pull has entries array': () => !!pullBody && Array.isArray(pullBody.entries),
  });
  if (!pullOk || !pullBody || !Array.isArray(pullBody.entries) || pullBody.entries.length === 0) {
    return;
  }

  exchangedEntryCount.add(pullBody.entries.length);

  const pushResponse = http.post(
    `${args.target}/api/v1/cache/exchange/push`,
    JSON.stringify({ entries: pullBody.entries }),
    { headers: args.headers },
  );
  exchangePushLatency.add(pushResponse.timings.duration);

  check(pushResponse, {
    'exchange push status 200': (r) => r.status === 200,
  });
}

export const options = {
  scenarios: {
    multi_relay_cache_issue_sync: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '15s', target: 40 },
        { duration: '15s', target: 80 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    mr_issue_publish_latency: ['p(95)<1200'],
    mr_exchange_pull_latency: ['p(95)<1200'],
    mr_exchange_push_latency: ['p(95)<1500'],
    mr_cache_issue_pull_hit_latency: ['p(95)<800'],
    mr_cache_issue_pull_miss_latency: ['p(95)<800'],
    mr_issue_sync_latency: ['p(95)<900'],
    mr_cache_hit_count: ['count>0'],
    mr_cache_miss_count: ['count>0'],
    http_req_failed: ['rate<0.10'],
  },
};

export default function () {
  const vuId = __VU;
  const iteration = __ITER;
  const headers = authHeaders();
  const sender = `bench-multi-relay-vu${vuId}`;
  const room = issueRoom(vuId, iteration);
  const peer = `bench-peer-vu${vuId}`;
  const { source, target } = pairRelays(vuId, iteration);
  const payload = issuePayload(vuId, iteration);

  if (RELAY_URLS.length < 2 && iteration === 0 && vuId === 1) {
    console.warn(
      '[bench] RELAY_URLS has a single endpoint. multi-relay scenario will run in single-relay mode.',
    );
  }

  const createResponse = publishIssueEvent({
    baseUrl: source,
    room,
    sender,
    topic: 'issue',
    id: `issue-create-${uuid()}`,
    payload,
    headers,
  });
  check(createResponse, {
    'publish issue status 200': (r) => r.status === 200,
  });

  const updateResponse = publishIssueEvent({
    baseUrl: source,
    room,
    sender,
    topic: 'issue.updated',
    id: `issue-update-${uuid()}`,
    payload: {
      ...payload,
      title: `${payload.title} (updated)`,
      sequence: iteration + 1,
    },
    headers,
  });
  check(updateResponse, {
    'publish issue.updated status 200': (r) => r.status === 200,
  });

  exchangeBetweenRelays({
    source,
    target,
    room,
    peer,
    headers,
  });

  const missRoom = `${room}-miss-${vuId}`;
  const missResponse = http.get(
    `${target}/api/v1/cache/issues/pull?room=${encodeURIComponent(missRoom)}&after=0&limit=10`,
    { headers },
  );
  cacheIssuePullMissLatency.add(missResponse.timings.duration);
  const missBody = safeJson(missResponse);
  const missOk = check(missResponse, {
    'cache miss pull status 200': (r) => r.status === 200,
    'cache miss returns empty envelopes': () =>
      !!missBody && Array.isArray(missBody.envelopes) && missBody.envelopes.length === 0,
  });
  if (missOk) {
    cacheMissCount.add(1);
  }

  const hitResponse = http.get(
    `${target}/api/v1/cache/issues/pull?room=${encodeURIComponent(room)}&after=0&limit=20`,
    { headers },
  );
  cacheIssuePullHitLatency.add(hitResponse.timings.duration);
  const hitBody = safeJson(hitResponse);
  const hitOk = check(hitResponse, {
    'cache hit pull status 200': (r) => r.status === 200,
    'cache hit pull has envelopes array': () => !!hitBody && Array.isArray(hitBody.envelopes),
  });
  if (hitOk && hitBody && hitBody.envelopes.length > 0) {
    cacheHitCount.add(1);
  }

  const syncResponse = http.get(
    `${target}/api/v1/cache/issues/sync?room=${encodeURIComponent(room)}&after=0&limit=20`,
    { headers },
  );
  issueSyncLatency.add(syncResponse.timings.duration);
  const syncBody = safeJson(syncResponse);
  check(syncResponse, {
    'issue sync status 200': (r) => r.status === 200,
    'issue sync has events array': () => !!syncBody && Array.isArray(syncBody.events),
  });

  sleep(1);
}
