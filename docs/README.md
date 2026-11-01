# yorisoi-console の文書

このリポジトリの文書は、チャンネル管理システムの設計・API・データ・利用・運用を説明します。画面や運用手順はこのシステムに固有のものです。

エコシステム共通の方針と契約は [yorisoi-platform](https://github.com/duwenji/yorisoi-platform) が正本です。platform の方針（overview）と API 契約が共有ルールを定め、このリポジトリの構成の決まり（ARCH-001）・DES はそのルールに従う管理システムの実装を定めます。

## 設計と管理システムの契約

| 知りたいこと | 文書 |
|---|---|
| AWS 構成とコンポーネントの関係、構成の決まり | [構成図と決まり（ARCH-001）](design/architecture.md) |
| CDK にある AWS 資源とつながり（生成した図） | [AWS 資源の図](design/aws-diagrams.md) |
| 機能ごとの設計 | [console DES-001〜DES-011・DES-013](design/) |
| 管理画面が使う API | [console API-001](contracts/console-api.md) と [OpenAPI 定義](contracts/api/console.openapi.yaml) |
| DynamoDB の項目・キー・状態 | [console DM-001](design/data-model.md) |
| 残作業と確認事項 | [console TODO](TODO.md) |

## 利用ガイド

| 読者 | 文書 |
|---|---|
| まず全体を知りたい | [利用ガイド](manual/README.md) |
| 仕組みと用語 | [仕組み](manual/concepts.md) |
| 運営 | [運営ガイド](manual/operator.md) |
| チャンネル提供者 | [チャンネル提供者ガイド](manual/publisher.md) |
| 素材提供者 | [素材提供者ガイド](manual/producer.md) |
| 素材提供者（スタジオ） | [スタジオのガイド](manual/studio.md) |
| 開発・保守 | [開発・保守ガイド](manual/maintainer.md) |

## サンプルデータ

| 知りたいこと | 文書 |
|---|---|
| チャンネルと素材集を組み合わせたシナリオ例 | [鎌倉の歴史散歩](samples/kamakura-walk/README.md) |

## 運用手順

| 作業 | 文書 |
|---|---|
| AWS 費用の見積もり | [費用](operations/cost.md) |
| 環境の配備 | [配備の手順](operations/deploy.md) |
| ルート鍵・署名鍵の管理 | [鍵の手順書](operations/keys.md) |
| 運営の AI（中継）の配備・上限・予算 | [運営の AI の手順](operations/ai-relay.md) |
| スポットのタイルの配備・作り直し | [スポットのタイルの手順](operations/spot-tiles.md) |
| スタジオの配備・利用規約の版・止め方 | [スタジオの手順](operations/studio.md) |

## エコシステム共通の正本

| 知りたいこと | 正本 |
|---|---|
| 共有方針 | [platform 文書案内](https://github.com/duwenji/yorisoi-platform/blob/main/docs/README.md)（エコシステム・チャンネル・素材・生成 AI の役割の決まり） |
| API・データ形式の境界 | [platform API 契約一覧](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/README.md) |
| 関係者の呼び方 | [関係者と共通用語](https://github.com/duwenji/yorisoi-platform/blob/main/docs/overview/roles-and-vocabulary.md) |
| チャンネル審査方針 | [審査方針](https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/channel-review.md) |
| スタジオの決まり | [一言の利用規約](https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/notes-terms.md)・[スタジオの決まり](https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/studio-rules.md) |
| SanpoGuide の使い方と運用 | [SanpoGuide 手引き](https://github.com/duwenji/yorisoi-sanpoguide/blob/main/docs/manual/README.md) |

文書 ID はリポジトリごとに管理します。たとえば `console ARCH-001` と `platform CHANNELS` は別の文書です。platform の文書は canonical ID で指します。
