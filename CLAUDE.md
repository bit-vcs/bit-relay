# bit-relay Release Policy (Cloudflare)

## Public release profile (default production)

Cloudflare の本番環境は、まず利用者が試しやすいことを優先し、以下の「緩い公開設定」で運用する。

- `BIT_RELAY_AUTH_TOKEN`: **unset**（API/WS の Bearer 認証を要求しない）
- `RELAY_REQUIRE_SIGNATURE`: **false**（署名なし publish を許可）
- `RELAY_ROOM_TOKENS`: **unset** または `{}`（room token を必須にしない）

この設定は「公開リレーとしての参加容易性」を目的としたもので、セキュアな閉域運用を目的としない。

## Strict profile (private/team relay)

チーム内運用や制限付き運用では、別環境を用意して以下を有効化する。

- `BIT_RELAY_AUTH_TOKEN` を設定
- `RELAY_REQUIRE_SIGNATURE=true`
- 必要に応じて `RELAY_ROOM_TOKENS` を設定

## Compatibility policy

- 公開環境は後方互換を優先し、既存クライアントが接続不能になる破壊的なデフォルト変更は避ける。
- 厳格化（認証必須化・署名必須化）は、別環境または明示的な移行告知付きで実施する。
