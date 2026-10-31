# チャンネル管理システム データモデル設計書

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DM-001 |
| ドキュメント種別 | データモデル設計書 |
| 対象システム/機能 | チャンネル管理システム（DynamoDB の 1 テーブルと、S3 に置くもの） |
| 関連Skill | 020_data-model-design-unified |
| 作成日 | 2026-10-03 |
| 作成者 | Claude（開発者との検討） |
| 承認者 | 開発者 |
| ステータス | 承認済 |
| 版 | 1.0 |

## 目的・背景

[ADR-001](adr/ADR-001-aws-architecture.md) A-6 で、データは DynamoDB の 1 テーブルに置き、パッケージ・アイコン・リストの本体は S3 に置くと決めた。本書は、そのテーブルの項目の種類、キー、インデックス、状態の移り方、上限（A-18）を決める。素材提供者の役割と素材集（申請・審査・公開・取り下げ）、チャンネルが素材集を使う記録（依存）は、[platform ADR-MATERIAL-PRODUCERS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/decisions/ADR-MATERIAL-PRODUCERS.md)（素材の素材提供者）による。

DynamoDB では、取り出し方（アクセスパターン）からキーを決める。本書は、先にアクセスパターンを挙げ、それを満たすキーを決める。

## スコープ・非スコープ

スコープ:
- チャンネル提供者、チャンネル提供者の鍵、チャンネル、申請（版）、審査の記録、取り下げ、鍵の移し替え、公開の記録、鍵セット・署名鍵、試用チケット、上限の数え方、操作の記録、一度きりの文字列
- 申請・チャンネル・チャンネル提供者・鍵の移し替えの状態の移り方
- S3 に置くものの名前の付け方と保持期間
- 書き込みの単位（トランザクション）と、同時に書かれたときの守り方

非スコープ:
- 管理システムの API（[API-001](console-api.md)。本書のアクセスパターンを入力にする）
- リストとパッケージの形式（platform API-CHANNEL-LIST・platform API-CHANNEL-PACKAGE）
- Cognito のユーザー属性の詳細（メールアドレスなどは Cognito が持ち、本テーブルには複製しない）

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| ADR-001 | A-4（Cognito）、A-5（鍵の紐づけ）、A-6（1 テーブル）、A-7（公開の名前）、A-10（`seq`）、A-11〜A-13（受付・承認・試用）、A-15（鍵の移し替え）、A-16（操作の記録）、A-18（上限）、D-7（誰でも登録できる） | 本書でデータにする |
| platform API-CHANNEL-LIST | `channels[]` の項目、`revoked[]`、`seq`・`expiresAt`、P-8（要約）、P-9（`publisherChange`）、鍵セット | 公開の Lambda が本書のデータから作る |
| platform API-CHANNEL-PACKAGE | `channel.json` の `id`・`version`・`publisher`、エラーコード | 申請に保存する |
| platform チャンネル審査方針 | 判定（承認・差し戻し・却下）、取り下げ | 審査の記録・取り下げにする |
| platform ADR-MATERIAL-PRODUCERS | D-7（素材集の審査と公開）、D-8（参照中の素材の ID を消す更新を拒む）、D-9（利用許諾）、D-12（取り下げ）、D-14（同じアカウント）、D-17（素材集の ID と鍵の移し替え）、D-18（依存の把握と知らせ）、D-19（退会）、D-20（身元の確認）、D-22（外部の素材の確認） | 1.3 でデータにする |
| platform API-CHANNEL-LIST | P-10〜P-15（`collections[]`・`revokedCollections[]`・`producerChange`・`media`・`resourcesSize`・`tags`・`regions`・`grants`） | 公開の Lambda が本書のデータから作る |
| platform API-MATERIAL-PRODUCER | 素材集の形式、`CollectionReferences`（手順 3・4）、`Regions` | 機械審査が `core-format` で行う |

## 方針・決定事項

### 前提の決定

| No. | 論点 | 決定 |
|---|---|---|
| M-1 | チャンネル提供者のアカウントの単位 | 1 ユーザー = 1 チャンネル提供者。ただし、ユーザーとチャンネル提供者は別の項目にしておき、あとで 1 つのチャンネル提供者に複数のメンバーを足せるようにする |
| M-2 | A-18 の上限 | チャンネルはチャンネル提供者ごとに 5 つ。審査待ちの申請は 1 チャンネルにつき 1 つ。申請（アップロード）は 1 日 20 回。試用チケットは 1 日 10 枚。運営はチャンネル提供者ごとに上限を変えられる |
| M-3 | 操作の記録 | 同じテーブルに期限なしで残す |
| M-4 | 承認されなかったパッケージ | 受付用の S3 に、その結果が出てから 90 日残して消す。承認したものは公開用のバケットに残る |

### 設計の決定

| No. | 論点 | 決定案 |
|---|---|---|
| M-5 | 申請と版の番号 | 申請は申請ID（ULID）で区別する。版の番号はチャンネル提供者がパッケージに書くもので、差し戻しのあとは同じ番号で出し直せる。確かめるのは「最後に承認した版の番号より大きい」ことだけ（受付時と承認時の 2 回） |
| M-6 | チャンネルID | SanpoGuide のリストの中で一意（platform API-CHANNEL-LIST）。最初に登録したチャンネル提供者が持ち、別のチャンネル提供者は同じ ID を使えない。取り下げたチャンネルの ID も再利用しない |
| M-7 | チャンネル提供者のアカウントID（`sg1…`） | 1 つのアカウントIDを紐づけられるのは 1 つのチャンネル提供者だけ。外した（移し替えた）アカウントIDも、別のチャンネル提供者に紐づけ直せない |
| M-8 | リストに載せる内容 | チャンネルの項目に、最新の承認済みの版の「リストに載せる内容」を写しておく。公開の Lambda はそれを集めるだけで、パッケージを開かない |
| M-9 | 取り下げ | 取り下げると、そのチャンネルはリストから消える。前の承認済みの版に自動では戻さない（新しい版の承認が要る）。リストの `revoked` には、取り下げから 7 日載せる。7 日を過ぎてから初めてリストを取得した端末でも、リストに載っていないチャンネルは使わない（platform API-CHANNEL-LIST P-5）。違いは、パッケージを消して理由を知らせるかどうかだけ |
| M-10 | チャンネル提供者の停止 | 停止中は申請・試用チケット・鍵の紐づけを受け付けない。公開中のチャンネルはそのまま（止めるなら取り下げを別に行う。ADR-001 A-18 ④） |
| M-11 | 同時に書かれたときの守り方 | 状態が変わる項目には `rev`（書くたびに 1 増やす）を持たせ、条件付き書き込みで後勝ちの上書きを防ぐ。状態の移り方は、移る前の状態を条件にして守る |
| M-12 | 時刻と ID | 時刻は UTC の ISO 8601（ミリ秒まで）。1 日の上限は日本時間の日付で数える。新しく作る ID は ULID（作った順に並ぶ） |
| M-13 | 公開の記録の本体 | リストの本体（署名済み）は、公開用のバケットのほかに、記録用のバケットに `seq` ごとに期限なしで残す。DynamoDB には `seq`・SHA-256・保存場所だけを持つ |
| M-14 | 鍵の移し替えの単位 | チャンネル提供者ごと。チャンネル提供者が使う鍵は 1 つなので、承認するとすべてのチャンネルが一緒に移る（API-001 C-11） |
| M-15 | 退会 | チャンネル提供者を `deleted` にして表示名・連絡先を消す。操作の記録・アカウントIDの予約・チャンネル ID は残し、再利用させない（API-001 C-4） |

### 素材の素材提供者の決定

| No. | 論点 | 決定 |
|---|---|---|
| M-16 | アカウントの形 | チャンネル提供者の項目（`PUB#`）を「アカウント」として扱い、`roles`（`publisher`・`producer`）を持たせる。鍵・停止・退会・鍵の移し替えは役割に共通（platform ADR-MATERIAL-PRODUCERS D-14）。文書と画面では、役割を言うときに「チャンネル提供者」「素材提供者」、両方を言うときに「アカウント」と呼ぶ |
| M-17 | 素材提供者の役割を有効にする方法 | アカウントの持ち主が自分で有効にできる（D-7 と同じく開かれている）。身元は、最初の素材集を承認するときに運営が確かめて `producerVerification` に記録する。記録がないアカウントの素材集は承認できない。表示名を変えると記録を消し、次の承認で確かめ直す（D-20） |
| M-18 | 素材集のデータ | チャンネル・申請と同じ形の項目を、`COL#{collectionId}` の下に別に作る（素材集・申請・審査の記録・取り下げ）。素材集の ID はチャンネルの ID と別の名前空間で、最初に登録したアカウントが持ち、再利用しない（D-17）。審査待ちの列は 1 本（`QUEUE#REVIEW`）で、項目の `kind`（`channel` / `collection`）で見分ける |
| M-19 | 上限 | 素材集は 1 アカウント 5 つ（取り下げたものも数える）。審査待ちの申請は 1 素材集につき 1 つ。申請の回数（1 日 20 回）はチャンネルと素材集で合わせて数える。素材集の試用チケットは作らない（platform API-MATERIAL-PRODUCER の未決事項） |
| M-20 | 外部の素材の確認（申請時） | 機械審査で外部の素材を流し読みし、大きさと SHA-256 を確かめる。中身は保存しない。審査する人は元の URL で見る・聴く |
| M-21 | 外部の素材の確認（毎日、D-22） | 毎日の公開の処理で、公開中の素材集とチャンネルの外部の素材の URL に HEAD を送り、取得できるかと大きさだけを確かめる。結果は項目の `externalCheck` に残し、新しく見つかった不具合は持ち主にメールで知らせる。ハッシュを確かめ直すのは申請時だけ |
| M-22 | 依存の記録（D-8・D-18） | チャンネルの承認時に、使う素材集ごとに「利用の記録」（`COL#{collectionId}` / `USEDBY#{channelId}`）を書く。中身は参照している素材の ID とその種類。チャンネルの新しい版の承認で書き直し、取り下げ・退会で消す。素材集の申請では、機械審査と承認の 2 回、利用の記録にある素材の ID が残り、種類が変わっていないことを確かめる（D-8）。基準（`selectors`）で選ぶ使い方は記録しない（ID を指さないため） |
| M-23 | 必要なアプリの段 | チャンネルの段（素材の種類から決まる 0〜3）は、承認時にリストに載っている素材集の中身まで数える（`core-format` の `MediaStage` と `CollectionReferences`）。素材集の段は、素材の種類から決める。段からアプリの版を決める方法は M-27 |
| M-24 | リストに載せる値の計算 | 素材集の `tags`・`regions`・`media`・`resourcesSize`・`grants` は承認時に計算して写す（M-8 と同じ）。チャンネルの `resourcesSize` は、素材集の版で変わるので、公開のたびに「チャンネル自身の分」と「宣言した素材集の `resourcesSize`」を足して出す。チャンネルの `media` も同じく公開のたびに合わせる |
| M-25 | 取り下げ・退会・停止 | 素材集の取り下げはリストの `revokedCollections` に 7 日載せる（M-9 と同じ）。退会すると、公開中の素材集も自動で取り下げる（D-19）。停止中は素材集の申請も止める。公開中の素材集はそのまま（M-10 と同じ）。素材集の取り下げ・更新・利用許諾の縮小は、利用の記録にあるチャンネル提供者にメールで知らせる（D-18） |

### エコシステムの決定

platform ADR-ECOSYSTEM-PLATFORM（付き添いアプリのエコシステム）による。実装は [DES-011](design/DES-011-ecosystem.md)。

| No. | 論点 | 決定 |
|---|---|---|
| M-26 | 絞り込みの情報（DES-011 N-3・N-11） | 機械審査が、パッケージの `activities`・`genres`・`requires.features` を申請の `listing` に書かれたとおりに記録し、承認が `latestApproved` に写す |
| M-27 | アプリごとの版（DES-011 N-4〜N-6） | 段と版の対応表を、アプリの ID ごとの設定 `appStageVersions`（`{ sanpoguide: { 0: 1, 1: 1, 2: 9999, 3: 9999 }, cycleguide: { 0: 1, 1: 9999, 2: 9999, 3: 9999 } }`）にする。アプリの名前・過ごし方・機能は `packages/protocol` の `KNOWN_APPS`。承認は `latestApproved.minAppVersions`（アプリの ID → 版）を計算する: チャンネルは過ごし方と必要な機能が合うアプリだけ、素材集は `grants.apps` が含むアプリ（ないときはすべて） |
| M-28 | 素材集の利用アプリと AI の根拠（DES-011 N-7、platform API-MATERIAL-PRODUCER I-13） | 機械審査が `grants.apps` と `grants.grounding`（真のときだけ）を読み、承認が `latestApproved.grants.apps` に写す。チャンネルが素材集を参照するときの確かめでは、アプリを見ない |

## 概念モデル（ERD）

```mermaid
erDiagram
    USER ||--|| PUBLISHER : "ログインする（M-1）"
    PUBLISHER ||--o{ PUBLISHER_KEY : "紐づける（使えるのは 1 つ）"
    PUBLISHER ||--o{ CHANNEL : "持つ（上限 5）"
    PUBLISHER ||--o{ DAILY_QUOTA : "日ごとに数える"
    CHANNEL ||--o{ SUBMISSION : "申請される"
    SUBMISSION ||--o{ REVIEW : "審査される"
    SUBMISSION ||--o{ TEST_TICKET : "試用チケットを出す"
    CHANNEL ||--o{ REVOCATION : "取り下げられる"
    PUBLISHER ||--o{ KEY_TRANSFER : "鍵を移し替える（M-14）"
    PUBLICATION_HEAD ||--o{ PUBLICATION : "seq の履歴"
    KEYSET_HEAD ||--o{ KEYSET : "seq の履歴"
    KEYSET ||--o{ SIGNING_KEY : "載せる"
    AUDIT_EVENT }o--|| CHANNEL : "対象（任意）"
    AUDIT_EVENT }o--|| PUBLISHER : "対象（任意）"
    PUBLISHER ||--o{ COLLECTION : "持つ（素材提供者の役割。上限 5）"
    COLLECTION ||--o{ COLLECTION_SUBMISSION : "申請される"
    COLLECTION_SUBMISSION ||--o{ REVIEW : "審査される"
    COLLECTION ||--o{ REVOCATION : "取り下げられる"
    COLLECTION ||--o{ USED_BY : "使われる（M-22）"
    USED_BY }o--|| CHANNEL : "使う"
```

`PUBLISHER` は「アカウント」を表し、チャンネル提供者と素材提供者の役割を持つ（M-16）。

## 論理モデル

### アクセスパターン

| No. | 誰が | 何をする | 使うキー |
|---|---|---|---|
| AP-01 | 全員 | ログインしたユーザーからチャンネル提供者を引く | `USER#{sub}` |
| AP-02 | チャンネル提供者・運営 | チャンネル提供者を見る | `PUB#{publisherId}` / `PUB` |
| AP-03 | チャンネル提供者・運営 | チャンネル提供者の鍵の一覧（今のものと過去のもの） | `PUB#{publisherId}` / `KEY#` |
| AP-04 | システム | アカウントIDがすでに使われていないか確かめる（M-7） | `ACCOUNT#{accountId}` |
| AP-05 | チャンネル提供者 | 自分のチャンネルの一覧 | GSI1 `PUB#{publisherId}` / `CH#` |
| AP-06 | 全員 | チャンネルを見る | `CH#{channelId}` / `CH` |
| AP-07 | チャンネル提供者・運営 | チャンネルの申請の一覧（新しい順） | `CH#{channelId}` / `SUB#` |
| AP-08 | 運営 | 申請の審査の記録 | `CH#{channelId}` / `SUB#{submissionId}#REVIEW#` |
| AP-09 | 運営 | 審査待ちの一覧（古い順） | GSI2 `QUEUE#REVIEW` |
| AP-10 | 公開の Lambda | リストに載せるチャンネルをすべて集める | GSI2 `LISTED` |
| AP-11 | 公開の Lambda | `revoked` に載せる取り下げを集める（7 日以内） | GSI2 `REVOKED` |
| AP-12 | 運営 | 鍵の移し替えの申し出の一覧 | GSI2 `QUEUE#TRANSFER` |
| AP-13 | 公開の Lambda | 今の `seq` を読み、1 つ進める | `PUBLICATION` / `HEAD` |
| AP-14 | 運営 | 公開の履歴 | `PUBLICATION` / `SEQ#` |
| AP-15 | 公開の Lambda | 今の鍵セットと、使う署名鍵を引く | `KEYSET` / `HEAD`、`SIGNKEY` / `KEY#` |
| AP-16 | チャンネル提供者 | 申請の試用チケットの一覧 | `CH#{channelId}` / `SUB#{submissionId}#TICKET#` |
| AP-17 | システム | 今日の申請・試用チケットの数を確かめて増やす | `PUB#{publisherId}` / `QUOTA#{日付}` |
| AP-18 | 運営 | 操作の記録を新しい順に見る | `AUDIT#{年月}` |
| AP-19 | 運営・チャンネル提供者 | 1 つのチャンネル・チャンネル提供者の操作の記録 | GSI1 `TARGET#…` |
| AP-20 | 運営 | チャンネル提供者の一覧（新しい順、停止中だけ） | GSI2 `PUBLISHERS` |
| AP-21 | 機械審査の Lambda | S3 のキーから申請を引く | S3 のキーに `channelId` と `submissionId` を入れる（引き直し不要） |
| AP-22 | システム | 鍵の紐づけの一度きりの文字列を確かめる | `PUB#{publisherId}` / `CHALLENGE#{nonce}` |
| AP-23 | 素材提供者 | 自分の素材集の一覧 | GSI1 `PUB#{publisherId}` / `COL#` |
| AP-24 | 全員 | 素材集を見る | `COL#{collectionId}` / `COL` |
| AP-25 | 素材提供者・運営 | 素材集の申請の一覧（新しい順） | `COL#{collectionId}` / `SUB#` |
| AP-26 | 公開の Lambda | リストに載せる素材集をすべて集める | GSI2 `LISTED` / `COL#`（チャンネルは `CH#`） |
| AP-27 | 公開の Lambda | `revokedCollections` に載せる取り下げを集める（7 日以内） | GSI2 `REVOKED`（`kind` で見分ける） |
| AP-28 | システム・素材提供者 | 素材集を使っているチャンネル（D-8 の確認、D-18 の知らせ） | `COL#{collectionId}` / `USEDBY#` |
| AP-29 | 運営 | 審査待ちの一覧（チャンネルと素材集を古い順） | GSI2 `QUEUE#REVIEW`（AP-09 と同じ。`kind` で見分ける） |

### 状態の移り方

**申請（SUBMISSION）**

```mermaid
stateDiagram-v2
    [*] --> uploading: 署名付き URL を発行
    uploading --> validating: S3 に届いた
    uploading --> expired: 1 時間届かない
    validating --> validation_failed: 機械審査で不合格
    validating --> awaiting_review: 機械審査で合格
    awaiting_review --> in_review: 運営が審査を始めた
    in_review --> awaiting_review: 運営が審査を戻した
    awaiting_review --> withdrawn: チャンネル提供者が取り消した
    in_review --> withdrawn: チャンネル提供者が取り消した
    in_review --> approved: 承認
    in_review --> returned: 差し戻し
    in_review --> rejected: 却下
    awaiting_review --> returned: 鍵の移し替え（古い鍵の署名）
    in_review --> returned: 鍵の移し替え（古い鍵の署名）
    approved --> superseded: 新しい版を承認
    approved --> revoked: 取り下げ
    validation_failed --> [*]
    returned --> [*]
    rejected --> [*]
    withdrawn --> [*]
    expired --> [*]
```

- 「審査待ちの申請」（`uploading`・`validating`・`awaiting_review`・`in_review`）は 1 チャンネルにつき 1 つ（M-2）。チャンネルの `pendingSubmissionId` で守る
- `validation_failed`・`returned`・`rejected`・`withdrawn`・`expired` になったら、受付用の S3 のパッケージを `archive/` に移す（90 日で消える。M-4）
- `approved` になったら、パッケージとアイコンを公開用のバケットに写す
- 素材集の申請も同じ状態の移り方をとる。違いは、アイコンがないこと、試用チケットがないこと（M-19）、承認の前に身元の記録が要ること（M-17）、機械審査と承認で D-8 の確認をすること（M-22）

**チャンネル（CHANNEL）**: `active`（承認済みの版がなくてもよい）→ `revoked`（取り下げ）→ 新しい版の承認で `active` に戻る。取り下げ中はリストに載らない

**素材集（COLLECTION）**: チャンネルと同じ（`active` ⇄ `revoked`）。取り下げると利用の記録は残し（取り下げを知らせる先のため）、使っているチャンネルはアプリ側で次の候補に進む（platform ADR-MATERIAL-PRODUCERS D-12）

**チャンネル提供者（PUBLISHER）**: `pending_key`（登録直後。鍵の紐づけ待ち）→ `active` → `suspended`（運営が停止）→ `active`（運営が戻す）。どの状態からも、チャンネル提供者の退会で `deleted`（戻らない。M-15）。`active` 以外のあいだは申請できない

**鍵の移し替え（KEY_TRANSFER）**: `requested`（チャンネル提供者が新しい鍵を紐づけて申し出た）→ `approved`（運営が本人確認して承認）／ `rejected`（認めない）／ `cancelled`（チャンネル提供者が取り消した）。チャンネル提供者ごとに `requested` は 1 つだけ

**チャンネル提供者の鍵（KEY）**: 最初の紐づけは `active`。移し替えを申し出た新しい鍵は `pending_transfer` で、承認で `active`（古い鍵は `unbound`）、認めない・取り消しで `unbound`

## 物理モデル

### テーブル

| 項目 | 内容 |
|---|---|
| テーブル名 | `yorisoi-console`（アカウントごとに 1 つ） |
| キー | `PK`（文字列）、`SK`（文字列） |
| 課金 | オンデマンド |
| 復旧 | ポイントインタイムリカバリを有効にする。削除保護を有効にする |
| TTL | 属性 `ttl`（UNIX 秒）。一度きりの文字列・上限の数・期限切れの申請だけに付ける |
| ストリーム | 使わない（操作の記録はトランザクションの中で書く） |
| GSI1 | `GSI1PK` / `GSI1SK`、射影は ALL。持ち主ごとの一覧と、対象ごとの操作の記録 |
| GSI2 | `GSI2PK` / `GSI2SK`、射影は ALL。疎なインデックス。審査待ち・リストに載せるもの・取り下げ・移し替え待ち・チャンネル提供者の一覧 |

### 項目の種類とキー

| 種類 | PK | SK | GSI1PK / GSI1SK | GSI2PK / GSI2SK（あるときだけ） |
|---|---|---|---|---|
| ユーザー | `USER#{sub}` | `USER` | — | — |
| チャンネル提供者 | `PUB#{publisherId}` | `PUB` | — | `PUBLISHERS` / `{createdAt}` |
| チャンネル提供者の鍵 | `PUB#{publisherId}` | `KEY#{accountId}` | — | — |
| アカウントIDの予約 | `ACCOUNT#{accountId}` | `ACCOUNT` | — | — |
| 一度きりの文字列 | `PUB#{publisherId}` | `CHALLENGE#{nonce}` | — | — |
| 1 日の数 | `PUB#{publisherId}` | `QUOTA#{yyyy-mm-dd}` | — | — |
| チャンネル | `CH#{channelId}` | `CH` | `PUB#{publisherId}` / `CH#{channelId}` | 載せるとき `LISTED` / `CH#{channelId}` |
| 申請 | `CH#{channelId}` | `SUB#{submissionId}` | — | 審査待ちのとき `QUEUE#REVIEW` / `{submittedAt}#{channelId}` |
| 審査の記録 | `CH#{channelId}` | `SUB#{submissionId}#REVIEW#{at}` | — | — |
| 試用チケット | `CH#{channelId}` | `SUB#{submissionId}#TICKET#{issuedAt}` | — | — |
| 取り下げ | `CH#{channelId}` | `REVOKE#{revokedAt}` | — | 7 日のあいだ `REVOKED` / `{revokedAt}#{channelId}` |
| 鍵の移し替え | `PUB#{publisherId}` | `TRANSFER#{transferId}` | `TRANSFERS` / `{requestedAt}#{transferId}`（過去の申し出の一覧） | `requested` のとき `QUEUE#TRANSFER` / `{requestedAt}#{transferId}` |
| スタジオの承認 | `PUB#{publisherId}` | `STUDIO` | — | 審査待ちのとき `QUEUE#STUDIO` / `{requestedAt}#{publisherId}` |
| 送ったメール | `NOTICE#{noticeId}` | `NOTICE` | — | — |
| 公開の先頭 | `PUBLICATION` | `HEAD` | — | — |
| 公開の履歴 | `PUBLICATION` | `SEQ#{seq を 10 桁で 0 埋め}` | — | — |
| 鍵セットの先頭 | `KEYSET` | `HEAD` | — | — |
| 鍵セットの履歴 | `KEYSET` | `SEQ#{seq を 10 桁で 0 埋め}` | — | — |
| 署名鍵 | `SIGNKEY` | `KEY#{keyId}` | — | — |
| 操作の記録 | `AUDIT#{yyyy-mm}` | `{at}#{eventId}` | `TARGET#{種類}#{ID}` / `{at}` | — |
| 素材集 | `COL#{collectionId}` | `COL` | `PUB#{publisherId}` / `COL#{collectionId}` | 載せるとき `LISTED` / `COL#{collectionId}` |
| 素材集の申請 | `COL#{collectionId}` | `SUB#{submissionId}` | — | 審査待ちのとき `QUEUE#REVIEW` / `{submittedAt}#col:{collectionId}` |
| 素材集の審査の記録 | `COL#{collectionId}` | `SUB#{submissionId}#REVIEW#{at}` | — | — |
| 素材集の取り下げ | `COL#{collectionId}` | `REVOKE#{revokedAt}` | — | 7 日のあいだ `REVOKED` / `{revokedAt}#col:{collectionId}` |
| 利用の記録 | `COL#{collectionId}` | `USEDBY#{channelId}` | `CH#{channelId}` / `USES#{collectionId}`（チャンネルから引く） | — |

- 送ったメールは、SQS が同じ知らせを 2 度届けても 1 通だけ送るための印。`event`・`messageId` だけを持ち、30 日の TTL で消える（宛先は持たない）

- 疎なインデックスの項目は、条件から外れたときに `GSI2PK`・`GSI2SK` を消す（例: 申請が `in_review` を出たら `QUEUE#REVIEW` から外れる）
- `REVOKED` から外すのは、公開の Lambda が毎日の作り直しのときに行う（7 日を過ぎたものの `GSI2PK` を消す）
- 素材集の項目は `kind = "collection"` を持ち、チャンネルの項目と同じ GSI2 のパーティション（`QUEUE#REVIEW`・`LISTED`・`REVOKED`）に入る。GSI2SK の `col:` と `CH#`・`COL#` の接頭辞で、ID の名前空間が違っても重ならない
- `AUDIT#{yyyy-mm}` は月ごとに 1 つのパーティションになる。書き込みは 1 秒に数件の想定で、パーティションの上限（1 秒に 1,000 件）に十分に収まる

## データ辞書

共通の属性: `type`（項目の種類）、`createdAt`、`updatedAt`、`rev`（状態が変わる項目だけ。M-11）

### チャンネル提供者（PUB）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `publisherId` | S | ○ | ULID |
| `ownerSub` | S | ○ | 持ち主の Cognito の `sub`（M-1） |
| `displayName` | S | ○ | リストの `publisherName` に使う。1〜40 文字 |
| `contact` | S | ○ | 審査・移し替えの連絡先（Cognito のメールとは別に持つ。本人確認の「別の経路」の候補。ADR-001 未決事項 No.5） |
| `status` | S | ○ | `pending_key` / `active` / `suspended` / `deleted` |
| `pendingTransferId` | S | — | `requested` の移し替え（1 つだけ。あいだは申請を受け付けない） |
| `activeAccountId` | S | — | 使っている鍵のアカウントID（`sg1…`） |
| `channelCount` | N | ○ | 持っているチャンネルの数（取り下げたものも数える。上限の回避を防ぐため） |
| `limits` | M | — | 運営が変えた上限（`channels`・`collections`・`uploadsPerDay`・`ticketsPerDay`）。ないものは既定値（M-2・M-19） |
| `suspendedReason` | S | — | 停止の理由 |
| `deletedAt` | S | — | 退会した日時。退会すると `displayName`・`contact` を消す（M-15） |
| `roles` | SS | ○ | `publisher`・`producer` のどれか（M-16）。登録のときは `publisher` |
| `collectionCount` | N | — | 持っている素材集の数（取り下げたものも数える。M-19） |
| `producerVerification` | M | — | 運営が記録した身元の確認（`method`・`detail`・`verifiedAt`・`operatorSub`。M-17・D-20）。表示名を変えると消す |

### チャンネル提供者の鍵（KEY）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `accountId` | S | ○ | `sg1…` |
| `publicKey` | S | ○ | Ed25519 の公開鍵（base64url） |
| `status` | S | ○ | `active` / `pending_transfer` / `unbound`（M-14） |
| `boundAt` | S | ○ | 紐づけた日時（一度きりの文字列の署名を確かめた日時） |
| `unboundAt` | S | — | 外した日時 |
| `unboundReason` | S | — | `lost` / `leaked` / `other` と説明 |

アカウントIDの予約（`ACCOUNT#…`）には `publisherId` だけを持たせ、条件付き書き込み（まだないこと）で M-7 を守る。外したあとも消さない。

### チャンネル（CH）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `channelId` | S | ○ | 英小文字・数字・`-`、3〜40 文字（platform API-CHANNEL-LIST） |
| `publisherId` | S | ○ | 持ち主 |
| `status` | S | ○ | `active` / `revoked` |
| `pendingSubmissionId` | S | — | 審査待ちの申請（M-2 の 1 つ） |
| `latestApproved` | M | — | 最新の承認済みの版（下表）。M-8 |
| `publisherChange` | M | — | `from`・`at`・`reason`・`until`（platform API-CHANNEL-LIST P-9）。移し替えの承認で `from`（リストに載っている版のチャンネル提供者）・`at`・`reason` を書き、新しい鍵の最初の版の承認で `until`（その 90 日後）を書く。公開の Lambda は、`until` があり、過ぎておらず、`from` が載せる版のチャンネル提供者と違うときだけ載せる（V-16） |

`latestApproved` の中身（リストの `channels[]` の 1 件になる）:

| 属性 | 内容 |
|---|---|
| `submissionId`・`version` | 承認した申請と版の番号 |
| `publisher` | 署名したアカウントID |
| `name`・`summary`・`description`・`lang`・`tags`・`regions` | `channel.json` と申請の画面から |
| `icon` | `{ url, sha256 }`（公開用のバケットの `/icons/{sha256}.png`） |
| `package` | `{ url, sha256, size, format }`（`/pkg/{sha256}.zip`） |
| `approvedAt` | 承認した日時 |
| `appStage` | 承認時に、リストに載っていた素材集の中身まで数えたアプリの段 |
| `collections` | 宣言した素材集 `[{ as, id, minVersion }]`。公開のたびに `resourcesSize`・`media` を足し合わせるのに使う（M-24） |
| `ownPrefetchBytes`・`ownMedia` | チャンネル自身の素材の前もっての取得の大きさと種類（M-24） |
| `activities`・`genres`・`requires` | パッケージの値（M-26） |
| `minAppVersions` | アプリの ID → 必要な版。機械審査が出した必要なアプリの段から決める（M-23・M-27） |

### 素材集（COL）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `kind` | S | ○ | `collection` |
| `collectionId` | S | ○ | 英小文字・数字・`-`、3〜40 文字（platform API-MATERIAL-PRODUCER）。チャンネルの ID と別の名前空間 |
| `publisherId` | S | ○ | 持ち主のアカウント（素材提供者の役割を持つこと） |
| `status` | S | ○ | `active` / `revoked` |
| `pendingSubmissionId` | S | — | 審査待ちの申請（M-19 の 1 つ） |
| `latestApproved` | M | — | 最新の承認済みの版（下表）。M-24 |
| `producerChange` | M | — | `from`・`at`・`reason`・`until`。チャンネルの `publisherChange` と同じ決まり（platform API-CHANNEL-LIST P-13） |
| `externalCheck` | M | — | 毎日の確認の結果 `{ checkedAt, failures: [{ resourceId, url, status }] }`（M-21）。チャンネルの項目にも同じ属性を持たせる |

`latestApproved` の中身（リストの `collections[]` の 1 件になる）:

| 属性 | 内容 |
|---|---|
| `submissionId`・`version` | 承認した申請と版の番号 |
| `producer` | 署名したアカウントID |
| `name`・`summary` | `collection.json` から |
| `media`・`resourcesSize`・`tags`・`regions`・`grants` | 承認時にパッケージから計算する（`regions` は `core-format` の `Regions.of`。platform API-CHANNEL-LIST P-15）。`grants.apps` を含む（M-28） |
| `package` | `{ url, sha256, size, format }`（公開用のバケットの `/col/{sha256}.zip`） |
| `resourceTypes` | 素材の ID と種類の対応。次の版の D-8 の確認と、チャンネルの段の計算に使う |
| `externalResources` | 外部の素材の `[{ resourceId, url, size }]`（M-21 の確認の対象） |
| `minAppVersions`・`appStage` | 素材の種類から決めた段と、アプリごとの版（M-23・M-27） |
| `minAppVersions` | `grants.apps` が含むアプリ（ないときはすべて）の ID → 必要な版（M-27） |
| `approvedAt` | 承認した日時 |

### 利用の記録（USEDBY）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `collectionId`・`channelId` | S | ○ | 使われる素材集と、使うチャンネル |
| `publisherId` | S | ○ | チャンネルの持ち主（D-18 の知らせの宛先を引く） |
| `channelVersion` | N | ○ | 記録したときのチャンネルの版 |
| `resources` | M | ○ | 参照している素材の ID と、承認時の種類（`{ "intro": "text" }`）。ID で指さない使い方（題材で選ぶ）だけのときは空 |

### 申請（SUB）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `submissionId` | S | ○ | ULID |
| `version` | N | — | パッケージの `channel.json` の `version`（機械審査で読む）。M-5 |
| `accountId` | S | ○ | 申請したときのチャンネル提供者のアカウントID |
| `state` | S | ○ | [状態の移り方](#状態の移り方)のとおり |
| `intakeKey` | S | ○ | 受付用の S3 のキー `intake/{channelId}/{submissionId}.zip` |
| `iconIntakeKey` | S | ○ | アイコンの受付用のキー `intake/{channelId}/{submissionId}.png` |
| `iconSha256` | S | — | 届いたアイコン（機械審査で計算） |
| `description`・`tags`・`regions` | S・L・L | — | リストに載せる項目のうち、パッケージにないもの（platform API-CHANNEL-LIST `channels[]`） |
| `sha256`・`size` | S・N | — | 届いたパッケージ（機械審査で計算） |
| `validation` | M | — | `{ ok, errors: [{ code, detail }], appStage, checkedAt, validatorVersion }`。`code` は platform API-CHANNEL-PACKAGE のエラーコード |
| `note` | S | — | チャンネル提供者から運営への説明 |
| `listing` | M | — | 機械審査が記録したリストに載せる値（DES-007〜DES-009）。`activities`・`genres`・`requires`（M-26）、素材集では `grants.apps`（M-28） |
| `submittedAt` | S | — | 機械審査に合格した日時（審査待ちの順番） |
| `decidedAt` | S | — | 承認・差し戻し・却下・取り消しの日時 |
| `ttl` | N | — | `uploading` のあいだだけ（1 時間）。届けば消す |

素材集の申請は同じ属性を持ち、次が違う: `kind = "collection"`、`intakeKey` は `intake-col/{collectionId}/{submissionId}.zip`、アイコン・`description`・`tags`・`regions` はない。`validation` に `external`（外部の素材ごとの `{ resourceId, ok, detail }`。M-20）と `inUse`（D-8 の確認で消えた・種類が変わった素材 `[{ channelId, resourceId, detail }]`。M-22）と `warnings`（利用許諾の縮小で使えなくなるチャンネルなど、拒みはしないが知らせること）を足す

### 審査の記録（REVIEW）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `reviewerSub` | S | ○ | 運営の Cognito の `sub` |
| `action` | S | ○ | `start` / `release`（審査を戻した） / `approve` / `return` / `reject` |
| `findings` | L | — | `[{ item: "2.2", detail }]`。審査基準の項目番号つき（platform チャンネル審査方針 3） |
| `samplesIds` | L | — | 判定に使った見本。見本は記録用のバケットの `reviews/{submissionId}/{samplesId}.json` |
| `message` | S | — | チャンネル提供者への説明 |

### 取り下げ（REVOKE）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `versions` | L | — | 取り下げた版の番号。ないときはすべての版（platform API-CHANNEL-LIST `revoked[].versions`） |
| `reason` | S | ○ | 散策者に見せる理由 |
| `severity` | S | ○ | `high` / `low`（platform チャンネル審査方針「取り下げ」） |
| `operatorSub` | S | ○ | 取り下げた運営 |

### 鍵の移し替え（TRANSFER）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `transferId` | S | ○ | ULID |
| `fromAccountId`・`toAccountId` | S | ○ | 前と後のアカウントID。`to` は申し出の前に紐づけ済み（A-5） |
| `reason` | S | ○ | `lost` / `leaked` / `other` |
| `publicReason` | S | ○ | リストの `publisherChange.reason` に載せる文 |
| `state` | S | ○ | `requested` / `approved` / `rejected` / `cancelled` |
| `verification` | M | — | 運営が記録する本人確認（`method`・`detail`・`verifiedAt`） |
| `returnedSubmissions` | L | — | 承認のときに差し戻した申請（古い鍵の署名。チャンネル提供者のすべてのチャンネルから） |
| `decisionReason` | S | — | 認めなかった理由 |

### 公開の記録（PUBLICATION）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `seq` | N | ○ | platform API-CHANNEL-LIST の `seq` |
| `issuedAt`・`expiresAt` | S | ○ | リストに書いた値 |
| `sha256`・`size` | S・N | ○ | リスト本体の `payload` のバイト列（要約に書いた値） |
| `keyId` | S | ○ | 要約に署名した署名鍵 |
| `archiveKey` | S | ○ | 記録用のバケットの `published/{seq}.json` |
| `trigger` | S | ○ | `approve` / `revoke` / `transfer` / `keyset` / `daily` / `manual` |
| `channelCount`・`revokedCount` | N | ○ | 載せた件数 |

先頭（`HEAD`）は最新の 1 件と同じ属性を持つ。公開の Lambda は `seq = :前に読んだ値` を条件に `HEAD` を書き換え、同じトランザクションで履歴を足す。

### 鍵セットと署名鍵

| 種類 | 主な属性 |
|---|---|
| 鍵セット（先頭・履歴） | `seq`、`document`（ルート鍵が署名した文書をそのまま）、`registeredBy`、`verifiedAt` |
| 署名鍵 | `keyId`（例: `k-2026-10`）、`kmsKeyArn`、`publicKey`、`notBefore`、`notAfter`、`status`（`registered`（登録したが鍵セットに載っていない） / `active` / `retiring` / `revoked`）。公開の Lambda は、鍵セットに載っていて期間内の `active` の鍵を使う |

### 試用チケット（TICKET）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `issuedAt`・`expiresAt` | S | ○ | 7 日以内（platform API-CHANNEL-LIST） |
| `trialKey` | S | ○ | 公開用のバケットの `trial/{sha256}.zip`（7 日で消える。A-13） |
| `document` | S | ○ | 署名済みのチケット（QR コードにするもの） |

### 1 日の数（QUOTA）

`uploads`・`tickets`（N）。`uploads` はチャンネルと素材集の申請を合わせて数える（M-19）。日本時間の日付ごとの項目。`ADD` と条件（`uploads < :上限`）で増やす。`ttl` は 3 日後。

### 操作の記録（AUDIT）

| 属性 | 型 | 必須 | 内容 |
|---|---|---|---|
| `eventId` | S | ○ | ULID |
| `at` | S | ○ | 日時 |
| `actorSub`・`actorRole` | S | ○ | だれが（`publisher` / `operator` / `system`） |
| `action` | S | ○ | 例: `publisher.register`・`key.bind`・`submission.create`・`submission.approve`・`channel.revoke`・`transfer.approve`・`keyset.register`・`publication.publish`・`publisher.suspend`・`publisher.delete`・`limits.update`・`notification.sent`・`notification.failed`（`detail` に出来事と SES のメッセージ ID。メールアドレスは入れない） |
| `target` | S | ○ | 例: `CH#kamakura-history`・`PUB#01J…` |
| `reason` | S | — | 理由（運営の操作では必須） |
| `detail` | M | — | 前後の値など。秘密（API キー、トークン）は入れない |

## DDL方針

DynamoDB なので DDL はなく、テーブルとインデックスは CDK（`infra/`）で定義する。

- テーブル・GSI・TTL・ポイントインタイムリカバリ・削除保護は CDK で作る。手で変えない
- 項目の形は、`api/` の TypeScript の型と実行時の検証（zod など）で 1 か所に定義し、読むときにも検証する
- 状態を変える書き込みは、次の単位で `TransactWriteItems` にまとめる（すべて操作の記録を含む）

| 操作 | 1 つのトランザクションで書くもの |
|---|---|
| チャンネル提供者の登録 | ユーザー、チャンネル提供者（`pending_key`） |
| 鍵の紐づけ | 一度きりの文字列の削除、アカウントIDの予約（まだないこと）、チャンネル提供者の鍵、チャンネル提供者（`activeAccountId`、`pending_key` → `active`） |
| チャンネルの登録 | チャンネル（まだないこと）、チャンネル提供者（`channelCount < 上限`、`status = active`） |
| 申請の開始 | 1 日の数（`uploads < 上限`）、チャンネル（`pendingSubmissionId` がないこと）、申請（`uploading`） |
| 承認 | 申請（`in_review` → `approved`）、前の承認済みの申請（→ `superseded`）、チャンネル（`latestApproved`・`LISTED`、`pendingSubmissionId` を消す、`status` を `active` に）、審査の記録 |
| 取り下げ | 取り下げ、チャンネル（`revoked`、`LISTED` を外す）、承認済みの申請（→ `revoked`） |
| 移し替えの承認 | 移し替え（`requested` → `approved`）、チャンネル提供者（`activeAccountId`、`pendingTransferId` を消す）、新しい鍵（→ `active`）、古い鍵（→ `unbound`）、チャンネル提供者のすべてのチャンネル（`publisherChange`、審査待ちの申請を外す）、審査待ちの申請（→ `returned`）。チャンネル 5 つと申請 5 つでも 20 件ほど |
| 退会 | チャンネル提供者（→ `deleted`、表示名・連絡先を消す）、公開中のチャンネル（→ `revoked`）と取り下げ、承認済みの申請（→ `revoked`）、審査待ちの申請（→ `withdrawn`）、移し替えの申し出（→ `cancelled`）。1.3: 公開中の素材集（→ `revoked`）と取り下げ、その承認済み・審査待ちの申請、チャンネルの利用の記録の削除も同じトランザクションに入れる。チャンネル 5 つ・素材集 5 つで 50 件ほど。Cognito のユーザーの削除はトランザクションの後 |
| 素材提供者の役割を有効にする | アカウント（`roles` に `producer` を足す。`status = active`） |
| 素材集の登録 | 素材集（まだないこと）、アカウント（`collectionCount < 上限`、`producer` の役割、`status = active`） |
| 素材集の申請の開始 | 1 日の数（`uploads < 上限`。チャンネルと共通）、素材集（`pendingSubmissionId` がないこと）、申請（`uploading`） |
| 素材集の承認 | 申請（`in_review` → `approved`）、前の承認済みの申請（→ `superseded`）、素材集（`latestApproved`・`LISTED`）、審査の記録、アカウント（`producerVerification` があること。初めての承認なら同じトランザクションで書く）。D-8 の確認（M-22）はトランザクションの前に利用の記録を読んで行い、利用の記録の `rev` を条件に入れる |
| チャンネルの承認（素材集の分） | 使う素材集ごとの利用の記録（書く・書き直す）と、使わなくなった素材集の利用の記録の削除。素材集 5 つで 10 件ほど増える |
| 素材集の取り下げ | 取り下げ、素材集（`revoked`、`LISTED` を外す）、承認済みの申請（→ `revoked`）。利用の記録は残す。使っているチャンネル提供者への知らせは、トランザクションの後に送る（D-18） |
| 移し替えの承認（素材集の分） | アカウントのすべての素材集（`producerChange`、審査待ちの申請を外す）、素材集の審査待ちの申請（→ `returned`）。素材集 5 つと申請 5 つで 10 件ほど増える |

- 承認・取り下げ・移し替えの承認・鍵セットの登録のあと、公開の Lambda を非同期で呼ぶ（ADR-001 A-10）
- 1 つのトランザクションは 100 件まで。上の操作は多くても 10 件ほど

### S3 に置くもの

| バケット | キー | 保持 |
|---|---|---|
| 受付用（非公開） | `intake/{channelId}/{submissionId}.zip` | 審査中は残す。結果が出たら `archive/` に移す |
| 受付用（非公開） | `archive/{channelId}/{submissionId}.zip` | 90 日で消す（ライフサイクル。M-4） |
| 公開用（CloudFront） | `.well-known/sanpo-channels`、`v1/channels.json` | 毎回上書き |
| 公開用（CloudFront） | `pkg/{sha256}.zip`、`icons/{sha256}.png` | 消さない（取り下げても、URL は残る。アプリはリストで止める） |
| 公開用（CloudFront） | `trial/{sha256}.zip` | 7 日で消す |
| 記録用（非公開） | `published/{seq}.json`、`keysets/{seq}.json`、`samples/{submissionId}/prompts.json`（見本用のプロンプト）、`reviews/{submissionId}/{samplesId}.json`（見本） | 消さない |
| 受付用（非公開） | `intake/{channelId}/{submissionId}.png`（アイコン） | パッケージと同じ |
| 受付用（非公開） | `intake-col/{collectionId}/{submissionId}.zip`、`archive-col/{collectionId}/{submissionId}.zip` | チャンネルと同じ（M-4）。素材集の ID はチャンネルの ID と重なりうるので、接頭辞を分ける |
| 公開用（CloudFront） | `col/{sha256}.zip` | 消さない（チャンネルのパッケージと同じ） |

## 移行・互換性メモ

- 新しいシステムなので、移行するデータはない
- 項目に属性を足すのは互換性のある変更。読むときの検証は、知らない属性を無視する
- キーの形（PK・SK・GSI）を変えるときは、新しい形で書き、古い形の項目を一括で書き直すスクリプトを用意する。運営の担当者が 1 人で件数が少ないうちは、メンテナンス時間を取って行ってよい
- 複数メンバーのチャンネル提供者（M-1 の将来）は、`PUB#{publisherId}` / `MEMBER#{sub}` の項目を足し、ユーザーの項目を「どのチャンネル提供者のメンバーか」に変えて対応する。`ownerSub` は最初のメンバーになる

## 検証観点

| No. | 観点 |
|---|---|
| DV-01 | AP-01〜AP-22 が、スキャンなしで（キーと GSI だけで）満たせる |
| DV-02 | 同じアカウントIDを 2 つのチャンネル提供者に同時に紐づけようとすると、片方だけが成功する（M-7） |
| DV-03 | 同じチャンネルに 2 つの申請を同時に始めようとすると、片方だけが成功する（M-2） |
| DV-04 | 1 日の上限を超えた申請・試用チケットが、同時に送られても上限を超えない |
| DV-05 | 版の番号が最後に承認した版以下の申請は、受付時にも承認時にも通らない（M-5） |
| DV-06 | 2 人の運営が同じ申請を同時に承認・差し戻ししても、どちらか一方だけが記録される（M-11） |
| DV-07 | 公開の Lambda が同時に 2 つ動いても、`seq` が重複しない |
| DV-08 | 移し替えを承認すると、古い鍵の署名の審査待ちの申請が `returned` になり、次の申請は新しい鍵でないと受け付けない |
| DV-09 | 取り下げたチャンネルがリストから消え、`revoked` に 7 日載り、8 日目の作り直しで外れる（M-9） |
| DV-10 | 状態を変える操作のすべてに、操作の記録が同じトランザクションで残る |
| DV-11 | 停止中のチャンネル提供者は申請・試用チケット・鍵の紐づけができず、公開中のチャンネルはリストに残る（M-10） |
| DV-12 | 結果が出た申請のパッケージが `archive/` に移り、90 日で消える。承認したものは公開用のバケットに残る |
| DV-13 | 1 つの項目が 400KB を超えない（見本は S3 に置く。`validation.errors` は 100 件で打ち切る） |
| DV-14 | AP-23〜AP-29 が、スキャンなしで満たせる |
| DV-15 | 同じ ID の素材集とチャンネルを別のアカウントが登録でき、素材集の ID は 2 つ目の登録が失敗する（M-18） |
| DV-16 | 利用の記録にある素材の ID を消した・種類を変えた素材集の申請が、機械審査でも承認でも通らない。承認の直前にチャンネルが承認されても、`rev` の条件で片方が失敗する（M-22） |
| DV-17 | 身元の記録がないアカウントの素材集は承認できず、表示名を変えると記録が消える（M-17） |
| DV-18 | チャンネルと素材集の申請を合わせて 1 日 20 回を超えない（M-19） |
| DV-19 | 退会で公開中の素材集が取り下げられ、`revokedCollections` に 7 日載る（M-25） |
| DV-20 | チャンネルの新しい版の承認と取り下げで、利用の記録が書き直される・消える |
| DV-21 | 素材集の新しい版の承認で、使っているチャンネルの `resourcesSize`・`media` が次の公開から変わる（M-24） |

## 制約

- DynamoDB の 1 つの項目は 400KB まで。大きなもの（見本、リストの本体、鍵セットの文書の履歴）は S3 に置く
- `TransactWriteItems` は 100 件まで、また同じ項目を 1 つのトランザクションで 2 回書けない
- GSI は結果整合性。審査待ちの一覧は、承認の直後に古い状態が一瞬見えることがある（承認自体は本体の項目の条件で守る）
- 取り下げても、公開用のバケットのパッケージの URL は残る（中身はハッシュで固定されている。止めるのはリスト）

## 未決事項・リスク

| No. | 内容 | 決める時期 |
|---|---|---|
| 1 | 却下（`rejected`）されたパッケージを、根拠として 90 日より長く残すか（M-4 では 90 日） | 運用の開始後 |
| 2 | platform ADR-MATERIAL-PRODUCERS の未決事項 No.4（「確認済み」の印）を採るなら、`producerVerification` から作る | platform ADR-MATERIAL-PRODUCERS の判断 |

## 関連ドキュメント・参照リンク

- [ADR-001](adr/ADR-001-aws-architecture.md): AWS の構成
- [platform API-CHANNEL-LIST](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-LIST.md): 承認済みチャンネル・リスト
- [platform API-CHANNEL-PACKAGE](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-PACKAGE.md): パッケージの形式
- [platform チャンネル審査方針](https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/channel-review.md): 審査基準
- [platform ADR-MATERIAL-PRODUCERS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/decisions/ADR-MATERIAL-PRODUCERS.md)・[platform API-MATERIAL-PRODUCER](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-MATERIAL-PRODUCER.md): 素材の素材提供者と素材集
