# DES-013 その場の素材（スタジオ・一言）の置き場と配信、スタジオを出す素材提供者の承認

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-013 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | 新しいスタック `YorisoiLocalMaterials-<env>`（`infra/bin/local-materials.ts`・`infra/lib/local-materials-stack.ts`、`api/src/local/`）、中継のスタック（表の名前の公開）、管理 API（`api/src/console/`）、画面（`web`）、データモデル |
| 承認者 | 開発者 |
| ステータス | 承認済（2026-10-31） |
| 版 | 1.0 |

## 目的・背景

platform のその場の素材（区画ごとに運営から取る素材。今はスタジオと一言の 2 種類で、種類どうしに関係はない）の置き場と配信を、管理システムでどう作るかを決める。

- [platform REQ-STUDIO](https://github.com/duwenji/yorisoi-platform/blob/main/docs/requirements/REQ-STUDIO.md): 機能と受入条件。X-2 で、置き場と配信のサーバー、素材提供者の承認、スタジオの作成・申し出の確認・数の画面を管理システムに置く
- [platform ADR-MATERIALS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/decisions/ADR-MATERIALS.md): 人の発言の層、運営が提供者を承認する（S-2）、識別とブロック（S-4・S-5）、契約（S-7）、T-4（管理システムでの素材提供者の承認）
- [platform API-LOCAL-MATERIALS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-LOCAL-MATERIALS.md): アプリとの契約
- [platform 一言の利用規約](https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/notes-terms.md)・[スタジオの決まりと素材提供者の承認の基準](https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/studio-rules.md)

## スコープ・非スコープ

スコープ:
- スタジオのスタック（アプリ向けの API、置き場、音声の配信、確認）
- 一言の置く前の確認、スタジオの載せる前の確認（文字起こしと運営の AI）
- 管理 API と画面: 素材提供者の承認の申し込みと審査、スタジオの作成・止める・申し出、運営の対応（申し出・通報・一言の扱い・締め出し・置けない区画）
- 中継との結び付き（トークン・予算・モデル）

非スコープ:
- アプリの実装（platform の共通の部品と各アプリ）
- スタジオの料金（REQ-STUDIO U-9）
- 画像・映像・即時の配信（REQ-STUDIO U-10）

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| platform API-LOCAL-MATERIALS ST-1〜ST-8、エンドポイント、エラー、V-01〜V-12 | アプリとの契約 | K-1〜K-9、[アプリ向けの API](#アプリ向けの-api) |
| platform REQ-STUDIO・REQ-NOTES D-6・D-18 | スタジオと一言の確認 | K-10〜K-13 |
| platform REQ-STUDIO F-13〜F-15・F-18〜F-21・F-24、D-23 | 通報、運営の操作、スタジオを作る、素材提供者の承認、数 | K-14〜K-19 |
| platform REQ-STUDIO N-2・N-5 | 残すもの、費用 | K-6・K-12、[データモデル](#データモデル) |
| platform ADR-MATERIALS T-4 | 管理システムでの素材提供者の承認 | K-14・K-15 |
| ADR-001 A-21 | 運営の AI の中継 | K-3（中継の表と設定を読む） |

## 方針・決定事項

### 構成

| No. | 判断 | 理由 |
|---|---|---|
| K-1 | **別のスタック** `YorisoiLocalMaterials-<env>`（別の CDK アプリ `infra/bin/local-materials.ts`）に、REST API（本番は AWS WAF を付ける）、アプリ向けの Lambda（`api/src/local/`）、確認の Lambda、DynamoDB の表、音声のバケットと CloudFront を置く（ADR-001 A-23） | 中継・タイルと同じ形。管理システムや中継と止め合わない |
| K-2 | **配備の順番**: 中継 → スタジオ → 管理システム。スタジオは中継の表と設定の名前を、管理システムはスタジオの表とバケットの名前を、Parameter Store から配備のときに読む | スタック間の出力（Export）は消すときに縛られるので使わない |
| K-3 | **中継との結び付き**: スタジオの Lambda は、中継の表の `TOKEN#…` を読んでトークンを確かめ（API-LOCAL-MATERIALS ST-2）、中継の Parameter Store のモデルと月の予算を読み、運営の AI の費用を中継の表の `SPEND`（月の合計）に足す。予算に達していれば一言を置かせない（`relay_paused`）。中継の 1 日の回数は使わない（ST-7） | 予算を 1 つにまとめる（REQ-NOTES N-5）。中継の作りを変えずに済む |
| K-4 | **置いた人の値**: 中継のトークンの項目にある `install`（中継の鍵でのインストール ID の HMAC）をそのまま使う。スタジオの表と記録にはこの値だけを残す | 中継と同じ値なので、締め出しと上限が中継と同じ端末にかかる。開発用の中継は配備ごとに鍵が変わるので、開発用ではブロック・締め出しが配備で消える（受け入れる） |
| K-5 | **音声**: 素材提供者が管理システムから、署名付き URL で音声のバケットの `intake/` に送る。確認を通ったら `studios/{id}/audio.m4a` に写し、CloudFront で配る。`intake/` は 1 日、`studios/` はスタジオの期間の終わりから 2 日で消す（ライフサイクルと、終わったスタジオを毎日消す処理） | アプリは認証なしで音声を取る（API-LOCAL-MATERIALS）。未確認の音声を配らない |
| K-6 | **残すもの**: API-LOCAL-MATERIALS「サーバーが残すもの」のとおり。ログには、操作の種類・件数・時間・エラーの `code` だけを書き、一言・スタジオの本文・区画・`install`・ブロックの組を書かない | REQ-STUDIO・REQ-NOTES N-2、V-10 |

### アプリ向けの API

| No. | 判断 | 理由 |
|---|---|---|
| K-7 | **区画の一覧**: 一言と、載っているスタジオを、区画（geohash6）ごとの項目（`CELL#{geohash6}`）にも書いておき、取るときは区画ごとに 1 回の Query で読む（9 区画まで並べて読む）。期限・状態・ブロックで外し、API-LOCAL-MATERIALS の選び方で 50 件・3 MB まで絞る | 1 区画の件数は多くない。表の読みを区画の数で抑える |
| K-8 | **取りすぎの制限**: 同じ端末が同じ区画の組を 4 分以内に取り直したら `too_many_requests`。区画の組が変わったときは取らせる | API-LOCAL-MATERIALS「5 分に 1 回まで（区画を移ったとき以外）」。少し余裕を持たせる |
| K-9 | **聞いた・開いたの数**: `reactions` は、一言・スタジオごと・日ごとの合計にだけ足す。送った端末は残さない。いいねは、重複を防ぐ組（一言と端末）を一言の期限まで残す | API-LOCAL-MATERIALS ST-5、V-07 |

### 確認

| No. | 判断 | 理由 |
|---|---|---|
| K-10 | **一言の確認**: 置くときに、まず決まった形（URL・電話番号・メールアドレス）を正規表現で止め、通ったものを運営の AI に渡す。AI には利用規約 2 の項目を示し、`{"ok": true}` か `{"ok": false, "items": ["…"]}` だけを JSON で返させる。AI の呼び出しが失敗したら置かず、`502 upstream_error` を返す（API-LOCAL-MATERIALS のエラー表に互換の変更として足す）。アプリは「今は置けません」と出す | 安い確認を先にして AI の呼び出しを減らす。確かめられないものは置かない |
| K-11 | **スタジオの確認**: 管理システムでスタジオを「載せる」と、確認の Lambda が順に ① 長さ・大きさ・形式（音声は AAC の m4a、30 秒以内、512 KB 以内）② Amazon Transcribe（日本語、バッチ）で音声を文字に起こす ③ 文字と起こした文を運営の AI でスタジオの決まり 2.2 に照らす。Transcribe の終わりは EventBridge で受ける。当たらなければ載せ、当たれば項目を付けて素材提供者に返す（`returned`） | REQ-STUDIO D-18。30 秒の文字起こしは 1 分ほどで終わる |
| K-12 | **確認の費用**: 運営の AI の分は中継の `SPEND` に足す（K-3）。Transcribe の分はスタジオごとに記録し（秒数）、月の合計を CloudWatch に出す | REQ-STUDIO N-5 |
| K-13 | **AI への指示**: スタジオと一言の確認の指示は `api/src/local/check.ts` に置き、利用規約・スタジオの決まりの版と一緒に版を持つ。指示を変えたら、確認の見本（止めるもの・通すもの）でテストする | REQ-NOTES AC-2・R-2 |

### 管理システム（提供者・運営）

| No. | 判断 | 理由 |
|---|---|---|
| K-14 | **素材提供者の承認**: アカウントの下に承認の項目（`PUB#{publisherId}` / `STUDIO`）を作る。`status`（`requested`・`approved`・`declined`・`suspended`・`revoked`）、出す名前、申し込みの中身、同意したスタジオの決まりの版、運営が確かめた 4 項目、`suspendedUntil`・`reapplyAfter`、`rev` を持つ。チャンネル提供者・素材提供者のどちらの役割でも申し込める。審査待ちは GSI2 の `QUEUE#STUDIO` で並べる。止めた期間が過ぎたら承認されているものとして扱う | DM-001 M-16 のアカウントを使い、役割を増やさない。アカウントの項目は GSI2 を提供者の一覧（`PUBLISHERS`）に使っているので、別の項目にする |
| K-15 | **承認の審査**: 運営の画面で、申し込みの中身と、スタジオの決まり 1.3 の 4 項目のチェック欄を見て、承認か見送り（理由と項目番号）を決める。結果はメールで知らせる（DES-006 の通知） | スタジオの決まり 1.4 |
| K-16 | **スタジオを作る**: 承認された素材提供者だけが、文字・音声・区画（地図で選ぶ。geohash6 を 9 つまで）・期間（今から 30 日以内に始まり、1〜30 日）・時間帯を入れて「載せる」。状態は、音声があれば `uploading`（署名付きの POST で送る）→ `submit` で `checking`、なければすぐ `checking`。そこから `live` か `returned`。`returned` は直して載せ直すか、申し出る（`appealed`）。申し出を受けた運営が載せる（確認の Lambda が `live` にする）か、載せない（`rejected`）。載っているスタジオは素材提供者が止められる（`stopped`）。素材提供者の承認を止める・取り消すと `suspended`・`removed` になる。中身を変えるときは新しいスタジオとして載せ直す | REQ-STUDIO F-18〜F-20 |
| K-17 | **運営の対応**: 運営の画面に、申し出・通報されたスタジオ・通報された一言の 3 つの列を置く。スタジオは「載せる・戻す・消す・承認を期間を決めて止める・承認を取り消す」、一言は「戻す・消す・置いた端末を締め出す（期間）」を選ぶ。置けない区画（geohash5〜7）の一覧を編集できる | スタジオの決まり 4.3、REQ-STUDIO・REQ-NOTES F-14・F-15 |
| K-18 | **数の画面**: 素材提供者はスタジオごとに、日ごとの聞いた数・開いた数を、API-LOCAL-MATERIALS の概数で見る | REQ-STUDIO D-23・F-21 |
| K-19 | **利用規約の版**: 一言の利用規約の版と URL は、スタジオの Parameter Store に置き、`GET /v1/local/terms` で返す。版を上げるのは運営が Parameter Store で行う | 配備し直さずに版を上げられる |

## データモデル

スタジオの表（`YorisoiLocalMaterials-<env>` の DynamoDB。キー `PK`・`SK`、GSI1、TTL `ttl`）。管理システムの表とは別。

| 種類 | PK | SK | GSI1PK / GSI1SK | 主な項目 | 消える時期 |
|---|---|---|---|---|---|
| 一言 | `NOTE#{id}` | `NOTE` | `AUTHOR#{install}` / `{expiresAt}` | `text`・`cell`（geohash7）・`spotName`・`expiresAt`・`author`・`state`（`active`・`hidden`・`removed`）・`likes`・`reports` | 期限から 7 日（ブロックのため） |
| 区画の一言 | `CELL#{geohash6}` | `N#{id}` | — | 一覧に返す項目の写し・`author`・`state` | 期限 |
| スタジオ | `STUDIO#{id}` | `STUDIO` | `PROVIDER#{publisherId}` / `{createdAt}` | スタジオの項目・`state`（`uploading`・`checking`・`returned`・`appealed`・`live`・`stopped`・`suspended`・`removed`・`rejected`）・`audio`（置き場所・秒数・大きさ・ハッシュ）・`jobName`（Transcribe）・`check`（当たった項目・文字起こし）・`appeal`・`decision`・`reports`・`rev` | 期間の終わりから 90 日 |
| 区画のスタジオ | `CELL#{geohash6}` | `P#{id}` | — | 一覧に返す項目の写し（`live` の間だけ置く） | 期間の終わり |
| 日ごとの数 | `STATS#{id}` | `DAY#{YYYY-MM-DD}` | — | `heard`・`opened` | 一言は期限、スタジオは期間の終わりから 90 日 |
| いいね・通報の重複の守り | `SEEN#{id}` | `LIKE#{install}`・`REPORT#{install}` | — | `reason`（通報） | 一言・スタジオの期限、通報は 30 日 |
| ブロック | `BLOCKS#{install}` | `B#{blockId}` | — | `target`（置いた人の値）・`createdAt` | 1 年 |
| 1 日の一言の数 | `NOTES#{install}` | `DAY#{YYYY-MM-DD}` | — | `count` | 2 日 |
| 締め出し | `BAN#{install}` | `BAN` | — | `until` | `until`（期間なしは消さない） |
| 締め出しの一覧 | `BANS` | `{noteId}` | — | `author`・`reason`・`createdAt`・`until`。運営の画面には一言の ID だけを出し、`author` は解くときに使う | `until`（期間なしは消さない） |
| 取り直しの制限 | `FETCH#{install}` | `LAST` | — | 区画の組のハッシュ・時刻 | 10 分 |
| 置けない区画 | `AREA` | `{geohash5〜7}` | — | `reason`・`createdAt` | 消さない |
| 運営の列 | `QUEUE#{APPEAL｜REPORTED_STUDIO｜REPORTED_NOTE}` | `{id}` | — | `type`・`firstAt`・`lastAt`・`reasons`（通報の理由の集合） | 対応したら消す |

- 一言を消す・隠すときは、`NOTE#` と `CELL#` の両方を条件付きで書き換える（`TransactWrite`）
- スタジオが `live` になるとき `CELL#…`/`P#…` を区画の数だけ書き、`live` を出るときに消す
- 素材提供者の承認（K-14）は管理システムの表に置き、スタジオの項目には作ったときの `publisherId` と出す名前を写す
- 受け取り用のバケットは `uploads/`（1 日）・`held/`（確認を始めた音声、30 日）・`transcripts/`（30 日）、配信用は `studios/{id}/audio.m4a`（62 日）

## アプリ向けの API

API-LOCAL-MATERIALS のエンドポイントを、1 つの Lambda（`api/src/local/handler.ts`）で受ける。中の作りは中継（`api/src/relay/`）と同じく、ポート（`LocalPorts`: 表・時刻・乱数・設定・AI の確認・メトリクス）を受け取る関数にし、テストではポートを差し替える。

| 処理 | 表の読み書き |
|---|---|
| `GET /v1/local/cells` | トークン → `FETCH#`（制限）→ `BLOCKS#install`（Query）→ `CELL#` を区画ごとに Query → 外す・選ぶ → 返す |
| `POST /v1/local/notes` | トークン → 利用規約の版 → `BAN#` → `AREA`（キャッシュ 5 分）→ `NOTES#install` の数（条件付き加算）→ 確認（K-10）→ `NOTE#` と `CELL#` を書く。確認に当たったら加算を戻さない（試し打ちを数える） |
| `GET /v1/local/notes/mine` | GSI1 `AUTHOR#install` → `STATS#` で概数 |
| `POST /v1/local/reactions` | `STATS#` に加算、いいねは `SEEN#` に条件付きで書けたものだけ `likes` に加算 |
| `POST /v1/local/reports` | `SEEN#` に条件付きで書けたら `reports` に加算。しきい値（一言 3、スタジオ 3 か `danger`・`rights`）で `hidden`・`suspended` にし、運営の列に足す |
| `POST /v1/local/blocks` | `NOTE#` から `author` を引き（期限から 7 日まで）、`BLOCKS#install` に書く |

## 画面

| 利用者 | 画面 |
|---|---|
| 素材提供者 | 「スタジオ」タブ: 承認の申し込み（スタジオの決まりを読んで同意）、承認の状態。承認後はスタジオの一覧（状態・期間・数）、スタジオを作る（地図で区画を選ぶ、音声を選ぶ）、返されたスタジオの項目と、申し出 |
| 運営 | 「スタジオ」タブ: 承認の審査待ち、申し出、通報されたスタジオ。「一言」タブ: 通報された一言、締め出し。「置けない区画」タブ |

## 実装の順番

| 段 | 中身 | 確かめること |
|---|---|---|
| 1 | スタジオのスタック、アプリ向けの API、一言の確認。中継の表と設定の名前を Parameter Store に出す | API-LOCAL-MATERIALS V-01〜V-05・V-07〜V-12 を単体テストと開発用の配備で |
| 2 | スタジオの確認（Transcribe・AI）、素材提供者の承認とスタジオの管理 API・画面（T-4） | REQ-STUDIO AC-9・AC-10、V-06 |
| 3 | 運営の対応の画面（申し出・通報・一言・締め出し・置けない区画）、数の画面 | REQ-NOTES AC-12・AC-13、AC-8 |
| 4 | 利用ガイド・運用の手順・構成図・AWS 資源の図 | — |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 1 | 開発用の中継の鍵が配備ごとに変わり、開発用ではブロック・締め出しが配備で消える | 開発用では受け入れる。困るときは開発用も `installKey: 'secret'` にする |
| 2 | Transcribe の日本語の精度で、電話番号などの読み上げを取り逃す | 取り逃しは通報で拾う。検証で数を見る |
| 3 | 区画ごとの写し（`CELL#`）と本体がずれる | 書き換えは `TransactWrite` で一緒に行う。毎日、期限切れと `live` でない写しを消す処理を回す |
| 4 | スタジオ・中継・管理システムの配備の順番を間違えると、Parameter Store の値がなく配備が失敗する | 配備の手順に順番を書く。失敗するので気付ける |

## 関連ドキュメント・参照リンク

- [ADR-001](../adr/ADR-001-aws-architecture.md)（A-21 中継、A-23 スタジオ）
- [DM-001](../data-model.md)（アカウント `PUB#` と `roles`）
- [DES-006](DES-006-transfer-notify.md)（メールの通知）
- [platform API-LOCAL-MATERIALS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-LOCAL-MATERIALS.md)
