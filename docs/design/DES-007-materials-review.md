# DES-007 素材集と素材の機械審査

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-007 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | 機械審査の Lambda（Kotlin、`core-format`）: チャンネルの素材・きっかけ・素材集の参照、素材集のパッケージ |
| 関連Skill | feature-implementation-unified |
| 作成日 | 2026-10-11 |
| 作成者 | Claude（開発者との検討） |
| 承認者 | 開発者 |
| ステータス | 実装済 |
| 版 | 1.0 |

## 目的・背景

[platform ADR-MATERIAL-PRODUCERS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/decisions/ADR-MATERIAL-PRODUCERS.md) で素材の素材提供者を切り出し、管理システムでは [DM-001](../data-model.md) と [API-001](../console-api.md) でデータと API を決めた。本書は、素材集と、素材・きっかけを持つチャンネルの機械審査を決める。`core-format` が、素材・きっかけ・素材集の確認と、リストを使った参照の解決を受け持つ。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| DM-001 | M-18（素材集の申請）、M-20（外部の素材の確認）、M-22（D-8）、M-23（段と版の対応表）、`intake-col/` | 実装 |
| API-001 | C-19（機械審査の結果）、C-21（段と版の対応表） | 実装 |
| platform API-CHANNEL-PACKAGE・platform API-MATERIAL-PRODUCER | 確認の手順 8・9・9a、素材集の確かめる手順 1〜4、エラーコード | `core-format` で実装 |

## 方針・決定事項

| No. | 判断 | 理由 |
|---|---|---|
| J-1 | validator は、チャンネルを `mediaStage = ALL_STAGES` で確かめる。結果の `appStage` に、素材集の中身まで数えた段（`MediaStage.required(media, resolution::types)`）を入れる | 管理システムはすべての段を確かめ、アプリの版の制限は `minAppVersions` で行う（platform API-CHANNEL-PACKAGE M-1） |
| J-2 | チャンネルが宣言した素材集は、機械審査の時点で公開中のもの（DynamoDB の `LISTED` の `COL#`）を読み、公開用のバケットの `col/{sha256}.zip` を `CollectionValidator` で確かめてから、`CollectionReferences.resolve` で解決する。結果を `validation.collections` に入れ、1 つでも使えなければ不合格 | API-001 C-19。リストに載るものと同じデータで判断する |
| J-3 | 素材集の申請は、S3 の `intake-col/` へのアップロードで起動する（アイコンはないので、パッケージが届いた時点で確かめる）。チャンネルと同じ Lambda で、キーの接頭辞で分ける | 1 つの Lambda で済む（DES-004 J-1） |
| J-4 | 素材集の機械審査: `CollectionValidator`（署名・形式・素材）、素材集 ID・`producer`（申請したときのアカウントの今の鍵）・版（M-5）の一致、外部の素材（J-5）、D-8（J-6）、利用許諾の縮小（J-7）。結果は `validation` の `errors`・`external`・`inUse`・`warnings` に入れる | DM-001 M-20・M-22、API-001 C-19 |
| J-5 | 外部の素材は、HTTPS で 1 つずつ流し読みし、大きさと SHA-256 を確かめる（保存しない）。1 つの素材の上限（platform API-CHANNEL-PACKAGE: 画像 1MB・音声 10MB・映像 50MB）を超えたら読むのをやめる。1 つあたり 60 秒、全体で 10 分まで | DM-001 M-20 |
| J-6 | **SSRF への備え**: 外部の素材の URL は素材提供者が書くので、取りに行く前に名前を引き、ループバック・プライベート・リンクローカル・CGNAT・マルチキャストなどのアドレスなら取りに行かない（`bad_resource`）。リダイレクトは追わない（`bad_resource`）。Lambda は VPC の外で動かし、取りに行く処理に AWS の資格情報を送らない | 素材提供者の書いた URL で、管理システムの内側のものを読ませない |
| J-7 | D-8: 素材集の利用の記録（`COL#{id}` / `USEDBY#`）を読み、記録にある素材の ID が新しい版にあり、種類が同じかを確かめる。違えば `inUse` に入れて不合格（`resource_in_use`）。利用許諾を狭めて、記録にあるチャンネル提供者（とその前の ID）が外れるときは `warnings`（`grants_narrowed`）に入れる（拒まない） | platform ADR-MATERIAL-PRODUCERS D-8・D-18 |
| J-8 | 素材集が合格したら、承認のときに写す値（`tags`・`regions`・`media`・`resourcesSize`・`resourceTypes`・`externalResources`・`appStage`）を申請に記録しておく。承認の API（DES-008）はそれを `latestApproved` に写すだけにする | Kotlin の Lambda だけが `core-format` を持つ。API（TypeScript）でパッケージを開かない（DM-001 M-8 と同じ考え） |
| J-9 | 段と版の対応表（C-21）は CDK のコンテキスト `appStageVersions`（例 `{ "0": 1, "1": 9999, "2": 9999, "3": 9999 }`）に置き、Lambda の環境変数で渡す。段 0 は素材のないチャンネル。アプリが対応していない段は仮の大きな値（9999）にし、どのアプリにも出さない | API-001 C-21 |
| J-10 | チャンネルの申請が合格したら、承認のときに写す値（`appStage`・`collections`・`ownPrefetchBytes`・`ownMedia`・使う素材集と素材の ID）を申請に記録しておく。承認の API（DES-008）は、それで利用の記録を書く | J-8 と同じ |
| J-11 | 見本用のプロンプト（`ReviewSamples`）はチャンネルだけ。素材集にはない | 素材集は AI に話させないため |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 1 | 外部の素材の合計が 200MB のとき、流し読みに数分かかる。Lambda の 15 分には収まるが、素材提供者の待ちが長くなる | 画面に「外部の素材を確かめています」と出す（DES-010） |
| 2 | 素材提供者のサーバーが Lambda からの取得を拒む（地域・ボットの制限）と不合格になる | 理由を `external` に出し、素材提供者に置き場所を見直してもらう |
| 3 | 外部の素材を読む通信の費用（NAT は使わないので、Lambda からの外向きの通信だけ） | 申請の回数の上限（1 日 20 回）で抑えられる |

## 関連ドキュメント・参照リンク

- [DES-004](DES-004-machine-review.md): チャンネルの機械審査
- [DM-001](../data-model.md)・[API-001](../console-api.md)
- [platform ADR-MATERIAL-PRODUCERS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/decisions/ADR-MATERIAL-PRODUCERS.md)・[platform API-CHANNEL-PACKAGE](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-PACKAGE.md)・[platform API-MATERIAL-PRODUCER](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-MATERIAL-PRODUCER.md)
