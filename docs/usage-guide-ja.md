# bit-relay 利用ガイド

bit-relay を使ったリポジトリ共有・issue 管理・コラボレーションのステップバイステップガイドです。Git の基本知識を前提としています。

## Why bit

Git プロトコルは本来、分散ストレージとして設計されている。しかし GitHub によって事実上の権威サーバーとなっている。これは安定したブランチを選ぶ上で実用上は便利だが、AI Agent の高速な生産性を前提とした開発サイクルとは噛み合っていない。もっと自由にブランチを作成して、自由に upstream を選べるべきだし、異なる目的で大量の fork が生まれてよいと思っている。

bit の作者としては、非中央集権であることに政治的な主張はない。ただ、開発ワークフローとしてそこに技術優位があると思っているだけだ。最終的には P2P で開発されたものは GitHub に sync されるのが運用上楽だと思うし、揮発性の P2P キャッシュはストレージとして使うには信頼性に欠ける。

bit + bit-relay は P2P のリレーサーバーとして実装されている。自律的な AI エージェントが bit プロトコルを前提に開発ノードに参加し、変更を broadcast して、各自が勝手に取り入れる — これが本来の分散ストレージとしての Git の姿だ。OSS の開発者のモデルで、指向性を与えられた自律的なエージェントが可能性を探索する。最終的に人間がその結果を確認して、選択的に取り入れる。このサイクルを高速化するために非中央集権的な Git が必要だ。

具体的には、`bit relay serve` されている間に P2P で誰かが変更した内容は、P2P ノード間で `.git/objects` と `refs/relay/incoming/...` に自動保存される（受け入れサイズ上限あり）。ユーザーや AI はローカルで好きな変更を cherry-pick すればよい。このモデルがうまくいけば、ブロックチェーンのように、もっとも有用なブランチが事実上の fast-forward として扱えるはずだ。

とはいえ、まだ簡単な fetch/clone/sync/PR の仕組みがあるだけで、実際にはもっと多くの機能が必要だろう：

- 複数のリレーサーバー間の同期
- GitHub と PR/issue を共有する仕組み
- クローズドなローカルホストリレー
- リレーサーバーが数日間キャッシュを持ってバックアップする機能
- AI にこのサイクルを理解させるためのプロンプト

現状は趣味レベルの PoC として開発しており、サポートしてくれる人や会社を募集している。不足しているものは多い — Git との完全な互換を保証するための手数、これを組み込むための SDK やドキュメント、そして実際にエージェントクラスターを運用する上での知見。

このコンセプトに未来を感じた人は、 https://x.com/mizchi まで連絡してほしい。

## 主要な概念

bit は Git にプラットフォーム非依存のコラボレーション機能を追加しています。ワークフローに入る前に、通常の Git + GitHub との違いを理解しておきましょう。

### bit — Git 実装

bit は MoonBit で書かれた Git 実装です。一部の未サポート機能（例: `--object-hash=sha256`）を除き、Git と互換性があります。既存の Git リポジトリをそのまま bit で扱え、その逆も可能です。

### hub — 分散型の Issue/PR 管理

GitHub のワークフローでは issue や PR は GitHub サーバー上に存在します。bit では、**リポジトリ内部**に Git notes（`refs/notes/bit-hub`）として保存されます。これにより：

- issue や PR がリポジトリデータの一部となり、特定のホスティングに依存しない
- 中央サーバーなしにピア間で同期できる
- `bit issue init` で任意の git リポジトリにこのメタデータストアを初期化できる

### relay — 共有のためのリレーサーバー

bit-relay は 2 つの問題を解決する軽量リレーサーバーです：

1. **NAT/ファイアウォール越しのリポジトリ共有**: `bit relay serve` でローカルリポジトリを relay 経由で公開し、他者が `bit clone` できる — ポート開放不要
2. **hub メタデータの同期**: `bit relay sync push/fetch` で issue/PR を relay 経由で配信・取得

```
┌──────────┐                      ┌───────────┐
│  Alice    │──relay serve────────│           │────clone────▶ Bob
│ (ホスト)  │──sync push──────▶  │  bit-relay │                │
│           │                     │ (サーバー)  │◀──sync fetch── │
└──────────┘                      └───────────┘
```

コード（blob/tree/commit）は `serve`/`clone` で転送されます。hub メタデータ（issue/PR）は `sync push`/`sync fetch` で転送されます。これらは独立した操作です。

デフォルトの relay URL は本プロジェクトからデプロイされた公開インスタンスを指します。独自にデプロイすることも可能です — 詳細は [デプロイガイド](./scaling.md) を参照してください。

### sender — あなたの識別子

`sender` は relay 上でのあなたの識別名です（例: `alice`）。Ed25519 署名鍵と組み合わせることで、メッセージの発行者を証明します。GitHub 検証を行うと sender 名が GitHub ユーザー名と紐付き、`alice/my-repo` のような名前付きセッションが使えるようになります。

### session — 一時的な relay エンドポイント

`bit relay serve` を実行すると、relay に**セッション**が作成されます。セッションはランダム ID（例: `AbCdEfGh`）または名前付きパス（例: `alice/my-repo`）で識別される一時的なエンドポイントです。`serve` コマンドの実行中のみ有効です。

## 前提条件

- **bit CLI** がインストール済み:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/mizchi/bit-vcs/main/install.sh | bash
  ```
- 稼働中の **bit-relay** サーバー URL（例: `relay+https://relay.example.com`）
- （任意）署名付き publish 用の **Ed25519 署名鍵**

セットアップの確認:

```bash
bit --version
curl https://relay.example.com/health
# => {"status":"ok","service":"bit-relay"}
```

## 1. 環境設定

### 環境変数

relay URL と sender ID を環境変数で設定します:

```bash
# relay URL（serve/sync コマンドのデフォルト値）
export BIT_RELAY_URL=relay+https://relay.example.com

# sender ID（あなたの識別名）
export BIT_RELAY_SENDER=alice

# （任意）署名鍵ファイルのパス
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

## 2. GitHub ユーザー名検証

relay が署名を要求する場合、署名鍵を GitHub アカウントと紐付けることで本人確認ができます。Ed25519 鍵と GitHub SSH 鍵の照合により身元を証明します。

```bash
# 鍵を登録し GitHub SSH 鍵と照合
#（BIT_RELAY_SENDER と BIT_RELAY_SIGN_PRIVATE_KEY_FILE の設定が必要）
bit relay sync push relay+https://relay.example.com
```

検証完了後、relay セッションでランダム ID の代わりに名前付きパス（例: `alice/my-repo`）が使えるようになります。

## 3. リポジトリの初期化

git リポジトリを作成し、hub メタデータを初期化します:

```bash
# リポジトリを新規作成
mkdir my-project && cd my-project
bit init
echo "# My Project" > README.md
bit add .
bit commit -m "initial commit"

# issue/PR トラッキングを初期化
bit issue init
```

## 4. issue の作成

issue は対処すべき問題やタスクを宣言するものです:

```bash
# issue を作成（解決策ではなく、問題を記述する）
bit issue create --title "ログインページで特殊文字入力時にクラッシュする" \
  --body "パスワード欄に特殊文字を入力するとクラッシュが発生する"

# issue 一覧の確認
bit issue list
```

## 5. hub データを relay に push

ローカルの hub メタデータ（issue, PR, note）を relay サーバーに送信します:

```bash
bit relay sync push relay+https://relay.example.com
```

## 6. relay 経由でリポジトリを公開

リポジトリを relay 経由でリモート clone 可能にします:

```bash
bit relay serve relay+https://relay.example.com
```

出力:

```
Session registered: abc123
Clone URL: relay+https://relay.example.com/abc123
```

clone URL を共同作業者に共有してください。コマンドが実行中の間、セッションは有効です。

### オプション

| オプション | 説明 |
|-----------|------|
| `--allow-remote-push` | リモートからの push を受け付ける（`refs/relay/incoming/` に保存） |
| `--auto-fetch` | feature broadcast 検知時に自動 fetch |
| `--repo <name>` | リポジトリ名を指定（名前付きセッションを有効化） |

## 7. relay から clone

共同作業者は公開されたリポジトリを clone できます:

```bash
bit clone relay+https://relay.example.com/abc123
cd abc123
```

## 8. relay から hub データを取得

clone 後、relay から hub メタデータ（issue, PR）を取得します:

```bash
bit relay sync fetch relay+https://relay.example.com
```

取得後の確認:

```bash
# issue 一覧
bit issue list

# PR 一覧
bit pr list
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

## relay URL 形式

| 形式 | 動作 |
|------|------|
| `relay+https://host` | relay API を直接使用（TLS） |
| `relay+http://host` | relay API を直接使用（非 TLS、ローカル開発用） |
| `https://host/repo.git` | smart-http を試行、404 時に relay fallback |

## トラブルシューティング

- **"session not found"**: ホスト側の `bit relay serve` が停止した可能性があります。ホストに再起動を依頼してください。
- **署名エラー**: `BIT_RELAY_SENDER` と `BIT_RELAY_SIGN_PRIVATE_KEY_FILE` が設定されているか確認するか、`RELAY_REQUIRE_SIGNATURE=false` で起動した relay を使用してください。
- **接続拒否**: relay URL が正しいか、サーバーが起動しているか確認してください（`curl <relay-url>/health`）。
