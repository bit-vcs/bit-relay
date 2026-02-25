# CI トリガー仕様

このドキュメントは bit-relay の CI トリガーフローを定義する:

1. Relay が `git-receive-pack` 経由で `refs/relay/incoming/...` を受け取る
2. Relay が外部 Webhook を発火する
3. 外部 CI が relay へ結果を callback する
4. クライアントが relay API から CI 結果を取得する

## 1. トリガー入力

incoming ref は `POST /git/<session_id>/git-receive-pack` の request body から抽出する。

- マッチパターン: `refs/relay/incoming/[A-Za-z0-9._/-]{1,255}`
- 同一 body 内の重複 ref は 1 回に正規化（dedupe）
- 一意な incoming ref ごとに `incoming_ref` イベントを 1 件発行

## 2. Webhook 発火条件

次の条件を満たす場合のみ webhook を送信する:

- `RELAY_TRIGGER_WEBHOOK_URL` が設定されている
- incoming ref が設定済みプレフィックスのいずれかに一致する
- `git-receive-pack` の relay 応答ステータスが 2xx である
- host が `receive-pack not enabled` を返した場合でも、`refs/relay/incoming/...` push については
  relay が互換レスポンス（2xx）に変換できる

設定値:

- `RELAY_TRIGGER_WEBHOOK_URL`: 送信先 URL
- `RELAY_TRIGGER_WEBHOOK_TOKEN`: 任意の Bearer token
- `RELAY_TRIGGER_EVENT_TYPE`: 既定 `relay.incoming_ref`
- `RELAY_TRIGGER_REF_PREFIXES`: CSV、既定 `refs/relay/incoming/`

送信結果の扱い:

- 2xx は成功
- 非 2xx とネットワークエラーは trigger dispatch failure としてログ記録
- `git-receive-pack` 応答が非 2xx の場合、incoming-ref webhook は送信しない
- 互換変換が適用された incoming push は 2xx として扱われ、incoming-ref webhook を送信する

## 3. 送信 Webhook Payload

Relay は `POST <RELAY_TRIGGER_WEBHOOK_URL>` に次の JSON を送る:

```json
{
  "event_type": "relay.incoming_ref",
  "event_id": "evt-...",
  "occurred_at": 1700000000,
  "room": "main",
  "source": "deno:127.0.0.1:8788",
  "target": "session:<session_id>",
  "ref": "refs/relay/incoming/repo-ci"
}
```

`RELAY_TRIGGER_WEBHOOK_TOKEN` がある場合はヘッダを追加する:

```text
Authorization: Bearer <token>
```

## 4. CI Callback API

外部 CI は次の endpoint に結果を返す:

- `POST /api/v1/trigger/callback`

必須フィールド:

- `ref` (string)
- `status` (string)

任意フィールド:

- `room`
- `logs_url`
- `artifact_url`
- `external_id`
- `provider`
- `id`

room 解決ルール:

- `room` 指定あり: その値を使う
- それ以外で `ref` が `refs/relay/incoming/<room>/...` 形式: 先頭 `<room>` を使う
- どちらでもない: `main` にフォールバック

publish される envelope:

- `topic`: `ci.result`
- `sender`: `ci:callback`
- payload は `ref`, `status`, `logs_url`, `artifact_url`, `external_id`, `provider`, `received_at`
  を含む

## 5. CI 結果の取得

次の API で結果を読める:

- `GET /api/v1/trigger/results?room=<room>&after=<cursor>&limit=<n>`
- `GET /api/v1/poll?room=<room>&after=<cursor>&limit=<n>`（room タイムラインに `ci.result`
  が含まれる）

## 6. 認証・room token ルール

- `BIT_RELAY_AUTH_TOKEN` 設定時は `/api/v1/trigger/*` に Bearer 認証が必要
- 対象 room に token が設定されている場合、callback/results は `x-room-token` ヘッダまたは
  `room_token` クエリが必要

## 7. 動作確認コマンド

既存の統合テストで確認できる:

```bash
deno test --allow-net --allow-env tests/trigger_incoming_ref_integration_test.ts
deno test --allow-net --allow-env tests/trigger_callback_test.ts
```
