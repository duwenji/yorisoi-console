# DES-008 素材集と素材提供者の API

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-008 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | 管理 API の Lambda（TypeScript）: 素材提供者の役割、素材集の操作・審査・取り下げ、利用の記録、退会・鍵の移し替え・上限の拡張、通知 |
| 承認者 | 開発者 |
| ステータス | 実装済 |
| 版 | 1.0 |

## 目的・背景

[DES-007](DES-007-materials-review.md) の機械審査は、承認のときに写す値（`listing`）を申請に記録する。本書は、素材提供者と運営の操作（[API-001](../contracts/console-api.md)）と、[DM-001](data-model.md) の書き込み（利用の記録・退会・移し替え）を実装する方式を決める。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| API-001 | C-15〜C-22、素材提供者の 9 件・運営の 10 件の操作、エラー、CV-14〜CV-20 | 実装 |
| DM-001 | M-16〜M-25、トランザクション、AP-23〜AP-29 | 実装 |
| DES-007 | J-8・J-10（承認のときに写す値）、J-9（段と版の対応表） | 使う |

## 方針・決定事項

| No. | 判断 | 理由 |
|---|---|---|
| K-1 | 審査の操作（開始・戻す・判定）は、チャンネルと素材集で共通の処理にし、違い（キーの接頭辞、受付・保管の S3 の接頭辞、アイコンの有無、見本の有無、承認で写すもの）を小さな「種類の記述」で渡す | 状態の移り方と同時の書き込みの守り方（M-11）を 1 か所に保つ |
| K-2 | 素材提供者の役割（C-15）は、アカウントの `roles` に `producer` を足すだけ（`If-Match`）。素材集の操作の入り口で、役割と `active` を確かめる共通の関数を使う（`role_required`・`publisher_not_active`）。`roles` のないアカウントは `["publisher"]` として読む | DM-001 M-16・移行メモ |
| K-3 | 素材集の承認（C-17）: アカウントに `producerVerification` がなければ、要求の `verification` を必須にし、同じトランザクションで書く。表示名の変更（`PATCH /api/publisher`）で `producerVerification` を消す | DM-001 M-17、D-20 |
| K-4 | 素材集の承認では、パッケージを公開用のバケットの `col/{sha256}.zip` に写し、申請の `listing` から `latestApproved` を作る（パッケージを開かない）。`minAppVersions` は段と版の対応表（K-6）から決める | DES-007 J-8 |
| K-5 | **D-8 の確かめ直しと同時の書き込み**: 素材集の承認は、利用の記録を読み、`listing.resourceTypes` に記録の素材の ID と種類があることを確かめ（なければ `resource_in_use`）、読んだ利用の記録の `rev` を条件に入れる。チャンネルの承認は、使う素材集の項目の `rev` を条件に入れる。どちらかが後から書くと、もう一方の条件が外れて 412 になる | DM-001 M-22 の「`rev` の条件」。チャンネルと素材集の承認が同時に来ても、参照中の素材が消えない |
| K-6 | 段と版の対応表（API-001 C-21）は環境ごとの設定（`infra/lib/config.ts` の `appStageVersions`。PR を通して変える）から環境変数 `APP_STAGE_VERSIONS`（JSON）で API の Lambda に渡す。アプリごとの値は [DES-011](DES-011-ecosystem.md) N-4。SanpoGuide は段 0・1（文字と画像）が versionCode 1、段 2・3 は対応するまで 9999 | DES-007 J-9 |
| K-7 | **チャンネルの承認での素材集の確かめ直し**（API-001）: API は `core-format` を持たないので、機械審査が記録した `listing.collections`・`listing.uses` と、使う素材集の今の項目（`LISTED`・`status`・`latestApproved` の版・`grants`・`resourceTypes`）で確かめる。リストに載っていない・版が `minVersion` より古い・利用許諾が外れた・参照する素材がない、のどれかなら `invalid_state`（`detail` に理由）。通れば、利用の記録を書き直す（使わなくなった素材集の記録は消す） | 機械審査から承認までの間に、素材集が取り下げ・更新されることがある |
| K-8 | 素材集の取り下げは、チャンネルと同じ形（`REVOKE#` の項目、`REVOKED` の GSI2、`kind = collection`）。利用の記録は残す（知らせの宛先のため。DM-001） | DM-001 M-25 |
| K-9 | チャンネルの取り下げで、そのチャンネルの利用の記録を消す（GSI1 `CH#{channelId}` / `USES#` で引く） | DM-001「利用の記録」 |
| K-10 | 退会（C-22）・鍵の移し替えの承認（M-25）は、チャンネルの分と同じトランザクションに素材集の分を入れる。項目が 100 件を超えそうなら（上限を運営が広げた場合）、取り下げを先に別のトランザクションで行う | DM-001「1 つのトランザクションは 100 件まで」 |
| K-11 | 通知（C-20）の出来事を足す: `collection.approved`・`collection.returned`・`collection.rejected`・`collection.revoked`（素材提供者へ）、`collection.updated`・`collection.revoked_used`・`collection.grants_narrowed`（使っているチャンネル提供者へ。利用の記録から引く）。文面はほかの通知と同じく、見本・運営の ID・トークンを含めない | API-001 C-14・C-20、CV-19 |
| K-12 | `GET /api/collections/{id}/used-by` は利用の記録をそのまま返し、チャンネルの名前・チャンネル提供者の表示名は、チャンネルとアカウントの項目から引いて足す（取り下げ・退会したものは名前を出さない） | API-001 C-18 |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 1 | K-7 の確かめ直しは、機械審査（`core-format`）と同じ判断を TypeScript でもう一度書くことになる | 確かめるのは「リスト・版・利用許諾・素材の有無と種類」だけに絞り、テストで両方を同じ例で確かめる |

## 関連ドキュメント・参照リンク

- [DES-007](DES-007-materials-review.md)、[DES-005](DES-005-review.md)（チャンネルの審査）、[DES-006](DES-006-transfer-notify.md)（鍵の移し替え・通知）
- [DM-001](data-model.md)・[API-001](../contracts/console-api.md)
