# DES-004 機械審査と試用チケット

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-004 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | 機械審査の Lambda（Kotlin、`core-format`）、試用チケットの API と画面 |
| 承認者 | 開発者 |
| ステータス | 実装済 |
| 版 | 1.0 |

## 目的・背景

[DES-003](DES-003-publisher-console.md) でチャンネル提供者が上げたパッケージを、アプリと同じコード（yorisoi-platform の `core-format`）で確かめ、合格なら運営の審査待ちに入れる（ARCH-001 A-11）。あわせて、機械審査に合格した申請を、チャンネル提供者が審査の前に自分の端末で試せる試用チケットを出す（ARCH-001 A-13、platform API-CHANNEL-LIST）。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| ARCH-001 | A-11（機械審査）、A-13（試用チケット）、A-8（署名鍵で署名） | 実装 |
| API-001 | C-1（見本用のプロンプトをプロンプト・パックで組み立てる）、試用チケットの操作、`Validation` | 実装 |
| DM-001 | 申請の `uploading` → `validating`/`awaiting_review`/`validation_failed`、`samples/`、TICKET、QUOTA の `tickets`、M-4 | 実装 |
| platform API-CHANNEL-LIST・platform API-CHANNEL-PACKAGE | 試用チケットの形式、確認の手順 2〜10 とエラーコード | 実装 |

## 方針・決定事項

| No. | 判断 | 理由 |
|---|---|---|
| J-1 | 機械審査は Java 21 の Lambda（Kotlin）。S3 の `intake/` へのアップロードで起動し、パッケージとアイコンの両方がそろった時点で確かめる | アプリと同じ `core-format` の判定を使う（審査とアプリの判定をずらさない） |
| J-2 | 判定（`MachineReview`）と AWS の読み書き（`Handler`）を分ける。判定は単体テストで確かめる | AWS なしでテストできる |
| J-3 | `core-format` の確認（ZIP・署名・`channel.json`・スロット）に加えて、チャンネル ID の一致（`id_mismatch`）、申請したときのチャンネル提供者のアカウントIDの一致（`publisher_mismatch`）、最後に承認した版より新しいこと（`version_not_newer`）、アイコン（PNG、256×256 以下、100KB 以下。`bad_icon`）を確かめる。パッケージとアイコンの問題は両方返す | 管理システムだけが知っていること |
| J-4 | 合格: 申請を `awaiting_review` にし、審査待ちの一覧（`QUEUE#REVIEW`）に入れ、版・SHA-256・大きさ・アイコンの SHA-256・結果を記録し、見本用のプロンプト（`ReviewSamples`）を記録用の S3 の `samples/{申請ID}/prompts.json` に置く | DES-005 の審査で使う |
| J-5 | 不合格: 申請を `validation_failed` にし、理由（エラーコードと詳細）を記録し、チャンネルを空け、ファイルを `archive/` に移す（90 日で消える） | DM-001 M-4 |
| J-6 | 両方のファイルの通知が同時に来ても、記録は `state = uploading` を条件にした 1 つのトランザクションなので、1 回しか記録されない | DM-001 M-11 |
| J-7 | 機械審査の操作の記録は、actor を `system`（`machine-review`）として残す | DV-10 |
| J-8 | 試用チケットは、機械審査に合格した申請（審査待ち・審査中・差し戻し・承認）だけ。パッケージを公開用の S3 の `trial/{SHA-256}.zip` に写し（7 日で消える。差し戻しは `archive/` から、承認済みは `pkg/` をそのまま使う）、1 日 10 枚まで | platform API-CHANNEL-LIST、DM-001 M-2 |
| J-9 | 試用チケットは、ルート鍵で検証した今の鍵セットのうち、期間内で失効しておらず `active` の最新の署名鍵で署名する（公開の処理と同じ選び方）。KMS の署名は、鍵ポリシーで管理 API の Lambda にも、`ED25519_SHA_512`・`RAW` に限って許す | ARCH-001 A-8。IAM 側では許さない |
| J-10 | QR コードには、署名済みの文書の JSON をそのまま入れる（約 750 文字）。画面で qrcode-generator で描く | platform API-CHANNEL-LIST |
| J-11 | 機械審査の Lambda は GitHub Packages から `core-format`（yorisoi-platform）とプロンプト・パック（yorisoi-sanpoguide）を読み込む。CI は `GITHUB_TOKEN`（`packages: read`）、手元は各リポジトリで `publishToMavenLocal` したものでもよい | 公開リポジトリのパッケージなので、ほかのリポジトリの CI からも読める |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 1 | 機械審査の Lambda のコールドスタート（Java）は数秒 | 審査は非同期で、チャンネル提供者の待ちは数十秒以内。問題になれば SnapStart |

## 関連ドキュメント・参照リンク

- [DES-003](DES-003-publisher-console.md)、[API-001](../contracts/console-api.md)、[DM-001](data-model.md)、[通しの確認](../../tools/e2e/README.md)
- [platform API-CHANNEL-LIST](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-LIST.md)・[platform API-CHANNEL-PACKAGE](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-PACKAGE.md)
