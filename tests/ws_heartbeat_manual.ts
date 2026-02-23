/**
 * WebSocket heartbeat 動作確認スクリプト
 *
 * Usage:
 *   deno run --allow-net tests/ws_heartbeat_manual.ts [--no-pong]
 *
 * --no-pong: サーバーの ping に応答しない（idle timeout で切断されることを確認）
 */

const noPong = Deno.args.includes('--no-pong');
const BASE = 'ws://127.0.0.1:8788';

console.log(`[client] connecting to ${BASE}/ws?room=heartbeat-test`);
console.log(`[client] pong response: ${noPong ? 'DISABLED' : 'ENABLED'}`);
console.log('---');

const ws = new WebSocket(`${BASE}/ws?room=heartbeat-test`);
const startedAt = Date.now();

function elapsed(): string {
  return `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

ws.onopen = () => {
  console.log(`[${elapsed()}] connected`);
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${elapsed()}] received: ${JSON.stringify(data)}`);

  if (data.type === 'ping' && !noPong) {
    ws.send(JSON.stringify({ type: 'pong' }));
    console.log(`[${elapsed()}] sent: { type: 'pong' }`);
  }
};

ws.onclose = (event) => {
  console.log(
    `[${elapsed()}] closed: code=${event.code} reason="${event.reason}" wasClean=${event.wasClean}`,
  );
  Deno.exit(0);
};

ws.onerror = (event) => {
  console.log(`[${elapsed()}] error: ${event}`);
};

// 60秒で自動終了
setTimeout(() => {
  console.log(`[${elapsed()}] timeout - closing`);
  ws.close();
}, 60_000);
