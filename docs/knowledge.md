# Knowledge Base

運用・開発で得た知見をまとめる。

## Cloudflare Durable Object の storage 制限

**発生日**: 2026-02-23
**症状**: `bit relay sync push` が HTTP 500 (Cloudflare error 1101) を返す
**原因**: `RelayRoom` DO の `storage.put()` でスナップショットが 128 KiB/value 制限を超過

### 背景

`RelayRoom` DO はリクエストごとにメモリ上の全状態（メッセージ + 鍵 + nonce）を単一キーにシリアライズして永続化していた。

```
snapshot = messages (最大1000件 × 最大64KB) + keys + nonces
```

ベンチマークやテストデータの蓄積でスナップショットが肥大化し、`storage.put()` が例外を投げた。try-catch がなかったため Worker 全体が 500 を返していた。

### 暫定対処

- `storage.put()` / `storage.get()` を try-catch でラップ
- persistence は best-effort とし、失敗してもリクエストは成功を返す

### 根本対策（実装済み）

identity-only 永続化に変更:

- **`relay_identity_v1`**: keys_by_sender + nonces_by_sender のみ永続化（TOFU の鍵レジストリと replay 防止の nonce）
- **messages/acks/presence/reviews**: 揮発性（in-memory only）。DO 再起動で消えるが、クライアントは poll cursor から再取得するだけ
- 旧 `relay_snapshot_v1` からの自動マイグレーション付き（初回起動時に identity 部分だけ抽出して移行、旧キーは削除）
- `storage.put()` / `storage.get()` は引き続き try-catch でラップ

### Cloudflare DO storage の制約まとめ

| 制約 | 値 |
|------|-----|
| 1 value あたりの最大サイズ | 128 KiB |
| 1 key あたりの最大サイズ | 2 KiB |
| 1 リクエストあたりの put/get 回数 | 制限なし（ただし課金対象） |
| DO インスタンスのメモリ | 128 MB |

## Git ルートの named/random セッション曖昧性

**発生日**: 2026-02-23
**症状**: `bit clone relay+https://.../AbCdEfGh` が 404 を返す
**原因**: `/git/AbCdEfGh/info/refs` が named session パターン `/git/<owner>/<repo>/<path>` に先にマッチし、セッション ID が `AbCdEfGh/info` として解釈されていた

### 対処

named match と random match の両方を評価し、named が 404 なら random にフォールバックするよう修正。

### 教訓

URL パターンが重複する場合、片方のマッチだけで確定させず、フォールバックを設けること。Deno 版は `gitServeSessions.has()` でメモリ内チェックしていたため問題なかったが、CF 版は DO が存在チェックなしに生成されるためフォールバックが必要だった。
