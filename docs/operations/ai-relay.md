# 運営の AI（中継）の手順

運営の AI の中継（platform [API-AI-RELAY](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-AI-RELAY.md)）を配備し、モデル・上限・予算を変え、止める手順。中継は管理システムとは別のスタック（`YorisoiAiRelay-<env>`）で、別の CDK アプリ（`infra/bin/relay.ts`）から配備する。管理システムの SPA や鍵がなくても配備できる。

## 構成

| 部品 | 内容 |
|---|---|
| API Gateway（REST API、ステージ `api`） | `/v1/session/challenge`・`/v1/session`・`/v1/quota`・`/v1/generate`。本番は AWS WAF で送信元ごとに 5 分 300 回まで |
| Lambda（`api/src/relay/`） | 端末の確認、回数、長さの確認、Bedrock の呼び出し。プロンプトと出力はログに書かない |
| Bedrock | 下の表のモデルを、日本の中で処理する形（東京リージョンのモデルか jp 推論プロファイル）で、Converse API で呼ぶ。Lambda のロールで呼び（キーを持たない）、ロールは表のモデルしか呼べない |
| DynamoDB | nonce・トークン・端末ごとの 1 日の回数・月の費用。どれも期限で消える |
| Parameter Store | `/yorisoi-ai-relay/<env>/model`（モデル）・`/yorisoi-ai-relay/<env>/daily-limit`（1 日の上限）・`/yorisoi-ai-relay/<env>/monthly-budget-usd`（月の予算） |
| CloudWatch の警報 → SNS（メール） | 予算の 80%、予算に達して止まった、設定の値が正しくない、Bedrock の失敗が 5 分で 10 回 |

設定は `infra/lib/relay-config.ts` にある。開発用は Play Integrity を確かめず（AR-4）、WAF もない。

切り替えられるモデル（`relay-config.ts` の `models`）:

| 値 | Bedrock の ID | 処理する場所 | 単価（100 万トークンあたり、入力 / 出力） | 状態 |
|---|---|---|---|---|
| `deepseek-v3-2` | `deepseek.v3.2` | 東京 | 0.74 / 2.22 USD | 既定 |
| `haiku-4-5` | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` | 東京・大阪 | 1.10 / 5.50 USD | 切り替え先。使う前に Anthropic のユースケースを申告する |

どちらも開発用で呼べることを確かめた。表にないモデルを足すときは、`models` に足して配備する（ロールが呼べるモデルも一緒に増える）。単価は月の費用の足し上げに使うので、Bedrock の価格表の東京（推論プロファイルなら jp）の値を入れる。日本の外で処理するモデル・プロファイルは足さない（API-AI-RELAY R-5）。

## 配備

```sh
aws sso login --profile sanpo-dev
export AWS_PROFILE=sanpo-dev
cd infra
npx cdk -a "npx tsx bin/relay.ts" diff   -c env=dev
npx cdk -a "npx tsx bin/relay.ts" deploy -c env=dev
```

| 環境 | 中継の URL |
|---|---|
| 開発用 | https://teevxbmiaj.execute-api.ap-northeast-1.amazonaws.com/api/ |
| 本番 | 未配備 |

初めて配備すると、警報の宛先に SNS の確認メールが届く。リンクを開くまで警報は届かない。

本番は、配備の前に次を済ませる。

1. Haiku 4.5 に切り替えることがあるなら、Anthropic のモデルのユースケースを申告しておく
2. 月の予算を決め、`relay-config.ts` の `monthlyBudgetUsd` に入れる（API-AI-RELAY 未決事項 No.2）
3. Play Integrity のサービス アカウントを作り、鍵を Secrets Manager に入れる（下の節）
4. 警報の宛先を `-c alarmEmail=<メール>` で渡す

## モデル・1 日の上限・月の予算を変える

配備し直さずに Parameter Store の値を変える。中継は 5 分おきに読み直す。

```sh
# Git Bash ではパスの書き換えを止める
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /yorisoi-ai-relay/dev/model --value haiku-4-5 --overwrite
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /yorisoi-ai-relay/dev/daily-limit --value 50 --overwrite
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /yorisoi-ai-relay/dev/monthly-budget-usd --value 10 --overwrite
```

- モデルは上の表の値（API-AI-RELAY R-5）。ほかの値では `relay-config.ts` の既定のモデルで動き、「設定の値が正しくない」の警報が届く。切り替える前に、そのモデルを呼べること（クォータ）を確かめる。呼べないと、すべての生成が `upstream_error` になる
- 1 日の上限は 5〜100 の整数（API-AI-RELAY R-14）。ほかの値では既定の 30 回で動き、「設定の値が正しくない」の警報が届く
- 月の予算は 0 より大きい数（USD）。正しくないときは `relay-config.ts` の値で動く
- その日の途中で上限を変えても、その日に使った回数はそのまま。新しい上限との差が残りになる
- CloudFormation は、`relay-config.ts` の値を変えて配備したときだけパラメータを書き換える。手で変えた値は、配備し直しても残る

## 予算に達したとき

月の費用（呼び出しごとのトークン数 × `relay-config.ts` の単価の合計）が予算に達すると、中継は `relay_paused` を返し、アプリは定型文で続ける。月が変われば（日本時間）自動で戻る。その月のうちに戻すなら、予算の値を上げる。

費用は、そのとき使っているモデルの単価で中継が自分で足し上げる。AWS の請求は反映が遅く、その間に使われすぎないようにするため。実際の請求は、請求の画面でタグ `project=yorisoi-ai-relay` と Bedrock の明細で確かめる。

## すぐに止める

予算に関係なく止めるときは、Lambda の同時実行数を 0 にする。アプリはエラーを受けて定型文で続ける。

```sh
aws lambda put-function-concurrency --function-name <Relay の関数名> --reserved-concurrent-executions 0
# 戻す
aws lambda delete-function-concurrency --function-name <Relay の関数名>
```

## Play Integrity の鍵（本番）

1. Google Cloud のプロジェクトを Play Console のアプリにつなぐ（Play Console → アプリの完全性 → Play Integrity API）
2. そのプロジェクトでサービス アカウントを作り、JSON の鍵を作る。役割は要らない（Play Integrity API の呼び出しはプロジェクトのつながりで許される）
3. 鍵を Secrets Manager に入れ、手元の JSON は消す

```sh
aws secretsmanager create-secret --name yorisoi-ai-relay/prod/play-integrity --secret-string file://service-account.json
```

鍵を入れ替えるときは、新しい鍵で `put-secret-value` し、Lambda の新しいコンテナが読むまで（長くて数時間）古い鍵を残してから Google Cloud で古い鍵を消す。

## 確かめる

```sh
U=https://teevxbmiaj.execute-api.ap-northeast-1.amazonaws.com/api
curl -s -X POST $U/v1/session/challenge
```

ログ（`YorisoiAiRelay-<env>-RelayLogs…`）には、呼び出しごとの種類・トークン数・時間と、エラーの種類だけが出る。Bedrock の失敗は、Bedrock のエラー文（使えるモデル・クォータ・混雑）も出る。
