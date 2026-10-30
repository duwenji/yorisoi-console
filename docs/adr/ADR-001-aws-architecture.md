# ADR-001 チャンネル管理システムを AWS のサーバーレス構成で作り、承認済みチャンネル・リストを S3 と CloudFront で公開する

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | ADR-001（yorisoi-console） |
| ドキュメント種別 | ADR |
| 対象システム/機能 | チャンネル管理システム（SanpoGuide の第三者のチャンネルの申請・審査・承認・取り下げと、承認済みチャンネル・リストの署名・公開） |
| 関連Skill | architecture-decision-record |
| 作成日 | 2026-10-03 |
| 作成者 | Claude（開発者との検討） |
| 承認者 | 開発者 |
| ステータス | 承認済 |
| 版 | 1.0 |

本書で「platform ADR-CHANNEL-CURATION」「platform API-CHANNEL-LIST」「platform API-CHANNEL-PACKAGE」と書くものは、[yorisoi-platform](https://github.com/duwenji/yorisoi-platform) の文書を指す。

## 目的・背景

SanpoGuide のアプリは、第三者が配信するチャンネルのうち、運営が審査して署名したものだけを取り込む（[platform ADR-CHANNEL-CURATION](https://github.com/duwenji/yorisoi-platform/blob/main/docs/decisions/ADR-CHANNEL-CURATION.md)）。審査と公開はアプリとは別の**チャンネル管理システム**で行い、アプリとの境界は承認済みチャンネル・リストの契約（[platform API-CHANNEL-LIST](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-LIST.md)）だけにする。platform API-CHANNEL-LIST に準拠していれば、管理システムの実装方法と置き場所は問わない（platform ADR-CHANNEL-CURATION C-9）。

本書は、その管理システムの実装方法と置き場所を決める。条件は次のとおり。

1. アプリとは別のリポジトリにする
2. AWS の API Gateway・Lambda・DynamoDB を使う
3. 画面は Single Page Application にする
4. 承認済みチャンネル・リストの URL は公開する
5. 秘密鍵で署名する

## スコープ・非スコープ

スコープ:
- リポジトリの構成
- AWS の構成（認証、API、データ、公開、署名、機械審査、定期処理、監視）
- 鍵の置き場所と使い方（ルート鍵・署名鍵・チャンネル提供者の鍵）
- チャンネル提供者の鍵の移し替えの流れ（platform ADR-CHANNEL-CURATION C-11）

非スコープ（別の文書で決める）:
- リストとパッケージの形式（platform API-CHANNEL-LIST・platform API-CHANNEL-PACKAGE）
- 審査基準の中身（platform チャンネル審査方針）
- DynamoDB のキー設計の詳細（[DM-001](../data-model.md)）
- 画面の詳細設計

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| platform ADR-CHANNEL-CURATION | C-9（管理システム）、C-10（運営）、C-11（チャンネル提供者の鍵の移し替え）、C-12（実装） | 本書で実装方法を決める |
| platform API-CHANNEL-LIST | L-1〜L-5、P-1〜P-9。とくに L-3（KMS）、P-1（2 段の鍵）、P-7（静的ファイルで公開）、P-8（要約への署名）、準拠テスト | 本書で実装する |
| platform API-CHANNEL-PACKAGE | 確認の手順 1〜10（機械で確かめる項目）、F-6（チャンネル提供者の署名） | 機械審査で `core-format` を使う |

## 方針・決定事項

### 前提の決定

| No. | 論点 | 決定 |
|---|---|---|
| D-1 | 署名の大きさの制限 | KMS の Ed25519 は一度に 4,096 バイトまでしか署名できない。リストは本体の SHA-256 を含む要約に署名する（platform API-CHANNEL-LIST P-8）。アプリは Tink だけで確かめられる |
| D-2 | ログイン | Amazon Cognito |
| D-3 | チャンネル提供者の鍵をなくしたとき | 運営の判断で別の鍵に移す救済策を作る（platform ADR-CHANNEL-CURATION C-11、platform API-CHANNEL-LIST P-9） |
| D-4 | 審査で AI に話させる見本 | 運営の API キーで、ブラウザから AI を呼ぶ。キーはサーバーに送らない |
| D-5 | AWS アカウントとリージョン | 本番用の AWS アカウントを分ける。リージョンは ap-northeast-1 |
| D-6 | 準拠テストの置き場所 | 任意のリストの公開 URL に対して流せるテストを、本リポジトリに置く |
| D-7 | チャンネル提供者の登録 | 誰でも登録できる（招待制にしない）。悪用への備えは A-18 |

### 構成の決定

| No. | 論点 | 決定案 |
|---|---|---|
| A-1 | リポジトリ | モノレポにする。`web/`（SPA）、`api/`（Lambda、TypeScript）、`validator/`（機械審査の Lambda、Kotlin）、`infra/`（AWS CDK、TypeScript）、`tools/root-key/`（ルート鍵の CLI）、`conformance/`（platform API-CHANNEL-LIST の準拠テスト） |
| A-2 | AWS アカウント | 開発用と本番用の 2 つ。どちらも ap-northeast-1。CloudFront の証明書だけは ACM の us-east-1 に置く（CloudFront の決まり）。開発用は別のルート鍵を持つ別のリストにし、アプリには内蔵しない（デバッグビルドで設定から足して使う） |
| A-3 | API | API Gateway の HTTP API。Cognito の JWT で認可する。Lambda は Node.js（TypeScript）。運営だけの操作は、JWT のグループ（`operator`）を Lambda の中でも確かめる |
| A-4 | ログイン | Cognito の 1 つのユーザープールに `operator` と `publisher` のグループを作る。**MFA（TOTP）は全員に必須**（Cognito の MFA はユーザープール単位でしか決められないため）。チャンネル提供者は誰でもメールアドレスで登録でき（D-7）、確認が済むと post-confirmation トリガーが `publisher` グループに入れる。運営は管理者が作り `operator` グループに入れる（登録からは運営になれない）。ログインの画面は Cognito のマネージドログイン（v2）、SPA は認可コード + PKCE の公開クライアント（シークレットなし） |
| A-5 | チャンネル提供者の鍵の紐づけ | チャンネル提供者のアカウントID（`sg1…`）は、管理システムが出す一度きりの文字列にチャンネル提供者の鍵で署名させ、持ち主であることを確かめてから Cognito のユーザーに紐づける。チャンネル提供者の秘密鍵はサーバーに送らない。パッケージへの署名（platform API-CHANNEL-PACKAGE F-6）は、SPA のブラウザ内（WebCrypto の Ed25519）か CLI で行う |
| A-6 | データ | DynamoDB の 1 テーブル（ポイントインタイムリカバリを有効にする）。持つものは、チャンネル提供者、チャンネル、版（申請の状態）、審査の記録、公開の記録（`seq`）、鍵セット、試用チケット、操作の記録。パッケージ・アイコンは DynamoDB に入れず S3 に置く |
| A-7 | 公開 | 公開用の S3 バケット（非公開。CloudFront の OAC からだけ読める）を、独自ドメインの CloudFront で配信する。API Gateway は通さない（platform API-CHANNEL-LIST P-7: 管理システムが止まってもアプリは動く）。置くものは `/.well-known/sanpo-channels`、`/v1/channels.json`、`/pkg/{sha256}.zip`、`/icons/{sha256}.png`、`/trial/{sha256}.zip`。パッケージとアイコンは中身のハッシュを名前にして `immutable` で長くキャッシュし、リストと検出の文書は短く（5 分）キャッシュする。書き込めるのは公開の Lambda だけ |
| A-8 | 署名鍵 | KMS の `ECC_NIST_EDWARDS25519`（`SIGN_VERIFY`、鍵は取り出せない）で、`ED25519_SHA_512`・`MessageType: RAW` で署名する。署名するのは、リストの要約と試用チケットだけ（どちらも 4,096 バイト未満）。`kms:Sign` を許すのは、公開の Lambda と試用チケットの Lambda のロールだけ（キーポリシーで縛る）。署名鍵は半年ごとに新しい KMS 鍵を作って入れ替え、鍵セットの有効期間（1 年以内）と重ねる |
| A-9 | ルート鍵 | `tools/root-key` の CLI で、ネットワークにつながない端末で作り、鍵セットに署名する。秘密鍵は複数の場所にオフラインで保管する。署名した鍵セットは運営の画面から登録し、Lambda がルート鍵の公開鍵（設定に固定）で署名を確かめてから公開する |
| A-10 | 公開の処理 | 公開の Lambda は、承認・取り下げ・鍵セットの登録のときと、毎日 1 回（EventBridge Scheduler）動く。同時に 1 つしか動かないようにし（予約同時実行数 1）、`seq` は DynamoDB の条件付き書き込みで必ず増やす。本体を作り、要約を KMS で署名し、S3 に置き、CloudFront のリストと検出の文書のキャッシュを消す。毎日の作り直しで、`expiresAt`（14 日）が切れる前に必ず新しいリストを出す |
| A-11 | 機械審査 | チャンネル提供者は、署名付きの URL で受付用の S3 バケット（公開しない）にパッケージを上げる（2MB の上限を URL の条件で縛る）。上がったら、機械審査の Lambda（Java 21）が yorisoi-platform の `core-format` を使って platform API-CHANNEL-PACKAGE の確認の手順 1〜10 を行い、結果をエラーコードのまま DynamoDB に残す。アプリと同じコードで確かめるので、審査とアプリの判定がずれない |
| A-12 | 承認したパッケージの公開 | 承認したときに、受付用のバケットから公開用のバケットの `/pkg/{sha256}.zip` へ写す。承認前のパッケージは公開しない（試用チケットの分を除く） |
| A-13 | 試用チケット | 発行するとき、パッケージを公開用のバケットの `/trial/{sha256}.zip` に写し、7 日で消す（S3 のライフサイクル）。チケットは KMS で署名し、SPA で QR コードにして見せる |
| A-14 | 審査の見本 | 運営の画面が、運営の API キーでブラウザから直接 AI を呼び、platform API-CHANNEL-PACKAGE のとおりにプロンプトを組み立てて場面ごとの見本を作る。キーはブラウザのメモリ（またはタブを閉じれば消える保存場所）にだけ置く。SPA の CSP で、通信先を自分の API と AI の API に限る |
| A-15 | チャンネル提供者の鍵の移し替え | チャンネル提供者が画面から新しい鍵の紐づけ（A-5 と同じ方法）と移し替えを申し出る → 運営が、鍵とは別の経路（登録済みの連絡先など）で本人確認する → 承認すると、チャンネル提供者が新しい鍵に変わり、移し替えを記録する。次の版から新しい鍵の署名が要り、リストには `publisherChange` を載せる（platform API-CHANNEL-LIST P-9）。漏れたときは、古い鍵で署名された承認待ちの版を差し戻し、必要なら公開中の版を取り下げる |
| A-16 | 監査と監視 | 状態を変える操作（申請・承認・差し戻し・取り下げ・移し替え・鍵セットの登録）は、だれが・いつ・何を・理由を DynamoDB の操作の記録に残す。KMS の署名は CloudTrail に残る。CloudWatch で、公開の失敗と、公開中のリストの `expiresAt` まで 3 日を切ったことを運営に知らせる |
| A-18 | 登録を開くことへの備え（D-7） | ① Cognito のユーザープールに AWS WAF を付け、登録・ログインの要求を送信元ごとに回数で制限する ② API Gateway のルートごとに流量を制限する ③ チャンネル提供者ごとの上限を Lambda で守らせる（例: チャンネル 5 つ、審査待ちの版 1 チャンネルにつき 1 つ、試用チケット 1 日 10 枚。値はデータモデルで決める） ④ 運営がチャンネル提供者を停止できる（停止中は申請・試用チケットを受け付けない。公開中のチャンネルは取り下げで別に扱う） ⑤ 機械審査に落ちた版は運営の審査待ちに入れない。チャンネル提供者が鍵を紐づける（A-5）までは申請できない |
| A-19 | チャンネル提供者への通知 | 判定・取り下げ・鍵の移し替えの結果を、Amazon SES でメールする（API-001 C-14）。API の Lambda は、状態を変えるトランザクションのあとに通知の要求を SQS に入れ、通知の Lambda が SES で送る。送れなければ再送し、それでも失敗したらデッドレターキューに入れて運営に知らせる（操作そのものは失敗にしない）。送信元は独自ドメイン（T-2）で DKIM・SPF・DMARC を設定する。本番のアカウントは SES のサンドボックスの解除を申請する。バウンスと苦情は SES の設定セットで受け、操作の記録に残す |
| A-20 | エコシステム（platform ADR-ECOSYSTEM-PLATFORM E-17・E-18・E-25・E-26、DES-011） | 管理システムとリストはエコシステムで 1 つ（アプリごとに分けない）。アプリは端末で絞り込む。機械審査は共通の `core-format` だけで確かめ（一覧にない値を拒む）、アプリごとの除外はしない。リストにはアプリごとの必要な版（`minAppVersions`）を載せる。審査の見本は過ごし方ごとの代表アプリのプロンプト・パックで作り（`walk` は SanpoGuide）、代表アプリのない過ごし方は見本を作らず語り手の文章を人が読む |
| A-17 | 配備 | AWS CDK（TypeScript）で両方のアカウントに配備する。GitHub Actions から OIDC で AWS に入る（長期のアクセスキーを持たない）。本番への配備は手動で承認する |
| A-21 | 運営の AI の中継（platform ADR-AI-RELAY・API-AI-RELAY） | 管理システムと同じアカウントに、別のスタック `YorisoiAiRelay-<env>`（別の CDK アプリ `infra/bin/relay.ts`）で置く。API Gateway は AWS WAF を付けられる REST API にする（HTTP API には付けられない）。Lambda（`api/src/relay/`）が Bedrock のモデルを、日本の中で処理する形（東京リージョンのモデルか jp 推論プロファイル）で、ロールで呼ぶ（Converse API）。呼べるモデルは設定の一覧（DeepSeek V3.2 と Claude Haiku 4.5）に限り、どれを使うかと 1 日の上限・月の予算は Parameter Store に置く（配備し直さずに切り替える）。月の費用は中継がトークン数から足し上げ、予算に達したらその場で止める（AWS Budgets は反映が遅いため使わない）。手順は [運営の AI の手順](../operations/ai-relay.md) |
| A-22 | 運営のスポットのタイル（platform ADR-SPOT-TILES・API-SPOT-TILES） | 管理システムと同じアカウントに、別のスタック `YorisoiSpotTiles-<env>`（別の CDK アプリ `infra/bin/tiles.ts`）で置く。S3 のバケットを CloudFront（OAC、アクセスログなし）で配り、範囲外のタイルが 404 になるようバケットの一覧も許す。毎週、EventBridge Scheduler が ECS Fargate のタスク（`tiles/`。osmium-tool・pyosmium）を動かし、Geofabrik の日本の抽出からタイルを作って、中身が変わったものだけ上げる。前回より 1 割を超えて減ったら上げずに止め、運営に知らせる。VPC は公開サブネットだけで NAT は置かない。手順は [スポットのタイルの手順](../operations/spot-tiles.md) |

```mermaid
flowchart LR
    subgraph U["利用者"]
        PUBU["チャンネル提供者"]
        OPU["運営"]
    end
    subgraph AWS["AWS（ap-northeast-1、本番アカウント）"]
        WEB["CloudFront + S3<br/>SPA"]
        COG["Cognito"]
        API["API Gateway<br/>HTTP API"]
        L["Lambda（API）"]
        DB[("DynamoDB")]
        IN[("S3 受付用")]
        V["Lambda（機械審査）<br/>core-format"]
        PUBL["Lambda（公開）"]
        SCH["EventBridge<br/>Scheduler（毎日）"]
        KMS["KMS<br/>署名鍵 Ed25519"]
        OUT[("S3 公開用")]
        CDN["CloudFront<br/>独自ドメイン"]
    end
    ROOT["ルート鍵<br/>（オフライン）"]
    AI["AI の API"]
    APP["SanpoGuide アプリ"]

    PUBU --> WEB
    OPU --> WEB
    WEB --> COG
    WEB -- "JWT" --> API --> L --> DB
    PUBU -- "署名付き URL" --> IN --> V --> DB
    L --> PUBL
    SCH --> PUBL
    PUBL --> KMS
    PUBL --> OUT --> CDN
    ROOT -. "鍵セット（入れ替え時）" .-> OPU
    OPU -. "運営の API キー" .-> AI
    CDN -- "HTTPS（静的ファイル）" --> APP
```

## 判断テーマ

1. 承認済みチャンネル・リストを、管理システムの API から出すか、静的ファイルとして出すか
2. 署名鍵をどこに置き、KMS の制限にどう合わせるか
3. 機械審査を、アプリと同じコード（Kotlin）で行うか、TypeScript で書き直すか
4. ログインとチャンネル提供者の身元をどう結びつけるか

## 検討した代替案と比較軸

比較軸: アプリへの影響（platform API-CHANNEL-LIST の変更の大きさ）、鍵の安全性、審査とアプリの判定の一致、運用の手間、費用

| 案 | 比較軸 | 評価 |
|---|---|---|
| 公開 1. API Gateway と Lambda でリストを返す | 管理システムが止まるとアプリが取得できない（P-7 に反する）。呼ばれるたびに費用がかかる | 不採用 |
| 公開 2. S3 と CloudFront で静的ファイルとして出す | P-7 のとおり。費用はほぼ配信量だけ | **採用（A-7）** |
| 署名 A. KMS の Ed25519ph で本体に署名 | 文書の形は変わらない。ただしアプリが使う Tink は Ed25519ph に対応せず、BouncyCastle を足す必要がある | 不採用（D-1） |
| 署名 B'. 要約に通常の Ed25519 で署名 | 鍵は KMS から出ない。アプリは Tink だけでよい。platform API-CHANNEL-LIST の文書の形に要約が 1 つ増える | **採用（D-1）** |
| 署名 C. 秘密鍵を KMS で暗号化して保管し、Lambda で署名 | 契約は変わらない。秘密鍵が Lambda のメモリに出る（platform API-CHANNEL-LIST L-3 の趣旨に反する） | 不採用 |
| 審査 1. 機械審査を TypeScript で書き直す | Lambda の言語が揃う。アプリと判定がずれるおそれがあり、形式の変更のたびに 2 か所を直す | 不採用 |
| 審査 2. `core-format`（Kotlin）を Java の Lambda で使う | アプリと同じコード。Lambda の言語が 2 つになり、起動が遅い（審査は非同期なので問題にならない） | **採用（A-11）** |
| ログイン 1. チャンネル提供者の鍵だけで入る（署名でログイン） | パスワードが要らない。鍵をなくすとログインもできず、移し替え（D-3）の本人確認ができない | 不採用 |
| ログイン 2. Cognito ＋ 鍵の紐づけ | 鍵をなくしてもログインできる。運営に MFA を強制できる | **採用（D-2・A-4・A-5）** |
| データ: DynamoDB / RDS | 開発者の条件で DynamoDB。件数が少なく、取り出し方が決まっているので足りる | DynamoDB（条件） |

## 採用案と採否理由

上の採用案を組み合わせる。

- アプリから見えるのは、CloudFront の上の静的ファイルだけになる。管理システムの API・画面・データベースが止まっても、アプリはリストの期限まで動く（platform API-CHANNEL-LIST P-7）
- リストに署名する秘密鍵は KMS から出ない。乗っ取られても、ルート鍵で署名鍵を失効させれば立て直せる（platform API-CHANNEL-LIST P-1）。要約への署名で KMS の制限を避け、アプリには新しいライブラリが要らない
- 機械審査はアプリと同じコードなので、「審査に通ったのにアプリが拒む」ことが起きにくい
- 鍵をなくしたチャンネル提供者も、Cognito のアカウントで本人確認の入口に立てる

却下した案の理由は、上の比較表のとおり。

## 影響範囲・追従タスク

| 観点 | 影響 |
|---|---|
| 実装 | 本リポジトリ。アプリは platform API-CHANNEL-LIST（要約への署名、`publisherChange`）を実装する。`core-format` とプロンプト・パックを GitHub Packages から使う |
| 運用 | 運営の仕事: ルート鍵の保管、署名鍵の半年ごとの入れ替え、審査、取り下げ、鍵の移し替えの本人確認、AWS の費用と通知の確認 |
| テスト | `conformance/` の準拠テスト（platform API-CHANNEL-LIST V-01〜V-09・V-15・V-16）を、開発用と本番用のリストに対して CI で流す。公開の Lambda は、`seq` の単調増加、同時実行、要約と本体の一致をテストする |
| 移行 | 新しいシステムなので、既存のデータの移行はない |
| 保守 | platform API-CHANNEL-LIST・platform API-CHANNEL-PACKAGE の版が上がったら、`core-format` の版を上げ、準拠テストを直す |
| セキュリティ | 運営のアカウントの乗っ取りが最大のリスク（偽の承認ができる）。MFA の必須化、操作の記録、承認の通知で備える |
| 費用 | 利用者が少ないうちは、ほぼ無料枠の範囲。SES は 1,000 通あたり約 0.1 USD。KMS の鍵は 1 つあたり月 1 USD で、入れ替えの重なりの間は 2 つ。WAF は Web ACL とルールで月数 USD かかる |

| ID | 追従タスク | 担当 | 時期 |
|---|---|---|---|
| T-1 | ルート鍵と署名鍵の手順書（作成・保管・入れ替え・失効。platform ADR-CHANNEL-CURATION T-1） | 開発者 | 済み（[鍵の手順書](../operations/keys.md)） |
| T-2 | 独自ドメインを決める（SES の送信元にも使う） | 開発者 | 本番の配備の前 |
| T-3 | SES のサンドボックスの解除を申請する（本番のアカウント） | 開発者 | 本番の配備の前 |

見直しの条件:
- 運営が複数になったとき（承認を 2 人にする、権限を分ける）
- 申請が増えて、審査の見本を作る AI の費用や手間が問題になったとき（サーバー側で作る、など）
- AWS KMS の制限が変わったとき、または platform API-CHANNEL-LIST の署名の形が変わったとき
- チャンネル提供者から、画面ではなく API（CI からの申請など）を求められたとき
- 登録や申請の悪用で、審査待ちや費用（WAF・Cognito）が問題になったとき（招待制や審査付きの登録に切り替える）

## 制約

- KMS の Ed25519 で一度に署名できるのは 4,096 バイトまで。要約の大きさはこれを超えないこと（platform API-CHANNEL-LIST V-15）
- CloudFront の証明書は us-east-1 の ACM に置く必要がある
- ブラウザから AI を直接呼べるかは、AI のサービスごとに違う（CORS の対応）。対応しないサービスは見本の作成に使えない
- 公開用のバケットに置いた試用のパッケージは、URL を知っていれば誰でも取得できる（名前はパッケージの SHA-256 なので推測しにくいが、秘密ではない）

## 未決事項・リスク

| No. | 内容 | 決める時期 |
|---|---|---|
| 1 | 独自ドメイン（T-2） | 本番の配備の前 |
| 2 | チャンネル提供者向けの API（CI からの申請など）を用意するか | 要望が出たとき |
| 4 | 見本の作成に使う AI のサービスのうち、ブラウザから呼べるもの（審査基準 2.7 は 2 つ以上で試すことを求める） | 審査の運用を始めるとき |
| 5 | 鍵の移し替えの本人確認で、何を「鍵とは別の経路」とするか（登録済みの連絡先、チャンネル提供者のウェブサイトなど） | 第三者のチャンネルの公開の前 |

## 関連ドキュメント・参照リンク

- [platform ADR-CHANNEL-CURATION](https://github.com/duwenji/yorisoi-platform/blob/main/docs/decisions/ADR-CHANNEL-CURATION.md): 第三者のチャンネルは運営の審査と署名を経たものだけ取り込む
- [platform API-CHANNEL-LIST](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-LIST.md): 承認済みチャンネル・リスト
- [platform API-CHANNEL-PACKAGE](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-PACKAGE.md): チャンネル・パッケージの形式
- [platform チャンネル審査方針](https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/channel-review.md): 審査基準
- [AWS KMS Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html): 署名できる大きさ（4,096 バイト）と Ed25519
