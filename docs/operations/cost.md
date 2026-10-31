# 費用

開発用は費用を最小限にする。本番は守りを優先し、ADR-001 のとおりにする。どちらも `infra/lib/config.ts` の `cost` で切り替え、本番の設定は変えない。

## 環境ごとの違い

| 項目 | 開発用（dev） | 本番（prod） | 開発用で外す理由 |
|---|---|---|---|
| WAF（ユーザープール、ADR-001 A-18） | なし | あり（約 7 USD/月） | 費用のほとんど。開発用は登録を公開していない |
| 一覧のカーソルの鍵（API-001 C-9） | 合成のときに作る乱数を Lambda の環境変数で渡す（配備のたびにカーソルが切れる） | Secrets Manager（0.4 USD/月） | 開発用ではカーソルが切れても困らない |
| DynamoDB の PITR | なし | あり | 開発用のデータは作り直せる |
| Lambda のログ | 14 日で消す | 消さない | 溜まり続けないように |
| 予算の通知（AWS Budgets） | 月 5 USD。実績が 80% を超えたとき、または予測が 100% を超えたときにメール | なし（本番の配備時に決める） | 想定外の費用にすぐ気づく |

どちらの環境も、全リソースに `project=yorisoi-console` と `environment=<dev|prod>` のタグを付ける（`infra/bin/app.ts`）。同じ AWS アカウントのほかのプロジェクトと分けて費用を見るため。

## 開発用の費用の目安（月額、東京リージョン）

| 項目 | 目安 |
|---|---|
| KMS の署名鍵（1 つ） | 1 USD |
| CloudWatch の警報（2 つ） | 約 0.3 USD |
| Cognito（月 1 万人まで無料）、CloudFront（無料枠）、Lambda、API Gateway、S3、DynamoDB、EventBridge Scheduler、AWS Budgets（2 つまで無料） | ほぼ 0 |
| **合計** | **約 1.5 USD** |

公開されている単価からの目安。実際の額は、予算の通知と、請求の画面でタグ `project` を絞り込んで確かめる。

## 運営の AI（中継）

中継（`YorisoiAiRelay-<env>`）の費用は、ほとんどが Bedrock のモデルの利用料で、使った分だけかかる。解説 1 回（入力約 600〜750・出力約 290〜340 トークン）で、DeepSeek V3.2 は約 0.0012 USD、Haiku 4.5 は約 0.0024 USD。月の上限は Parameter Store の予算で決まり、中継が自分で止める（[運営の AI の手順](ai-relay.md)）。ほかは、本番の WAF が約 7 USD/月、警報 4 つが約 0.4 USD/月で、API Gateway・Lambda・DynamoDB はほぼ 0。費用はタグ `project=yorisoi-ai-relay` で分けて見る。

## スタジオ

スタジオ（`YorisoiStudio-<env>`）の費用は、一言と掲載の確認の運営の AI（中継の月の予算に含まれる）と、掲載の音声の Amazon Transcribe（音声の長さに応じた料金）が主で、使った分だけかかる。ほかは警報 4 つが約 0.4 USD/月、本番の WAF が約 7 USD/月。費用はタグ `project=yorisoi-studio` で分けて見る（[スタジオの手順](studio.md)「費用」）。

## 一度だけ要る操作

予算はタグ `project` の付いた費用だけを数える。そのためには、請求の画面（Billing and Cost Management → コスト配分タグ）で、ユーザー定義のタグ `project` を有効にする必要がある。タグが請求の画面に出てくるまで、リソースにタグを付けてから最大 24 時間かかる。

```sh
aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=project,Status=Active
```

有効にするまでは、予算は 0 USD と数える（通知は来ない）。

## 費用を下げる案のうち、採らなかったもの

| 案 | 採らない理由 |
|---|---|
| 使わないときに `cdk destroy` でスタックを消す | KMS の鍵は消えずに残る（1 USD/月は変わらない）。作り直すたびに署名鍵と鍵セットの登録がやり直しになる |
| 開発用でも KMS をやめ、手元の鍵で署名する | 本番と違う署名の経路になり、KMS での署名を開発用で確かめられなくなる |
| 警報を外す | 0.3 USD のために、公開が止まったことに気づけなくなる |
