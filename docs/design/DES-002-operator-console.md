# DES-002 運営の画面

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-002 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | Cognito（マネージドログイン）、管理 API の Lambda（運営の操作）、SPA |
| 承認者 | 開発者 |
| ステータス | 実装済 |
| 版 | 1.0 |

## 目的・背景

運営が画面から、署名鍵・鍵セットの登録、公開、チャンネル提供者の管理、チャンネルの取り下げ、操作の記録の確認をできるようにする（[ARCH-001](architecture.md)）。署名鍵と鍵セットの登録は `tools/provision` でもできる。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| ARCH-001 | A-3（HTTP API・JWT）、A-4（全員 MFA）、A-8・A-9（署名鍵・鍵セット）、A-18（WAF・流量の制限） | 実装 |
| API-001 | C-2、C-5〜C-10、運営の操作のうち審査を除くもの | 実装（下表） |
| DM-001 | PUB・CH・REVOKE・SIGNKEY・KEYSET・PUBLICATION・AUDIT、M-9〜M-11 | 管理 API が読み書きする |

## 方針・決定事項

### 決定事項

| No. | 論点 | 決定 |
|---|---|---|
| O-1 | 範囲 | 審査の操作（審査待ち・見本・判定）は [DES-005](DES-005-review.md)、チャンネル提供者の画面は [DES-003](DES-003-publisher-console.md) |
| O-2 | SPA | React + Vite（TypeScript）。API の型は OpenAPI から作る（`packages/api-types`） |
| O-3 | ログインの画面 | Cognito のマネージドログイン（v2）。SPA は認可コード + PKCE |
| O-4 | MFA | Cognito の MFA はユーザープール単位でしか決められないため、1 つのプールで全員 TOTP 必須（ARCH-001 A-4） |
| O-5 | 開発用の運営 | Claude が配備後に作る（tofumiyoshi@gmail.com） |

### 運営の API（API-001 のうち、審査を除く）

| 操作 | パス |
|---|---|
| ログインしている人 | `GET /api/me` |
| チャンネルの確認・取り下げ | `GET /api/channels/{channelId}`、`POST /api/admin/channels/{channelId}/revoke` |
| チャンネル提供者 | `GET /api/admin/publishers`、`GET …/{publisherId}`、`GET …/{publisherId}/channels`、`POST …/suspend`・`…/resume`、`PUT …/limits` |
| 署名鍵・鍵セット | `GET`・`POST /api/admin/signing-keys`、`GET`・`POST /api/admin/keysets` |
| 公開 | `GET`・`POST /api/admin/publications` |
| 操作の記録 | `GET /api/admin/audit` |

### 実装上の判断

| No. | 判断 | 理由 |
|---|---|---|
| J-1 | `/api/{proxy+}` を 1 つの Lambda に送り、Lambda の中で振り分ける。JWT は API Gateway で確かめ、役割（`cognito:groups`）は Lambda で確かめる | ルートを増やしても API Gateway の設定が増えない |
| J-2 | 状態を変える書き込みは、事前に読んで `If-Match` と状態を確かめ（412・409）、書き込みでも `rev` と状態を条件にし、操作の記録を同じトランザクションに入れる | API-001 C-8、DM-001 M-11・DV-10 |
| J-3 | 一覧の続きの位置は AES-256-GCM で暗号化（本番の鍵は Secrets Manager の乱数の SHA-256。開発用は合成のときの乱数を環境変数で） | API-001 C-9 |
| J-4 | 鍵セットを登録すると、載った鍵は `active`、`revokedKeys` の鍵は `revoked`、載らなくなった `active` の鍵は `retiring` にし、公開の Lambda を呼ぶ | ARCH-001 A-8・A-9 |
| J-5 | 取り下げはチャンネルをリストから外し（`LISTED` を消す）、承認済みの申請を `revoked` にし、公開の Lambda を呼ぶ。`versions` を指定してもチャンネルはリストから外れる | DM-001 M-9 |
| J-6 | SPA は `config.json` を起動時に読む（配備時に CDK が書く）。トークンは `sessionStorage`。ログアウトは Cognito の `/logout` | 1 回のビルドを両方の環境で使う。localStorage を避ける |
| J-7 | SPA の CSP は自分と Cognito だけを許す。HSTS・`X-Frame-Options: DENY`・nosniff・`Referrer-Policy: no-referrer` | 乗っ取られたスクリプトでトークンを持ち出させない |
| J-8 | 本番は WAF をユーザープールに付ける（IP ごとに 5 分 300 回、AWS の IP 評判リスト）。開発用は付けない（[費用](../operations/cost.md)）。API Gateway のステージは毎秒 20・バースト 40 | ARCH-001 A-18（HTTP API には WAF を付けられない） |
| J-9 | post-confirmation トリガーは、自分で登録した人（`PostConfirmation_ConfirmSignUp`）だけを `publisher` に入れる | 運営は管理者だけが作る |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 1 | SPA のソースマップを公開用のバケットに置いている（ソースが読める） | 秘密は含まない。気になるなら本番で外す |
| 3 | Cognito の確認コードのメールは Cognito の既定の送信（1 日の上限が小さい） | 本番は SES（ARCH-001 A-19 と同じ送信元）にする |

## 関連ドキュメント・参照リンク

- [ARCH-001](architecture.md)、[API-001](../contracts/console-api.md)、[DM-001](data-model.md)、[DES-001](DES-001-publisher.md)
- [配備の手順](../operations/deploy.md)
