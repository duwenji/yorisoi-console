# yorisoi-console

yorisoi のアプリ（SanpoGuide・CycleGuide）の第三者のチャンネルと素材集を審査して公開する **チャンネル管理システム**。運営の AI の中継とスポットのタイルの配信も、このリポジトリから配備する。

- チャンネル提供者: チャンネルの申請・更新、審査状況の確認、試用チケットの発行、鍵の移し替えの申し出
- 素材提供者: 素材集（チャンネルが参照する素材のまとまり）の申請・更新、身元の確認、自分の素材集を使っているチャンネルの確認。アカウントはチャンネル提供者と共通
- 運営: 審査（機械で確かめた結果と、AI に話させた見本）、承認・差し戻し・取り下げ、鍵の移し替えの承認
- 自動: 承認済みチャンネル・リストを作り、署名して公開する。毎日、素材集の外部の素材を確かめる。週に 1 回、スポットのタイルを作り直す
- アプリから: 運営の AI の中継（platform [API-AI-RELAY](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-AI-RELAY.md)）、スポットのタイルの配信（platform [API-SPOT-TILES](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-SPOT-TILES.md)）

チャンネルについてのアプリとの境界は [platform API-CHANNEL-LIST](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-LIST.md) だけ。パッケージと素材集の形式は [platform API-CHANNEL-PACKAGE](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-PACKAGE.md)・[platform API-MATERIAL-PRODUCER](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-MATERIAL-PRODUCER.md)。

## 構成

AWS（ap-northeast-1）。API Gateway・Lambda・DynamoDB・Cognito・KMS・SQS、公開は S3 と CloudFront。全体を図で見るには **構成図**（[HTML 版](docs/architecture.html)はブラウザで開く。GitHub の上では [Markdown 版](docs/architecture.md)）、設計の理由は [console ADR-001](docs/adr/ADR-001-aws-architecture.md)。npm workspaces のモノレポ（Node.js 22 以上）。

```
packages/protocol  platform API-CHANNEL-LIST の文書の作成と検証（共通）
packages/api-types 管理 API の型（docs/api/console.openapi.yaml から生成）
api/               Lambda（TypeScript）。公開の処理（api/src/publish）、管理 API（api/src/console）、チャンネル提供者へのメール（api/src/notify）、運営の AI の中継（api/src/relay）
tools/root-key     ルート鍵の CLI（オフラインで使う）
tools/provision    配備した環境に署名鍵・鍵セットを登録して公開する（初期設定）
conformance/       platform API-CHANNEL-LIST の準拠テスト（任意のリストの URL に対して流せる）
infra/             AWS CDK（管理システム bin/app.ts・中継 bin/relay.ts・タイル bin/tiles.ts）
tiles/             スポットのタイルを作るバッチ
web/               運営・チャンネル提供者・素材提供者の画面（React + Vite）
validator/         機械審査の Lambda（Kotlin、Gradle、yorisoi-platform の core-format とプロンプト・パック）
tools/e2e          開発用の環境での通しの確認
```

## 使い方

```sh
npm ci
npx tsc -b            # 型の確認
npx vitest run        # テスト（管理 API のテストは Docker で DynamoDB Local を起動する）
npm run build -w web  # 画面をビルド（cdk synth の前に要る）

# 手元で公開して、準拠テストをかける（AWS は不要。鍵は使い捨て）
npm run publish:local -w api            # ../.local/site に書き出し、リストID を表示
npm run serve -w conformance            # http://127.0.0.1:8787 で配る
npm run check -w conformance -- http://127.0.0.1:8787 --allow-local-http --provider <リストID>

# 任意のリストに準拠テストをかける
npm run check -w conformance -- https://channels.example.com --provider sc1…

# ルート鍵（オフラインの端末で。Git の作業ツリーの外に）
ROOT_KEY_PASSPHRASE=… npm run root-key -w tools/root-key -- generate --out <フォルダ>
ROOT_KEY_PASSPHRASE=… npm run root-key -w tools/root-key -- sign-keyset --root-key <pem> --in keyset-input.json --out keyset.json

# CloudFormation のテンプレートを作る（配備は docs/operations/deploy.md）
cd infra && npx cdk synth -c env=dev -c rootPublicKey=<base64url>
```

## 文書

- **[文書一覧](docs/README.md)**: このリポジトリの設計・契約・ガイド・運用文書（まずここから）
- **[利用ガイド](docs/guide/README.md)**: 運営・チャンネル提供者・開発・保守をする人ごとの使い方（まずここから）

- [TODO.md](docs/TODO.md): 次にやること
- [配備の手順](docs/operations/deploy.md): 開発用は配備済み（リスト https://d32t2reyxml47d.cloudfront.net、画面 https://d32w19p7au8cu2.cloudfront.net）
