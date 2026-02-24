# Performance Reports

bit-relay の性能検証結果を時系列で集約するドキュメント。

## 1. Cloudflare スケーリング計測（2026-02-22）

詳細レポート: [scaling.md](./scaling.md)

- 対象: `bit-relay.mizchi.workers.dev` (Cloudflare Workers + Durable Objects)
- ツール: k6 v1.5.0
- 署名検証: `RELAY_REQUIRE_SIGNATURE=false`

代表値（抜粋）:

- Health (`GET /health`, `GET /`) は `500 VUs` で `p95=165ms`、エラー率 `0%`
- Publish+Poll（分散 room）は `500 VUs` で `publish p95=387ms`, `poll p95=36ms`
- WebSocket は `100 VUs` で `ready p95=328ms`, `ping/pong p95=27ms`

## 2. ローカル 3 ノード伝搬速度（2026-02-24）

### 計測条件

- ノード構成: `relay-a/b/c` の 3 ノード
- 接続: 各ノードの `RELAY_PEERS` に他 2 ノードを設定
- 同期間隔: `RELAY_PEER_SYNC_INTERVAL_SEC=1`
- 署名検証: `RELAY_REQUIRE_SIGNATURE=false`
- 試行回数: `notify` と `issue_sync` をそれぞれ 15 回

### シナリオ

- `notify`:
  - 各ノードに 2 ユーザー（合計 6 ユーザー）で publish
  - 全ノード `poll` で 6 件揃うまでの時間を計測
- `issue_sync`:
  - `topic=issue` と `topic=issue.updated` を別ノードから publish
  - 全ノード `cache/issues/sync` で `upsert + updated` が揃うまでの時間を計測

### 結果

| Metric       | Trials | Timeout | Min   | Avg     | p50   | p95   | Max   |
| ------------ | ------ | ------- | ----- | ------- | ----- | ----- | ----- |
| `notify`     | 15     | 0       | 762ms | 861.4ms | 854ms | 958ms | 980ms |
| `issue_sync` | 15     | 0       | 859ms | 933.7ms | 960ms | 977ms | 983ms |

### 解釈

- 伝搬完了時間はほぼ 1 秒前後で、`RELAY_PEER_SYNC_INTERVAL_SEC=1` の設定に整合する。
- `issue_sync` は `notify` よりやや遅いが、`p95` は 1 秒未満に収束した。

## 3. 再実行手順

機能検証（3ノードの伝搬可否）:

```bash
just test-multi-relay-mesh 19081
```

負荷シナリオ（k6, multi-relay + cache hit/miss + issue sync）:

```bash
RELAY_URLS=https://relay-a.example,https://relay-b.example \
  just bench-scenario multi-relay-cache-issue-sync https://relay-a.example
```
