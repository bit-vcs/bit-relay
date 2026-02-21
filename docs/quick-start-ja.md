# bit-relay クイックスタート

## bit-relay とは

bit-relay は `bit hub` のメタデータ（Issue, PR, Note 等）を中継するリレーサーバーです。
Git オブジェクト（コミット、ブロブ等）は保持しません。

つまり、リポジトリの **コード** は従来どおり GitHub 等の Git リモートから clone し、
**hub データ**（Issue や PR）を relay 経由で同期する、という二段構成になります。

```
┌────────┐   git clone    ┌────────────┐
│  手元   │ ◄──────────── │  GitHub 等  │   ← コード (blob/tree/commit)
│  bit    │                └────────────┘
│  repo   │   hub sync     ┌────────────┐
│         │ ◄─────────────►│ bit-relay   │   ← メタデータ (Issue/PR/Note)
└────────┘   push/fetch    │ (CF Worker) │
                            └────────────┘
```

## 前提条件

- `bit` CLI がインストール済み
- relay が Cloudflare Workers にデプロイ済み（例: `https://bit-relay.mizchi.workers.dev`）

```bash
# bit のインストール
curl -fsSL https://raw.githubusercontent.com/mizchi/bit-vcs/main/install.sh | bash

# relay の疎通確認
curl https://bit-relay.mizchi.workers.dev/health
# => {"status":"ok","service":"bit-relay"}
```

## ステップ 1: リポジトリを clone する

Git オブジェクトは通常の Git リモートから取得します。

```bash
# GitHub からの clone
bit clone https://github.com/user/repo.git
cd repo

# owner/repo 短縮形でも OK
bit clone user/repo
```

## ステップ 2: hub を初期化する

まだ hub が初期化されていないリポジトリでは、先に初期化します。

```bash
bit hub init
```

## ステップ 3: relay から hub データを取得する

relay に蓄積された Issue/PR/Note を手元に同期します。

```bash
# relay URL を明示指定して fetch
bit hub sync fetch relay+https://bit-relay.mizchi.workers.dev
```

`relay+https://` プレフィックスが relay モードを明示します。
省略して `https://...` にすると、smart-http を先に試行し 404 時に relay fallback します。

### 認証付き relay の場合

```bash
# Bearer トークンを指定
bit hub sync fetch relay+https://bit-relay.mizchi.workers.dev \
  --auth-token "$BIT_RELAY_AUTH_TOKEN"

# 署名鍵を指定（relay が署名必須の場合）
bit hub sync fetch relay+https://bit-relay.mizchi.workers.dev \
  --signing-key "$BIT_COLLAB_SIGN_KEY"
```

環境変数でも設定できます:

| 環境変数 | 用途 |
|----------|------|
| `BIT_RELAY_AUTH_TOKEN` | Bearer 認証トークン |
| `BIT_COLLAB_SIGN_KEY` | Ed25519 署名鍵 |
| `BIT_COLLAB_REQUIRE_SIGNED` | 署名必須フラグ |

## ステップ 4: hub データを relay に push する

手元で作成した Issue や PR を relay に送信します。

```bash
bit hub sync push relay+https://bit-relay.mizchi.workers.dev
```

## 全体の流れ（まとめ）

```bash
# 1. コードを clone
bit clone user/repo
cd repo

# 2. hub 初期化（初回のみ）
bit hub init

# 3. relay から hub データを取得
bit hub sync fetch relay+https://bit-relay.mizchi.workers.dev

# 4. Issue を確認
bit hub issue list

# 5. Issue を作成
bit hub issue create -t "タイトル" -b "本文"

# 6. relay に push
bit hub sync push relay+https://bit-relay.mizchi.workers.dev
```

## relay の URL 形式

`bit hub sync` が受け付ける URL 形式:

| 形式 | 挙動 |
|------|------|
| `relay+https://host` | relay API を直接使用 |
| `relay+http://host` | relay API を直接使用（非TLS） |
| `https://host/repo.git` | smart-http を試行、404 時に relay fallback |

## relay のデプロイ（参考）

自分で relay をデプロイする場合:

```bash
cd bit-relay
pnpm install
pnpm run deploy   # Cloudflare Workers にデプロイ
```

ローカル開発:

```bash
deno task dev     # http://127.0.0.1:8788
```

## 制限事項

- relay は hub メタデータ（Issue/PR/Note）のみを中継します。`bit clone` や `bit push` の Git オブジェクト転送には使えません
- Clone signaling（relay 経由での peer 発見と clone）は仕様策定済みですが、bit CLI 側は未実装です
- room のデフォルトは `main` です。relay 内のデータは room 単位で分離されます
