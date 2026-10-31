# 配備の手順

ADR-001 の構成を AWS に配備し、承認済みチャンネル・リストを出せる状態にする手順。署名鍵と鍵セットの登録は、運営の画面か `tools/provision` で行う。

スタジオを使う環境（`infra/lib/config.ts` の `studio` が `true`。開発用）では、管理システムより先に中継とスタジオを配備しておく（[運営の AI の手順](ai-relay.md)・[スタジオの手順](studio.md)）。管理システムはスタジオの表・バケットの名前を Parameter Store から読む。

## 開発用（dev）

| 項目 | 値 |
|---|---|
| AWS アカウント | 140023390410（SSO プロファイル `sanpo-dev`） |
| リージョン | ap-northeast-1 |
| スタック | `YorisoiConsole-dev` |
| リストID | `sc1363urrzsrhjuxasgz5pnxkcf5mcieqhv` |
| ルート鍵の公開鍵 | `YMe_dQimd3AaMZs5izjDlXjnAKdq7Vi9nfagFVjECEI` |
| 公開 URL | https://d32t2reyxml47d.cloudfront.net |
| 運営の画面 | https://d32w19p7au8cu2.cloudfront.net |
| ログイン | https://yorisoi-console-dev.auth.ap-northeast-1.amazoncognito.com（ユーザープール `ap-northeast-1_dy8A7T1fG`） |
| 運営 | tofumiyoshi@gmail.com（`operator` グループ） |
| 窓口（案内文書の `contact`） | duwenji@gmail.com（通報と権利の申し立て。本番も同じ） |

開発用のルート鍵の秘密鍵と合言葉は、リポジトリの外（配備した端末のユーザーのホームの `.yorisoi-console/dev/`、アクセス権は本人のみ）にある。開発用のリストはアプリに内蔵しない（ADR-001 A-2）。本番のルート鍵は[鍵の手順書](keys.md)に従い、オフラインの端末で作る。

### 手順

```sh
aws sso login --profile sanpo-dev
export AWS_PROFILE=sanpo-dev

# 1. 配備（CDK の bootstrap は済んでいる。版 25）。SPA を先にビルドする
npm run build -w web
cd infra
npx cdk diff   -c env=dev -c rootPublicKey=YMe_dQimd3AaMZs5izjDlXjnAKdq7Vi9nfagFVjECEI
npx cdk deploy -c env=dev -c rootPublicKey=YMe_dQimd3AaMZs5izjDlXjnAKdq7Vi9nfagFVjECEI
cd ..

# 2. 署名鍵と鍵セットを登録し、1 回公開する（済んでいる手順は飛ばす）
npm run provision -w tools/provision -- --env dev --root-key ~/.yorisoi-console/dev

# 3. 準拠テスト
npm run check -w conformance -- https://d32t2reyxml47d.cloudfront.net --provider sc1363urrzsrhjuxasgz5pnxkcf5mcieqhv
```

- `tools/provision` は、スタックの出力から KMS の署名鍵を読み、KMS から公開鍵を取り出して `SIGNKEY` に登録する。鍵セットに載っていない鍵があれば、ルート鍵で新しい鍵セット（`seq` + 1、署名鍵の有効期間 180 日）に署名して `KEYSET` に登録する。最後に公開の Lambda を 1 回呼ぶ
- 以後は、毎日 03:00（日本時間）に EventBridge Scheduler が作り直す
- 運営の画面ができたので、署名鍵と鍵セットの登録は画面（「署名鍵・鍵セット」）でもできる。`tools/provision` は最初の 1 回や、画面が使えないときに使う

### 運営の担当者を足す

運営の担当者は登録の画面からはなれない。管理者が作り、`operator` グループに入れる（ADR-001 A-4）。

```sh
aws cognito-idp admin-create-user --user-pool-id ap-northeast-1_dy8A7T1fG --username <メール>   --user-attributes Name=email,Value=<メール> Name=email_verified,Value=true --desired-delivery-mediums EMAIL
aws cognito-idp admin-add-user-to-group --user-pool-id ap-northeast-1_dy8A7T1fG --username <メール> --group-name operator
```

仮のパスワードがメールで届く。最初のログインでパスワードを変え、認証アプリで MFA（TOTP）を登録する。

### 手元で SPA を動かす

```sh
CONSOLE_URL=https://d32w19p7au8cu2.cloudfront.net npm run dev -w web   # http://localhost:5173
```

開発用のユーザープールは `http://localhost:5173/callback` を許しているので、そのままログインできる（本番は許さない）。

## 本番用（prod）

未配備。本番用のアカウント、本番のルート鍵（[鍵の手順書](keys.md) 3 章）、独自ドメイン（ADR-001 T-2）がそろってから。最初の鍵セットは `tools/provision` を使わず、[鍵の手順書](keys.md) 4 章のとおり画面とオフラインの端末で登録する。
