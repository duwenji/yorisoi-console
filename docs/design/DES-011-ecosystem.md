# DES-011 エコシステムへの対応（過ごし方・アプリごとの版・素材集の利用アプリ）

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-011 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | 機械審査（validator）、承認（`api/src/console/review.ts`）、公開（`api/src/publish`）、`packages/protocol`、準拠テスト、画面（`web`）、設定（`infra/lib/config.ts`） |
| 承認者 | 開発者 |
| ステータス | 実装済 |
| 版 | 1.0 |

## 目的・背景

[platform ECOSYSTEM](https://github.com/duwenji/yorisoi-platform/blob/main/docs/overview/yorisoi-ecosystem.md)（付き添いアプリのエコシステム）で、チャンネル・素材集はアプリをまたいで使うものになった。管理システムはエコシステムで 1 つ、リストも 1 本（E-17）で、アプリが端末で絞り込む。契約:

- [platform API-CHANNEL-PACKAGE](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-PACKAGE.md): `activities`・`genres`・`requires.features`。審査は一覧にない値を拒む（G-3）
- [platform API-CHANNEL-LIST](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-LIST.md): リストの `channels[].activities`・`genres`・`requires`（P-19）、`minAppVersions`（P-20）
- [platform API-MATERIALS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-MATERIALS.md): 素材集の `grants.apps`（I-11）

本書は、管理システムがこれをどう実装するかを決める。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| platform ECOSYSTEM | E-17（リストは 1 本）、E-18・E-26（機械審査はコアだけ、見本は過ごし方ごとの代表アプリ）、E-25（アプリの除外はしない） | 本書で実装 |
| platform API-CHANNEL-PACKAGE | G-1〜G-7、V-24 | 本書で実装 |
| platform API-CHANNEL-LIST | P-19・P-20、V-27・V-29 | 本書で実装 |
| platform API-MATERIALS | I-11、W-20 | 本書で実装 |

## 方針・決定事項

| No. | 判断 | 理由 |
|---|---|---|
| N-1 | **validator** は `core-format` とプロンプト・パックを使う。確かめ方は既定の `Strictness.REVIEW`（一覧にない値を拒む）。記録に残す `validatorVersion` は、依存の版を上げるたびに上げる | 審査は共通の一覧で厳しく確かめる（G-3） |
| N-3 | **絞り込みの情報**: 機械審査がパッケージの `activities`・`genres`・`requires.features` を書かれたとおりに記録し、承認が `latestApproved` に写し、公開がリストの `channels[]` に載せる（P-19） | パッケージから写すだけにして、運営の入力を挟まない |
| N-4 | **登録したアプリ**の一覧を設定に置く: `apps: { [id]: { activity, features, stageVersions } }`。最初は `sanpoguide`（`walk`、録音の再生を除く機能、`appStageVersions` の値） | アプリごとの版（P-20）と、提供者に見せる「出るアプリ」（N-8）の元 |
| N-5 | **`minAppVersions`**（P-20）: チャンネルは、登録したアプリのうち `activity` がチャンネルの `activities` にあり、`features` が `requires` を含むものについて、`stageVersions[チャンネルのアプリの段]`（なければ 9999）を載せる。合わないアプリは載せない。素材集は、`grants.apps` が含むアプリ（ないときはすべて）について同じく載せる。承認のときに計算する（DES-009 M-5） | アプリごとに versionCode と対応する段が違う |
| N-7 | **素材集の `grants.apps`**: 機械審査が `core-format` で読み（知らないアプリの ID は拒む）、承認が `latestApproved.grants` に写し、公開がリストの `collections[].grants` に写す（`publishers` と同じ道）。チャンネルが素材集を参照するときの確かめ（platform API-MATERIALS 手順 3）では、アプリを見ない（チャンネルはアプリをまたぐため。合わないアプリでは、その候補が使われないだけ） | I-11・W-20 |
| N-8 | **審査の見本**（E-26）: AI に話させる見本は、チャンネルの `activities` で代表のアプリのプロンプト・パックを選んで作る。`walk` は SanpoGuide、`cycle` は CycleGuide（見本の名前は「自転車: 」で始まる）。両方を含むときは両方の見本を並べる。どちらも含まないチャンネルは見本を作らず、運営の画面に「この過ごし方の代表アプリはまだありません。語り手の文章を読んで確かめてください」と出す | アプリが送るのと同じプロンプトで確かめる。過ごし方が増えたとき、代表のアプリができるまでは見本を作るプロンプトがない |
| N-9 | **画面**: 運営の審査の画面と、チャンネル提供者のチャンネルの画面に、過ごし方・ジャンル・必要な機能と、**このチャンネルが出るアプリ**（N-5 で版を載せるアプリの名前。0 なら「今はどのアプリにも出ません」と出す）を出す。素材提供者の素材集の画面と運営の素材集の審査の画面に、使ってよいアプリ（`grants.apps`。なければ「すべてのアプリ」）を出す | E-18（「このチャンネルが出るアプリ」を出す） |
| N-10 | **`packages/protocol`・準拠テスト**: リストの型に `activities`・`genres`・`requires`・`minAppVersions`、素材集の `grants.apps`・`minAppVersions` を持つ。準拠テストで V-27（`activities`・`genres`・`requires` がパッケージの値と一致）と、`minAppVersions` の形（アプリの ID → 正の整数）を確かめる。アプリのテスト用の文書（`app-vectors.ts`）に、過ごし方を宣言したチャンネルを入れる | P-19・P-20 |
| N-11 | **データモデル**: `latestApproved` と申請の `listing` に `activities`・`genres`・`requires`・`minAppVersions`、素材集の `latestApproved.grants.apps` を持つ | — |
| N-12 | **利用ガイド**: チャンネル提供者のガイドに `activities`・`genres`・`requires` を、素材提供者のガイドに `grants.apps` を書く | 申請する人が書けるように |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 1 | `cycle` だけのチャンネルを承認できるようにしておくか（どのアプリにも出ない） | 承認できるようにし、画面で「今はどのアプリにも出ません」と出す（N-9）。サイクリングのアプリの準備でチャンネルを先に用意できるように |
| 2 | 登録したアプリの一覧を設定（`infra/lib/config.ts`）に置くと、アプリを足すたびに配備が要る | アプリを足すのはまれなので、設定で足りる。運営の画面で編集したくなったら DynamoDB に移す |

## 関連ドキュメント・参照リンク

- [DES-007](DES-007-materials-review.md)・[DES-008](DES-008-materials-api.md)・[DES-009](DES-009-materials-publish.md): 素材集の審査・API・公開
- [DM-001](data-model.md)、[API-001](../contracts/console-api.md)
- [platform ECOSYSTEM](https://github.com/duwenji/yorisoi-platform/blob/main/docs/overview/yorisoi-ecosystem.md)、platform API-CHANNEL-LIST・platform API-CHANNEL-PACKAGE・platform API-MATERIALS
