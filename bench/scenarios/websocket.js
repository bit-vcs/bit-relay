import { check, sleep } from 'k6';
import ws from 'k6/ws';
import { Counter, Trend } from 'k6/metrics';
import { AUTH_TOKEN, WS_URL } from '../config.js';
import { roomName } from '../helpers.js';

const wsReadyLatency = new Trend('ws_ready_latency', true);
const wsPingPongLatency = new Trend('ws_ping_pong_latency', true);
const wsConnections = new Counter('ws_connections');

export const options = {
  scenarios: {
    websocket: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '15s', target: 50 },
        { duration: '15s', target: 100 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    ws_ready_latency: ['p(95)<2000'],
    ws_ping_pong_latency: ['p(95)<500'],
  },
};

export default function () {
  const vuId = __VU;
  const room = roomName('ws', vuId);

  const wsUrl = `${WS_URL}/ws?room=${room}`;

  const params = {};
  if (AUTH_TOKEN) {
    params.headers = { Authorization: `Bearer ${AUTH_TOKEN}` };
  }

  const connectStart = Date.now();
  let pingStart = 0;

  const res = ws.connect(wsUrl, params, function (socket) {
    let readyReceived = false;

    socket.on('open', function () {
      wsConnections.add(1);
    });

    socket.on('message', function (msg) {
      const data = JSON.parse(msg);

      if (data.type === 'ready' && !readyReceived) {
        readyReceived = true;
        wsReadyLatency.add(Date.now() - connectStart);

        // Send ping and measure round-trip
        pingStart = Date.now();
        socket.send(JSON.stringify({ type: 'ping' }));
      }

      if (data.type === 'pong') {
        wsPingPongLatency.add(Date.now() - pingStart);
        socket.close();
      }
    });

    socket.on('error', function (e) {
      console.error(`WS error vu${vuId}: ${e.error()}`);
    });

    // Timeout: close after 10s if not already closed
    socket.setTimeout(function () {
      if (!readyReceived) {
        console.warn(`WS timeout vu${vuId}: no ready received`);
      }
      socket.close();
    }, 10000);
  });

  check(res, {
    'ws status 101': (r) => r && r.status === 101,
  });

  sleep(1);
}
