# DES-001 公開の処理・ルート鍵の CLI・準拠テスト

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-001 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | チャンネル管理システムの土台: 公開の処理（Lambda）、ルート鍵の CLI、platform API-CHANNEL-LIST の準拠テスト、AWS CDK |
| 承認者 | 開発者 |
| ステータス | 実装済 |
| 版 | 1.0 |

## 目的・背景

承認済みチャンネル・リスト（platform API-CHANNEL-LIST）を作って署名し、公開する土台（[ADR-001](../adr/ADR-001-aws-architecture.md) A-6〜A-10・A-16・A-17）。チャンネル提供者・運営の画面がなくても、リストの発行元として署名済みのリストを出せる。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| ADR-001 | A-6〜A-10、A-16、A-17 | 実装 |
| DM-001 | PUBLICATION・KEYSET・SIGNKEY・CHANNEL（LISTED）・REVOKE（REVOKED）、M-9、M-11、M-13 | 公開の処理が読み書きする |
| platform API-CHANNEL-LIST | P-1〜P-3、P-6〜P-9、確認観点 V-01〜V-09・V-15・V-16 | 実装と準拠テスト |

## 方針・決定事項

### 決定事項

| No. | 論点 | 決定 |
|---|---|---|
| I-2 | パッケージの管理 | npm workspaces |
| I-3 | 準拠テスト | TypeScript（vitest）。アプリ（Kotlin + Tink）とは別の実装で確かめる |

### 構成

| 場所 | 中身 |
|---|---|
| `packages/protocol` | platform API-CHANNEL-LIST の文書の作成と検証（署名付き文書、要約への署名、リストID・アカウントID、エラーコード）。公開の処理・CLI・準拠テストが共通に使う。`./testing` はテスト用のリスト |
| `api/src/publish` | 公開の処理。DB・S3・CloudFront・KMS は差し替え口（`ports.ts`）の後ろにあり、AWS の実装（`aws.ts`）と手元の実装（`local.ts`）がある |
| `tools/root-key` | オフラインの端末で使うルート鍵の CLI（`generate`・`sign-keyset`・`verify-keyset`） |
| `conformance` | 任意のリストの URL に対する準拠テスト（ライブラリと CLI） |
| `infra` | CDK: DynamoDB（DM-001）、S3（公開用・記録用）、CloudFront（OAC）、KMS（Ed25519）、公開の Lambda、毎日の作り直し、警報 |

### 実装上の判断

| No. | 判断 | 理由 |
|---|---|---|
| J-1 | 公開の処理は、書き出す前に、作ったリストと検出の文書を自分で検証する（アプリと同じ検証） | KMS の鍵が鍵セットの鍵と違う、鍵セットが固定したルート鍵の署名でない、などの誤りを公開しない |
| J-2 | 固定したルート鍵（設定）からつながらない鍵セットでは公開しない | ADR-001 A-9 |
| J-3 | `seq` は `HEAD` の条件付き更新と履歴の追加を 1 つのトランザクションで行い、食い違えば何も公開せずに 1 回だけ作り直す。Lambda の同時実行は 1 | DM-001 M-11、ADR-001 A-10 |
| J-4 | KMS の鍵ポリシーで、公開の Lambda だけに、`ED25519_SHA_512`・`RAW` に限って `kms:Sign` を許す。IAM 側では許さない | ADR-001 A-8。条件のない許可を作らない |
| J-5 | ルート鍵の秘密鍵は合言葉（16 文字以上）で暗号化した PKCS#8 で保存する。Git の作業ツリーの中には作らない | 写しが出回っても使えないようにする。誤ってコミットしないようにする |
| J-6 | 準拠テストは取得の大きさの上限で打ち切り、リダイレクトを追わない。`http://localhost`・`127.0.0.1` は `--allow-local-http` のときだけ許す | platform API-CHANNEL-LIST の `too_large`、アプリのデバッグビルドと同じ |
| J-7 | 一覧の有効期限は 14 日、毎日 03:00（日本時間）に作り直す。成功が 2 日ないと警報 | 期限切れの前に必ず気づく |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 3 | `npm audit` が `aws-cdk-lib` に同梱の `brace-expansion` を 1 件報告（high）。`cdk synth` のときだけ使い、Lambda には入らない | aws-cdk-lib の更新を待つ |
| 4 | 本番のルート鍵はまだない（ADR-001 T-1） | 手順書を作ってから、オフラインの端末で作る |
| 5 | 独自ドメイン（ADR-001 T-2）がないので、CloudFront の既定の証明書（TLS の最低の版を指定できない） | ADR-001 T-2 で証明書と TLS 1.2 以上を設定する |

## 関連ドキュメント・参照リンク

- [ADR-001](../adr/ADR-001-aws-architecture.md)、[DM-001](../data-model.md)、[API-001](../console-api.md)
- [platform API-CHANNEL-LIST](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-LIST.md)
