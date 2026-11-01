# DES-003 チャンネル提供者の API と画面

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-003 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | チャンネル提供者の API（登録・鍵・チャンネル・申請・取り消し・退会）、チャンネル提供者の画面、受付用の S3 |
| 承認者 | 開発者 |
| ステータス | 実装済 |
| 版 | 1.0 |

## 目的・背景

チャンネル提供者が登録し、鍵を紐づけ、チャンネル ID を登録し、パッケージに署名して申請（アップロード）できるようにする（[ARCH-001](../architecture.md)）。届いたパッケージの機械審査は [DES-004](DES-004-machine-review.md)、運営の審査は [DES-005](DES-005-review.md)、鍵の移し替えとメールの通知は [DES-006](DES-006-transfer-notify.md)。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| API-001 | チャンネル提供者の操作（`/api/publisher*`、`/api/channels*`、申請、取り消し）、C-4（退会）、C-10（署名付き POST） | 実装（下表） |
| DM-001 | USER・PUB・KEY・ACCOUNT・CHALLENGE・QUOTA・CH・SUB、M-2・M-5・M-7・M-15、DV-02〜DV-04 | 実装 |
| ARCH-001 | A-5（鍵の紐づけ）、A-11（受付用の S3）、D-7（誰でも登録できる） | 実装 |
| platform API-CHANNEL-PACKAGE | F-6（チャンネル提供者の署名） | 画面の中で署名する |

## 方針・決定事項

### 決定事項

| No. | 論点 | 決定 |
|---|---|---|
| P-2 | チャンネル提供者の鍵の作成と署名 | 画面の中（ブラウザの WebCrypto の Ed25519）。秘密鍵は合言葉で暗号化したファイルとしてチャンネル提供者が保存し、サーバーに送らない |

### チャンネル提供者の API

| 操作 | パス |
|---|---|
| 登録・確認・変更・退会 | `POST`・`GET`・`PATCH`・`DELETE /api/publisher` |
| 鍵の紐づけ | `POST /api/publisher/keys/challenge`、`POST`・`GET /api/publisher/keys` |
| チャンネル | `POST`・`GET /api/channels`、`GET /api/channels/{channelId}`（自分のもの。運営はすべて） |
| 申請 | `POST`・`GET /api/channels/{channelId}/submissions`、`GET …/{submissionId}`、`POST …/withdraw` |

### 実装上の判断

| No. | 判断 | 理由 |
|---|---|---|
| J-1 | トランザクションの条件のどれが落ちたかを見て、`already_registered`・`account_id_taken`・`channel_id_taken`・`limit_reached`・`quota_exceeded`・`pending_submission_exists`・`challenge_invalid` に分ける | API-001 のエラー表どおり、チャンネル提供者に原因を示す |
| J-2 | 鍵の紐づけは、一度きりの文字列の削除・アカウントIDの予約・鍵・チャンネル提供者の更新・操作の記録を 1 つのトランザクションで行う。一度きりの文字列は 10 分 | DM-001 M-7・DV-02。使い回しを防ぐ |
| J-3 | 申請の開始は、1 日の数（日本時間）・チャンネルの審査待ち・申請・操作の記録を 1 つのトランザクションで行う | DM-001 M-2・DV-03・DV-04 |
| J-4 | アップロードが 1 時間届かない申請は、次の申請の開始のときに `expired` にしてチャンネルを空ける | 届かなかった申請でチャンネルが塞がらないように |
| J-5 | ほかのチャンネル提供者のチャンネル・申請は 404（存在を明かさない）。運営はすべて見られる | API-001「権限とデータの見え方」 |
| J-6 | 退会は、公開中のチャンネルの取り下げ（理由「チャンネル提供者が退会したため」）、審査待ちの申請の取り消し、表示名・連絡先の削除、Cognito のユーザーの削除。操作の記録、アカウントIDの予約、チャンネル ID は残す | API-001 C-4、DM-001 M-15 |
| J-7 | 受付用の S3 は非公開。署名付き POST（15 分）で、大きさ（パッケージ 2MB・アイコン 100KB）と Content-Type を S3 が強制する。CORS はすべての送り元を認める（署名付きのポリシーがなければ上げられない。送り元を画面に限ると CloudFormation の依存が一周する） | API-001 C-10 |
| J-8 | 受付用の S3 の `archive/` は 90 日、`intake/` は 30 日で消す（結果の出なかった申請の分） | DM-001 M-4 |
| J-9 | 鍵のファイルは、秘密鍵（PKCS#8）を PBKDF2（SHA-256、60 万回）+ AES-GCM で暗号化した JSON。開くときに、中の秘密鍵と公開鍵が組になっているかを確かめる。合言葉は 12 文字以上 | ファイルが流出しても使えないように。公開鍵だけ差し替えたファイルを拒む |
| J-10 | 画面での署名は、ZIP を展開し、`signature.json` 以外の全ファイルの SHA-256 に署名して `signature.json` を足し、ZIP にし直す。前の `signature.json` は捨てる。署名の前に、`channel.json` の `id`・`version`・`publisher` を確かめる | platform API-CHANNEL-PACKAGE F-6。アカウントIDの計算はサーバー・`core-format` と同じ値（テストで確認） |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 3 | 新しく登録した人は、確認のあとに `publisher` グループに入る。最初のログインのトークンにグループが入っていない場合は、ログインし直しが要る | 画面で「ログインし直してください」と案内している。開発者の確認で様子を見る |
| 4 | WebCrypto の Ed25519 は、主なブラウザの最新版でしか使えない | 使えないブラウザでは画面で知らせる |

## 関連ドキュメント・参照リンク

- [API-001](../console-api.md)、[DM-001](../data-model.md)、[DES-002](DES-002-operator-console.md)、[チャンネル提供者ガイド](../guide/publisher.md)
- [platform API-CHANNEL-PACKAGE](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-CHANNEL-PACKAGE.md)
