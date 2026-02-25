# bit-relay 利用ガイド

bit-relay を使ったリポジトリ共有・issue 管理・コラボレーションのガイドです。Git
の基本知識を前提とします。

## インストール

```bash
# シェルスクリプト（Mac/Linux）
curl -fsSL https://raw.githubusercontent.com/bit-vcs/bit/main/install.sh | bash

# MoonBit パッケージマネージャ
moon install bit-vcs/bit/cmd/bit
```

```bash
bit --version
```

## クイックスタート

### リポジトリを作って issue を共有する

```bash
# リポジトリ作成
mkdir my-project && cd my-project
bit init
echo "# My Project" > README.md
bit add . && bit commit -m "initial commit"

# issue トラッキングを初期化
bit issue init

# issue を作成
bit issue create -t "ログインページでクラッシュする" -b "特殊文字入力時に発生"

# relay に issue を push
bit relay sync push relay+https://bit-relay.mizchi.workers.dev
```

### リポジトリを relay 経由で公開する

```bash
bit relay serve relay+https://bit-relay.mizchi.workers.dev
# => Clone URL: relay+https://bit-relay.mizchi.workers.dev/AbCdEfGh
```

### 相手が clone して issue を取得する

```bash
bit clone relay+https://bit-relay.mizchi.workers.dev/AbCdEfGh
cd AbCdEfGh
bit issue init
bit relay sync fetch relay+https://bit-relay.mizchi.workers.dev
bit issue list
```

これだけで、GitHub なしにリポジトリと issue を共有できる。

## Why bit

Git プロトコルは本来、分散ストレージとして設計されている。しかし、GitHub
が現実的には権威サーバーとなっている。これは安定したブランチを選ぶ上で実用上は便利だが、AI Agent
の高速な生産性を前提とした開発サイクルとは噛み合っていない。もっと自由にブランチを作成して、自由に
upstream を選べるべきだし、異なる目的で大量の fork が生まれてよいと思っている。

bit
の作者としては、非中央集権であることに政治的な主張はない。ただ、開発ワークフローとしてそこに技術優位があると思っているだけだ。最終的には
P2P で開発されたものは GitHub に sync されるのが運用上楽だと思うし、揮発性の P2P
キャッシュはストレージとして使うには信頼性に欠ける。

bit + bit-relay は P2P のリレーサーバーとして実装されている。自律的な AI エージェントが bit
プロトコルを前提に開発ノードに参加し、変更を broadcast して、各自が勝手に取り入れる —
これが本来の分散ストレージとしての Git の姿だ。OSS
の開発者のモデルで、指向性を与えられた自律的なエージェントが可能性を探索する。最終的に人間がその結果を確認して、選択的に取り入れる。このサイクルを高速化するために非中央集権的な
Git が必要だ。

具体的には、`bit relay serve` されている間に P2P で誰かが変更した内容は、P2P ノード間で
`.git/objects` と `refs/relay/incoming/...` に自動保存される（受け入れサイズ上限あり）。ユーザーや
AI はローカルで好きな変更を cherry-pick
すればよい。このモデルがうまくいけば、ブロックチェーンのように、もっとも有用なブランチが事実上の
fast-forward として扱えるはずだ。

とはいえ、まだ簡単な fetch/clone/sync/PR
の仕組みがあるだけで、実際にはもっと多くの機能が必要だろう：

- 複数のリレーサーバー間の同期
- GitHub と PR/issue を共有する仕組み
- クローズドなローカルホストリレー
- リレーサーバーが数日間キャッシュを持ってバックアップする機能
- AI にこのサイクルを理解させるためのプロンプト

現状は趣味レベルの PoC
として開発しており、サポートしてくれる人や会社を募集している。不足しているものは多い — Git
との完全な互換を保証するための手数、これを組み込むための SDK
やドキュメント、そして実際にエージェントクラスターを運用する上での知見。

このコンセプトに未来を感じた人は、 https://x.com/mizchi まで連絡してほしい。

## 主要な概念

### bit — Git 実装

bit は MoonBit で書かれた Git 実装。一部の未サポート機能（例: `--object-hash=sha256`）を除き、Git
と互換。既存の Git リポジトリをそのまま bit で扱えるし、その逆も可能。

### hub — 分散型の Issue/PR 管理

GitHub では issue や PR は GitHub サーバー上にある。bit では **リポジトリ内部** に Git
notes（`refs/notes/bit-hub`）として保存する。

- issue/PR がリポジトリデータの一部になり、特定のホスティングに依存しない
- 中央サーバーなしにピア間で同期できる
- `bit issue init` で任意の git リポジトリに初期化できる

### relay — 共有のためのリレーサーバー

bit-relay は 2 つの問題を解決する軽量リレーサーバー。

1. **NAT/ファイアウォール越しのリポジトリ共有**: `bit relay serve` でローカルリポジトリを relay
   経由で公開し、他者が `bit clone` できる。ポート開放不要
2. **hub メタデータの同期**: `bit relay sync push/fetch` で issue/PR を relay 経由で配信・取得

```
┌──────────┐                      ┌───────────┐
│  Alice    │──relay serve────────│           │────clone────▶ Bob
│ (ホスト)  │──sync push──────▶  │  bit-relay │                │
│           │                     │ (サーバー)  │◀──sync fetch── │
└──────────┘                      └───────────┘
```

コード（blob/tree/commit）は `serve`/`clone` で、hub メタデータ（issue/PR）は
`sync push`/`sync fetch` で転送する。これらは独立した操作。

デフォルトの relay
は本プロジェクトからデプロイした公開インスタンス（`bit-relay.mizchi.workers.dev`）を使う。独自にデプロイすることもできる。詳細は
[Hosting bit-relay](./host-bit-relay.md) を参照。

### sender — あなたの識別子

`sender` は relay 上での識別名（例: `alice`）。Ed25519
署名鍵と組み合わせて、メッセージの発行者を証明する。GitHub 検証を行うと sender 名が GitHub
ユーザー名と紐付き、`alice/my-repo` のような名前付きセッションが使える。

### session — 一時的な relay エンドポイント

`bit relay serve` を実行すると、relay にセッションが作られる。セッションはランダム ID（例:
`AbCdEfGh`）か名前付きパス（例: `alice/my-repo`）で識別される一時的なエンドポイント。`serve`
コマンドの実行中のみ有効。

## 詳細設定

### 環境変数

```bash
# relay URL（serve/sync コマンドのデフォルト値）
export BIT_RELAY_URL=relay+https://bit-relay.mizchi.workers.dev

# sender ID
export BIT_RELAY_SENDER=alice

# 署名鍵ファイルのパス（任意）
export BIT_RELAY_SIGN_PRIVATE_KEY_FILE=~/.config/bit/relay-key.pem
```

### 署名鍵の生成（任意）

```bash
# Ed25519 秘密鍵を生成
openssl genpkey -algorithm Ed25519 -out ~/.config/bit/relay-key.pem

# 公開鍵を base64url 形式で取得
openssl pkey -in ~/.config/bit/relay-key.pem -pubout -outform DER \
  | base64 | tr '+/' '-_' | tr -d '='
```

### GitHub ユーザー名検証

署名鍵を GitHub アカウントと紐付けて本人確認できる。Ed25519 鍵と GitHub SSH 鍵を照合する仕組み。

```bash
# 鍵を登録し GitHub SSH 鍵と照合
#（BIT_RELAY_SENDER と BIT_RELAY_SIGN_PRIVATE_KEY_FILE の設定が必要）
bit relay sync push relay+https://bit-relay.mizchi.workers.dev
```

検証が通ると、ランダム ID の代わりに `alice/my-repo` のような名前付きセッションが使える。

### relay serve のオプション

| オプション            | 説明                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `--allow-remote-push` | リモートからの push を受け付ける（`refs/relay/incoming/` に保存） |
| `--auto-fetch`        | feature broadcast 検知時に自動 fetch                              |
| `--repo <name>`       | リポジトリ名を指定（名前付きセッションを有効化）                  |

互換モードとして、host 側が `receive-pack not enabled` を返す環境でも `refs/relay/incoming/...` への
push は relay 側で受理できる（CI トリガー用途）。

### relay URL 形式

| 形式                    | 動作                                           |
| ----------------------- | ---------------------------------------------- |
| `relay+https://host`    | relay API を直接使用（TLS）                    |
| `relay+http://host`     | relay API を直接使用（非 TLS、ローカル開発用） |
| `https://host/repo.git` | smart-http を試行、404 時に relay fallback     |

## CI トリガーフロー（Incoming Ref）

`refs/relay/incoming/...` の受信、webhook 発火、callback/result API の仕様は以下を参照:

- [CI トリガー仕様](./ci-trigger-spec-ja.md)

## 運用者向け API（キャッシュ/同期）

relay 運用者向けに、issue キャッシュと relay 間交換の確認 API を用意している。

### issue キャッシュを直接確認する

```bash
# issue イベントをカーソルで取得
curl "http://127.0.0.1:8788/api/v1/cache/issues/pull?room=main&after=0&limit=20"

# issue snapshot + incremental event を取得
curl "http://127.0.0.1:8788/api/v1/cache/issues/sync?room=main&after=0&limit=20"
```

### relay 間 cache exchange を手動確認する

```bash
# A から pull して
curl "http://relay-a.local/api/v1/cache/exchange/pull?after=0&limit=50&peer=relay-b" > /tmp/exchange.json

# B に push
curl -X POST "http://relay-b.local/api/v1/cache/exchange/push" \
  -H "content-type: application/json" \
  --data @/tmp/exchange.json
```

### 負荷試験（multi-relay + cache hit/miss + issue sync）

```bash
RELAY_URLS=http://127.0.0.1:8788,http://127.0.0.1:8789 \
  just bench-scenario multi-relay-cache-issue-sync http://127.0.0.1:8788
```

## フルワークフロー: Alice と Bob

### Alice（ホスト側）

```bash
# 1. リポジトリの作成と初期化
mkdir my-project && cd my-project
bit init
echo "# My Project" > README.md
bit add . && bit commit -m "initial commit"
bit issue init

# 2. issue を作成
bit issue create -t "Unicode パスワードで認証が失敗する" \
  -b "パスワードに Unicode 文字を含むユーザーがログインできない"

# 3. hub データを relay に push
bit relay sync push relay+http://localhost:8788

# 4. リポジトリを公開（実行中は維持）
bit relay serve relay+http://localhost:8788
# => Clone URL: relay+http://localhost:8788/AbCdEfGh
```

### Bob（クライアント側）

```bash
# 1. relay から clone
bit clone relay+http://localhost:8788/AbCdEfGh
cd AbCdEfGh

# 2. hub をローカルで初期化
bit issue init

# 3. relay から hub データを取得
bit relay sync fetch relay+http://localhost:8788

# 4. issue と PR を確認
bit issue list
bit pr list
```

## bithub — bit の Web UI

[bithub](https://github.com/bit-vcs/bithub) は bit と連携して GitHub のような UI を提供する Web
サーバー。現在開発中。

- Web インターフェースでリポジトリを閲覧（`/blob/<path>`、`/issues` など）
- bit-relay 経由で同期された issue を表示
- relay を通じて他の bithub ノードを発見（`/relay`）
- Cloudflare Workers またはローカルサーバーとして動作

```bash
# 現在のリポジトリをローカルで閲覧
./bithub .

# relay 連携あり
./bithub . --relay relay+https://bit-relay.mizchi.workers.dev
```

## 連携予定

- [sprites.dev](https://sprites.dev) — 軽量コンテナプラットフォーム。relay サーバーや bithub
  インスタンスのデプロイ先として連携予定。
- [exe.dev](https://exe.dev) — リモート実行環境。bit の P2P 開発ワークフローに参加する AI
  エージェントクラスターの実行基盤として連携予定。

## トラブルシューティング

- **"session not found"**: ホスト側の `bit relay serve`
  が停止している可能性がある。ホストに再起動を依頼する。
- **署名エラー**: `BIT_RELAY_SENDER` と `BIT_RELAY_SIGN_PRIVATE_KEY_FILE`
  が正しく設定されているか確認する。テスト時は `RELAY_REQUIRE_SIGNATURE=false` で起動した relay
  を使う。
- **接続拒否**: relay URL
  が正しいか、サーバーが起動しているか確認する（`curl <relay-url>/health`）。
