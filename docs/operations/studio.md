# スタジオの手順

スタジオ（platform [REQ-STUDIO](https://github.com/duwenji/yorisoi-platform/blob/main/docs/requirements/REQ-STUDIO.md)・[API-LOCAL-MATERIALS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-LOCAL-MATERIALS.md)、設計は [DES-013](../design/DES-013-studio.md)）を配備し、利用規約の版を上げ、止め、確かめる手順。スタジオは別のスタック（`YorisoiLocalMaterials-<env>`）で、別の CDK アプリ（`infra/bin/local-materials.ts`）から配備する。提供者・運営の画面は管理システムの「スタジオ」タブにある（使い方は[運営ガイド](../manual/operator.md#13-スタジオ)と[スタジオのガイド](../manual/studio.md)）。

## 構成

| 部品 | 内容 |
|---|---|
| API Gateway（REST API、ステージ `api`） | `/v1/local/terms`・`/v1/local/cells`・`/v1/local/notes`・`/v1/local/notes/mine`・`/v1/local/reactions`・`/v1/local/reports`・`/v1/local/blocks`。本番は AWS WAF で送信元ごとに回数を絞る |
| スタジオの Lambda（`api/src/local/handler.ts`） | 中継のトークンの確認、一言を置く（決まった形 → 運営の AI で確認）、区画の一覧、反応・通報・ブロック。本文・区画・置いた人の値はログに書かない |
| スタジオの確認の Lambda（`api/src/local/studio-handler.ts`） | 管理システムが「載せる」と呼ぶ。長さ・形式 → Amazon Transcribe（日本語、バッチ）→ 運営の AI。Transcribe の終わりは EventBridge のルール（`TranscribeDone`）で受ける |
| DynamoDB | 一言・スタジオ・区画ごとの写し・日ごとの数・ブロック・締め出し・置けない区画・運営の列。項目は DES-013「データモデル」 |
| S3（受け取り用） | `uploads/`（提供者が送った音声、1 日）・`held/`（確認を始めた音声、30 日）・`transcripts/`（30 日） |
| S3（配信用）＋ CloudFront | `studios/{id}/audio.m4a`（確かめた音声、62 日）。アプリは認証なしで取る |
| Parameter Store | `/yorisoi-local-materials/<env>/terms-version`・`terms-url`・`terms-updated-at`（一言の利用規約）・`paused`（止める）。管理システム向けに `table-name`・`intake-bucket`・`audio-bucket`・`check-function` |
| 中継とのつながり | 中継の表（`/yorisoi-ai-relay/<env>/table-name`）のトークンを読み、中継のモデルと月の予算に従い、運営の AI の費用を中継の月の合計に足す。予算に達すると一言を置けない（`relay_paused`） |
| CloudWatch の警報 → SNS（メール） | 一言の確認の失敗が 5 分で 10 回、設定の値が正しくない、通報で一言が隠れた、通報でスタジオが止まった |

設定は `infra/lib/local-materials-config.ts` にある。開発用は WAF がなく、スタックを消すとデータも消える。

## 配備

順番は **中継 → スタジオ → 管理システム**（DES-013 K-2）。スタジオは中継の表の名前を、管理システムはスタジオの表・バケット・確認の Lambda の名前を、配備のときに Parameter Store から読む。

```sh
aws sso login --profile sanpo-dev
export AWS_PROFILE=sanpo-dev
cd infra
npx cdk -a "npx tsx bin/local-materials.ts" diff   -c env=dev
npx cdk -a "npx tsx bin/local-materials.ts" deploy -c env=dev
# 管理システムも配備し直す（infra/lib/config.ts の studio が true の環境だけ、スタジオのタブが動く）
npx cdk deploy -c env=dev -c rootPublicKey=YMe_dQimd3AaMZs5izjDlXjnAKdq7Vi9nfagFVjECEI
```

| 環境 | スタジオの URL | 音声の配信 |
|---|---|---|
| 開発用 | https://x568icz881.execute-api.ap-northeast-1.amazonaws.com/api/ | https://d3g41krlk5mgh0.cloudfront.net |
| 本番 | 未配備 | 未配備 |

初めて配備すると、警報の宛先に SNS の確認メールが届く。リンクを開くまで警報は届かない。

- 開発用の中継は配備のたびに端末の鍵が変わる。中継を配備し直すと、開発用のスタジオのブロック・締め出し・自分の一言の判定がつながらなくなる（DES-013 未決事項 1。開発用では受け入れる）
- アプリは URL を組み込んでいる。どのビルドも、本番ができるまでは開発用のスタジオを使う

本番は、配備の前に次を済ませる。

1. 中継の本番を配備する（[運営の AI の手順](ai-relay.md)「配備」）
2. 警報の宛先を `-c alarmEmail=<メール>` で渡す
3. スタジオを配備し、`infra/lib/config.ts` の本番の `studio` を `true` にして管理システムを配備する
4. 各アプリのプライバシーポリシー・データ セーフティ・コンテンツのレーティングが、スタジオに合っていることを確かめる（REQ-STUDIO N-3）

## 一言の利用規約の版を上げる

利用規約（platform [notes-terms.md](https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/notes-terms.md)）を変えたら、版を上げる。アプリは、同意した版より新しい版があると、次に一言を置くときに同意を求める。古い版のままでは置けない（`terms_not_accepted`）。

```sh
# Git Bash ではパスの書き換えを止める
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /yorisoi-local-materials/dev/terms-version --value 2 --overwrite
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /yorisoi-local-materials/dev/terms-updated-at --value 2026-12-01 --overwrite
```

- 版は 1 以上の整数。正しくないときは `studio-config.ts` の値で動き、「設定の値が正しくない」の警報が届く
- 一言の確認の AI への指示（`api/src/local/check.ts`）の版も、利用規約の項目を変えたときは合わせて上げる（DES-013 K-13）。スタジオの決まりを変えたときは、`STUDIO_RULES_VERSION` と画面の版を上げて配備する
- CloudFormation は、`studio-config.ts` の値を変えて配備したときだけパラメータを書き換える。手で変えた値は、配備し直しても残る

## すぐに止める

スタジオ全体を止めるときは `paused` を `true` にする。アプリには `local_paused` が返り、一言もスタジオも届かず、置けなくなる。アプリの散歩・走行はそのまま続く。

```sh
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /yorisoi-local-materials/dev/paused --value true --overwrite
# 戻す
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /yorisoi-local-materials/dev/paused --value false --overwrite
```

1 つのスタジオだけを止めるときは「スタジオ」の画面で（[運営ガイド 13 章](../manual/operator.md#13-スタジオ)）、1 つの一言だけを止めるときは「一言」の画面で（[同 14 章](../manual/operator.md#14-一言)）消す。

## 警報が届いたとき

| 警報 | すること |
|---|---|
| 一言の確認の失敗（`UpstreamError`） | 一言を置けない（`upstream_error`）。中継の警報も届いていれば Bedrock の側の問題。中継の手順の「確かめる」でモデルとクォータを見る |
| 設定の値が正しくない（`InvalidSetting`） | 上の利用規約の版、または中継のモデル・予算の値を直す |
| 通報で一言が隠れた（`NotesHidden`） | 運営の画面の「一言」の「通報された一言」で、戻すか消す |
| 通報でスタジオが止まった（`StudiosSuspended`） | 運営の画面の「通報されたスタジオ」で、戻すか消す。重いものは 24 時間、軽いものは 7 日を目安に決める（スタジオの決まり 4.1） |

## 費用

| 項目 | 目安 |
|---|---|
| 運営の AI（スタジオと一言の確認） | 1 回あたり DeepSeek V3.2 で約 0.0005 USD。中継の月の予算に含まれ、中継と一緒に止まる |
| Amazon Transcribe | スタジオの音声の長さ（1 本 30 秒まで）に応じてかかる。単価は[料金のページ](https://aws.amazon.com/jp/transcribe/pricing/)を東京リージョンにして確かめる。月に文字に起こした秒数は CloudWatch のメトリクス `YorisoiLocalMaterials` / `TranscribeSeconds` で見る |
| 警報 4 つ | 約 0.4 USD/月 |
| 本番の WAF | 約 7 USD/月 |
| API Gateway・Lambda・DynamoDB・S3・CloudFront | 使った分だけ。開発用はほぼ 0 |

費用はタグ `project=yorisoi-studio` で分けて見る。

## 確かめる

```sh
S=https://x568icz881.execute-api.ap-northeast-1.amazonaws.com/api
curl -s $S/v1/local/terms
```

一言を置いて取るところまでは、中継のセッションを開いてから呼ぶ（開発用の中継は Play Integrity を確かめない）。

```sh
R=https://teevxbmiaj.execute-api.ap-northeast-1.amazonaws.com/api
NONCE=$(curl -s -X POST $R/v1/session/challenge | sed -E 's/.*"nonce":"([^"]+)".*/\1/')
TOKEN=$(curl -s -X POST $R/v1/session -H 'content-type: application/json' \
  -d "{\"installId\":\"$(node -e "console.log(crypto.randomUUID())")\",\"nonce\":\"$NONCE\",\"app\":{\"package\":\"io.github.duwenji.yorisoi.sanpoguide\",\"versionCode\":1}}" \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s -X POST $S/v1/local/notes -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"階段の上から見る夕日がきれいです","cell":"xn77k2n","spotName":"夕やけだんだん","ttl":"1h","termsVersion":1}'
curl -s "$S/v1/local/cells?cells=xn77k2&kinds=note,studio" -H "authorization: Bearer $TOKEN"
```

ログ（`YorisoiLocalMaterials-<env>-LocalLogs…`・`…StudioCheckLogs…`）には、操作の種類・件数・時間とエラーの `code` だけが出る。
