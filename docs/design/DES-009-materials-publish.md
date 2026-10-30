# DES-009 素材集の公開

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-009 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | 公開の Lambda（リストの作成・署名・公開）、毎日の外部の素材の確認、準拠テスト、`packages/protocol` |
| 関連Skill | feature-implementation-unified |
| 作成日 | 2026-10-11 |
| 作成者 | Claude（開発者との検討） |
| 承認者 | 開発者 |
| ステータス | 実装済 |
| 版 | 1.0 |

## 目的・背景

素材集の承認・取り下げと、チャンネルの利用の記録（[DES-008](DES-008-materials-api.md)）を、承認済みリスト（platform API-CHANNEL-LIST）に載せる公開の処理と、毎日の外部の素材の確認（DM-001 M-21、platform ADR-MATERIAL-PRODUCERS D-22）、準拠テストを決める。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| platform API-CHANNEL-LIST | P-10〜P-15、`collections[]`・`revokedCollections[]`・`producerChange`・`media`・`resourcesSize`・`tags`・`regions`・`grants`、V-19〜V-26 | 実装 |
| DM-001 | M-21（毎日の確認）、M-24（公開のたびの足し合わせ）、M-25（取り下げは 7 日） | 実装 |
| API-001 | C-20（外部の素材の不具合を素材提供者に知らせる） | 実装 |

## 方針・決定事項

| No. | 判断 | 理由 |
|---|---|---|
| M-1 | GSI2 の `LISTED` は `GSI2SK` の接頭辞（`CH#`・`COL#`）で、`REVOKED` は項目の `kind` でチャンネルと素材集を分けて読む | チャンネルと素材集が同じパーティションに入るため |
| M-2 | `packages/protocol` の型とリストの作成・確かめに、`collections[]`・`revokedCollections[]`・`channels[].media`・`resourcesSize` を足す。`format` は 1（platform API-CHANNEL-LIST P-12）。配列は空でも毎回書く | 知らない項目はアプリが無視する |
| M-3 | 素材集の項目は、素材集の `latestApproved` から作る（承認時に計算済み。DM-001 M-24）。リストに出さないもの（`submissionId`・`resourceTypes`・`externalResources`・`appStage`）は落とす。`producerChange` はチャンネルと同じく、`until` があって過ぎておらず、載せる版の素材提供者と違うときだけ載せる | platform API-CHANNEL-LIST P-13 |
| M-4 | チャンネルの `resourcesSize` は「自身の前もっての取得の大きさ」＋「宣言した素材集のうち、今リストに載っているものの `resourcesSize`」。`media` は「自身の素材の種類」と「その素材集の `media`」を合わせたもの（素材集の中で参照しない種類も含むので、多めに出る）。`ownMedia` などのないチャンネルは、どちらも載せない | DM-001 M-24。素材集の版が変わると、次の公開で値が変わる |
| M-5 | チャンネルの `minAppVersions` は承認時の値のまま（公開のたびに計算し直さない）。D-8 で、参照している素材の種類は変わらないため | 承認時に素材集の中身まで数えている（DES-008 K-7） |
| M-6 | 公開の記録に `collectionCount`・`revokedCollectionCount` を足す | API-001 `Publication` |
| M-7 | **毎日の外部の素材の確認**（M-21）は、公開の Lambda の毎日の実行（`daily`）の、公開が終わった後に行う。公開中の素材集の `externalResources` の URL に HEAD を送り、取得できるかと大きさ（`Content-Length`）だけを確かめる。結果を素材集の `externalCheck` に書き、前回にはなかった不具合があれば、素材提供者に `collection.external_failed` を知らせる。確認の失敗は公開を失敗にしない | 公開を遅らせない・止めない |
| M-8 | **M-7 の SSRF への備え**は、機械審査（DES-007 J-6）と同じ規則を TypeScript で書く（名前を引いて内側・特別なアドレスを拒む。Node の `net.BlockList`。リダイレクトは追わない。HTTPS だけ）。同じ例（18 種類のアドレス）でテストする | 公開の Lambda は Node なので、Kotlin の実装をそのまま使えない。同じ規則を 2 か所に書くことになる（未決事項 No.1） |
| M-9 | チャンネル自身の外部の素材（`resources` の `url`）は、毎日の確認に入れない（機械審査が URL の一覧を記録していないため） | D-22 は素材集の確認。チャンネル自身の分は、必要になったら機械審査の記録に足す |
| M-10 | 準拠テストに、platform API-CHANNEL-LIST の V-19（素材集の ID・パッケージの SHA-256 と大きさ）、V-20（チャンネルが宣言した素材集がリストにあり、版が足り、利用許諾がチャンネル提供者を含む）、V-25（`tags`・`regions`・`grants` がパッケージから計算した値と一致）を足す。V-21（`resourcesSize`・`media`）は計算の材料（外部の素材の大きさ）がリストだけでは揃わないので、「`media` が正しい種類の名前だけ」「`resourcesSize` が 0 以上」の形の確認にとどめる | 任意のリストに対して流せる確認に絞る |
| M-11 | アプリのテスト用の文書（`conformance/src/app-vectors.ts`）に素材集を 1 つ入れる。`core-format` の `ProviderDocumentsTest` は、管理システムが署名した素材集つきのリストで確かめられる | アプリと管理システムの文書の作り方・確かめ方をそろえる |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 1 | SSRF の規則が Kotlin（機械審査）と TypeScript（毎日の確認）の 2 か所になる | 同じ例でテストする。どちらかを変えるときは、もう一方も変える（両方のファイルに注記する） |
| 2 | HEAD に答えないサーバー（405 など）がある | 405・501 のときは、先頭の 1 バイトだけの GET（`Range: bytes=0-0`）で取得できるかを確かめ、大きさは確かめない |
| 3 | 素材集が多くなると、毎日の確認に時間がかかる | 1 つの URL に 10 秒、全体で 5 分まで。超えたら残りは翌日 |

## 関連ドキュメント・参照リンク

- [DES-001](DES-001-publisher.md)（公開の処理）、[DES-007](DES-007-materials-review.md)、[DES-008](DES-008-materials-api.md)
- [platform API-CHANNEL-LIST](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-LIST.md)
