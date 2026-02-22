# Scaling Characteristics

bit-relay (Cloudflare Workers + Durable Objects) のスケーリング特性を k6 ベンチマークで計測した結果をまとめる。

## 計測環境

- ターゲット: `bit-relay.mizchi.workers.dev` (Cloudflare Workers)
- ツール: k6 v1.5.0 (ローカルから実行)
- 署名検証: 無効 (`RELAY_REQUIRE_SIGNATURE=false`)
- 日付: 2026-02-22

## エンドポイント別レイテンシ

### Health (GET /health, GET /)

| VUs | p95 | max | エラー率 | req/s |
|-----|-----|-----|---------|-------|
| 100 | 36ms | 592ms | 0% | 146 |
| 500 | 165ms | 459ms | 0% | 817 |

Worker の基本レイテンシ。500 VUs でも安定。

### Publish + Poll (分散 room)

各 VU が専用 room に publish する。DO が VU 数分に分散される。

| VUs | publish p95 | poll p95 | エラー率 | publish/s |
|-----|-------------|----------|---------|-----------|
| 200 | 383ms | 35ms | 0% | 36 |
| 500 | 387ms | 36ms | 0% | 114 |

VU を 200→500 に増やしても publish レイテンシが横ばい。DO が水平分散されるため。

### Publish + Poll (同一 room 集中)

全 VU が 1 つの room に publish する。1 つの DO にリクエストが直列化される。

| VUs | publish p95 | poll p95 | エラー率 | publish/s |
|-----|-------------|----------|---------|-----------|
| 200 | 87ms | 34ms | 0% | 36 |

分散より速い。理由: DO が warm 状態を維持するため cold start コストがない。

### Inbox (pending + ack)

| VUs | pending p95 | ack p95 | エラー率 |
|-----|-------------|---------|---------|
| 50 | 32ms | 45ms | 0% |

### Presence (heartbeat + list + delete)

| VUs | heartbeat p95 | list p95 | エラー率 |
|-----|---------------|----------|---------|
| 100 | 87ms | 40ms | 0% |

### WebSocket (connect + ping/pong)

| VUs | ready p95 | ping/pong p95 | エラー率 |
|-----|-----------|---------------|---------|
| 100 | 328ms | 27ms | 0% |

MAX_WS_SESSIONS=100 の制約内。100 同時接続で全く問題なし。

### Git Serve (register + info + poll)

| VUs | register p95 | info p95 | エラー率 |
|-----|-------------|----------|---------|
| 5 | 604ms | 99ms | 0% |

register は新規 DO 生成を伴うため ~400-600ms。セッション確立の 1 回コスト。

## スケーリング特性

### ボトルネックにならなかったもの

- **Worker の同時実行**: 500 VUs でもエラー 0%
- **DO の直列化**: 200 並行書き込みを 1 DO が p95=87ms で処理
- **WebSocket**: 100 同時接続でも ping/pong p95=27ms
- **Read 系 API** (poll, inbox/pending, presence/list): 終始 p95 < 40ms

### 観測されたボトルネック

- **DO の cold start**: 分散シナリオでは新規 DO の起動コストで publish p95 が ~387ms に上昇
- **Git Serve register**: DO 新規生成で p95=604ms

### 到達しなかった限界

テスト範囲では以下の限界には達しなかった:

- **DO のメモリ制限**: `RELAY_MAX_MESSAGES_PER_ROOM=1000` に達する前にテスト終了
- **Worker の CPU 制限**: Cloudflare の CPU 時間制限 (Free: 10ms, Paid: 30ms)
- **DO の同時接続上限**: Cloudflare の内部制限
- **レート制限**: VU ごとに sender を分離しているため `30 publish/60s/sender` には非到達

## アーキテクチャ上の制約

| パラメータ | デフォルト値 | 影響 |
|-----------|-------------|------|
| `RELAY_MAX_MESSAGES_PER_ROOM` | 1,000 | room あたりの最大メッセージ数 |
| `RELAY_PUBLISH_LIMIT_PER_WINDOW` | 30 | sender あたり 60 秒間の publish 上限 |
| `MAX_WS_SESSIONS` | 100 | room あたりの最大 WebSocket 接続数 |
| `PUBLISH_PAYLOAD_MAX_BYTES` | 65,536 | 1 メッセージの最大サイズ |

## ベンチマーク実行方法

```bash
# 全シナリオ実行
just bench https://bit-relay.mizchi.workers.dev

# 個別シナリオ
just bench-scenario health https://bit-relay.mizchi.workers.dev
just bench-scenario publish-poll https://bit-relay.mizchi.workers.dev
just bench-scenario publish-contention https://bit-relay.mizchi.workers.dev

# JSON 出力
just bench-json https://bit-relay.mizchi.workers.dev
```

署名検証が有効な環境では `RELAY_REQUIRE_SIGNATURE=false` に一時的に変更してからテストする必要がある。
