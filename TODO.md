# TODO: bit-relay 拡張計画（GitHub 連携 / マルチリレー / 永続キャッシュ / Issue 同期 / CI トリガー）

## ゴール

- GitHub を relay の 1 つの upstream/downstream として扱えるようにする
- relay を複数ノードで運用し、キャッシュ交換と永続化（R2 等）を可能にする
- bit issue / GitHub issue の双方向連携を段階的に実現する
- `refs/relay/incoming/` を CI トリガーの入力として扱えるようにする

## 前提方針

- 既存 API 互換は維持（破壊的変更は `v2` エンドポイントで追加）
- 実装は TDD（探索 → Red → Green → Refactor）で進める
- コントラクト（API/型）を先に固定し、実装は差し替え可能にする

## 実装順（依存順）

1. M0: 契約定義と観測基盤
2. M1: GitHub を RelayTarget 化（clone/fetch + 認証付き push 経路）
3. M2: 複数 relay ノードのキャッシュ交換
4. M3: 永続キャッシュ層（R2）とキャッシュノード clone
5. M4: bit issue キャッシュ（アクティブノード不在でも取得可能）
6. M5: GitHub issue → bit issue sync
7. M6: `refs/relay/incoming/` 受信トリガーと外部 CI 連携

---

## M0 契約定義と観測基盤

### TODO

- [x] `RelayTarget` 抽象を定義（`clone/fetch/push/notify`）
- [x] 認証コンテキスト `AuthContext` を定義（匿名 / relay admin / GitHub app token）
- [x] イベント契約 `RelayEvent` を定義（`incoming_ref`, `issue_synced`, `cache_replicated`）
- [x] 設定スキーマを追加（env + JSON）：GitHub 連携、R2、peer relays、webhook
- [x] 監査ログの最小項目を定義（誰が、どの ref/issue を、どこへ）

### TDD

- [x] 探索: 既存 `memory_handler.ts` / `git_serve_session.ts` の責務を分離する差分設計を書く
- [x] Red: 契約テスト（型 + runtime validation）を先に追加
- [x] Green: 契約を満たす最小実装
- [ ] Refactor: handler 層と adapter 層に分離

### 完了条件

- [x] 新規機能の実装が `RelayTarget` 経由で追加できる状態
- [x] 主要イベントが構造化ログとして追跡できる状態

---

## M1 GitHub を RelayTarget 化（要件1）

### スコープ

- GitHub repository を relay 先の 1 つとして扱う
- relay/gateway が認証を保持している場合に、管理 API 経由で push と GitHub Actions 起動を可能にする

### TODO

- [x] `GitHubRelayTarget` adapter 実装
- [x] clone/fetch 用 read パス（GitHub smart-http または git protocol 呼び出し）
- [x] admin 用 push パス（PAT or GitHub App 経由）
- [x] `workflow_dispatch` / `repository_dispatch` の起動 API
- [x] 管理プレーン API（認証必須）を追加: `POST /api/v1/admin/github/repos/register`
- [x] 管理プレーン API（認証必須）を追加: `POST /api/v1/admin/github/repos/:id/push`
- [x] 管理プレーン API（認証必須）を追加: `POST /api/v1/admin/github/repos/:id/actions/dispatch`

### TDD

- [ ] 探索: GitHub API 制約（権限、レート、失敗時リトライ）を fixture 化
- [x] Red: adapter 単体テスト（成功/401/403/422/429）
- [ ] Red: E2E（relay -> GitHub mock -> action dispatch）
- [x] Green: API 実装 + 認証ガード
- [ ] Refactor: GitHub 呼び出しを transport 層へ分離

### 完了条件

- [x] 認証済み管理 API から GitHub push/action が実行できる
- [x] 失敗時の再試行ポリシーと監査ログが動作する

---

## M2 複数 relay のキャッシュ交換（要件2）

### TODO

- [ ] relay 間 peer discovery 設定（静的リスト + 将来拡張）
- [ ] `cache.exchange` プロトコル（差分カーソル方式）を定義
- [ ] 衝突解決ルール（同一 id、異なる payload）を定義
- [ ] ループ防止（origin/ttl/hop_count）を追加

### TDD

- [ ] 探索: 2 ノード / 3 ノード / partition 復旧シナリオを先に定義
- [ ] Red: 交換プロトコルの整合性テスト
- [ ] Red: E2E マルチノード負荷テスト
- [ ] Green: peer 同期ワーカー実装
- [ ] Refactor: 同期状態管理を独立モジュール化

### 完了条件

- [ ] relay A/B/C 間で最終的整合性が成立する
- [ ] 再送・重複・ネットワーク分断後の復旧が再現テストで通る

---

## M3 永続キャッシュ層（R2） + キャッシュノード clone（要件3）

### TODO

- [ ] CacheStore 抽象（memory / R2 / 将来 S3）を追加
- [ ] 通信通過データの write-through 保存（objects, pack, refs, issues）
- [ ] キャッシュ索引（content hash, ref, room, updated_at）を定義
- [ ] R2 から clone/fetch 可能な read path を追加
- [ ] GC/TTL と容量上限ポリシーを追加

### TDD

- [ ] 探索: 大容量 pack の分割戦略・整合性検証方法を決める
- [ ] Red: CacheStore contract test（同一テストを memory/R2 両方で実行）
- [ ] Red: node down 時の cache hit E2E
- [ ] Green: write-through + read fallback 実装
- [ ] Refactor: 永続化キュー/再試行を分離

### 完了条件

- [ ] アクティブ serve ノード不在でもキャッシュから clone/fetch できる
- [ ] R2 障害時は degraded mode で relay 本体は継続稼働する

---

## M4 bit issue キャッシュ（要件4）

### TODO

- [ ] `topic=issue` の永続保存と検索 API を追加
- [ ] issue スナップショット + 増分イベントを保持
- [ ] room 単位の issue cursor を永続化
- [ ] ノード不在時の issue pull エンドポイントを追加

### TDD

- [ ] 探索: 既存 `poll` と重複しない API 契約を決める
- [ ] Red: issue 作成/更新/close/再オープンの整合性テスト
- [ ] Red: offline node 想定 E2E（origin 停止中でも取得可）
- [ ] Green: issue cache 実装
- [ ] Refactor: issue projection 層を分離

### 完了条件

- [ ] active node なしでも relay から issue 取得可能
- [ ] cursor 再開時に重複なく追従できる

---

## M5 GitHub issue -> bit issue sync（要件5）

### TODO

- [ ] GitHub webhook 受信エンドポイント（`issues`, `issue_comment`, `label`）
- [ ] GitHub event -> bit issue event のマッピング定義
- [ ] idempotency key（`delivery_id`）で重複防止
- [ ] 同期失敗時の DLQ / retry キュー

### TDD

- [ ] 探索: 一方向同期（GitHub -> bit）から開始し、競合時ルールを確定
- [ ] Red: webhook 署名検証テスト
- [ ] Red: 同一イベント再送テスト（重複抑止）
- [ ] Green: mapper + apply 実装
- [ ] Refactor: provider 非依存の issue sync engine へ分離

### 完了条件

- [ ] GitHub issue 更新が bit issue へ反映される
- [ ] 再送や順不同イベントでも破綻しない

---

## M6 `refs/relay/incoming/` トリガーと CI 連携（要件6）

### TODO

- [ ] incoming ref 検知フックを追加（serve/push 受信時）
- [ ] TriggerDispatcher 抽象（GitHub Actions / 汎用 Webhook）
- [ ] CI 実行結果の受信 API（status, logs URL, artifact URL）
- [ ] CI 結果を relay event として保存・通知

### TDD

- [ ] 探索: `refs/relay/incoming/*` から CI ジョブ識別子への変換規則を決める
- [ ] Red: ref 受信 -> dispatch 呼び出しテスト
- [ ] Red: CI callback 受信 -> 状態遷移テスト
- [ ] Green: trigger + callback 実装
- [ ] Refactor: trigger rule を設定駆動化

### 完了条件

- [ ] incoming ref 受信で外部 CI が起動される
- [ ] CI 結果が relay 経由で購読/取得できる

---

## 横断 TODO（品質・運用）

- [ ] テスト階層を固定: contract / unit / integration / e2e
- [ ] `just test` に新規テストを統合（失敗時に原因が追える粒度）
- [ ] 負荷計測シナリオを追加（multi-relay + cache hit/miss + issue sync）
- [ ] 監査ログとメトリクス（成功率、レイテンシ、再試行回数）を追加
- [ ] ドキュメント更新（`README.md`, `docs/usage-guide-ja.md`, `docs/scaling.md`）

## 未確定事項（実装前に決める）

- [ ] GitHub 認証方式の初期選択（PAT 優先か GitHub App 優先か）
- [ ] relay 間通信の認証方式（共有鍵 / mTLS / 署名トークン）
- [ ] R2 キャッシュ保持期間と上限コスト
- [ ] issue 同期の正（source of truth）をどちらに置くか
- [ ] CI 結果をどの room/topic に配信するか
