# サンプル: 鎌倉の歴史散歩

[docs の文書一覧](../../README.md) ＞ サンプルデータ

## シナリオ

鶴岡八幡宮から高徳院の鎌倉大仏まで歩く、歴史散歩のシナリオです。

- **チャンネル提供者**は「鎌倉歴史さんぽ」チャンネルを作り、散策中のスポットで案内を表示します。
- **素材提供者**は「鎌倉まち歩き資料集」を作り、鶴岡八幡宮の案内とイラスト、鎌倉大仏の映像、散歩の終わりに流す音楽を提供します。
- チャンネルは素材集を別名 `kamakura` で宣言します。鶴岡八幡宮では案内テキストとイラストを出し、高徳院では大仏の映像をカードから開けるようにし、散歩の終了時には「蛍の光」を再生します。案内テキストが使えないときはアプリ標準の案内にフォールバックします。

## チャンネルの詳細

[channel.json](channel.json) は、チャンネルの基本情報、散歩中の案内方針、素材集の参照先、素材を表示するタイミングを定義します。

### 基本情報と案内方針

| 項目 | 設定 | 説明 |
|---|---|---|
| チャンネル ID | `kamakura-history-walk` | チャンネルを識別する ID |
| 名前 | 鎌倉歴史さんぽ | 利用者に表示するチャンネル名 |
| 概要 | 鶴岡八幡宮から鎌倉大仏をめぐり、歴史を感じる散歩案内 | チャンネルの内容 |
| 言語 | `ja` | 日本語のチャンネル |
| 活動・ジャンル | `walk`・`history` | 散歩向けの歴史チャンネル |
| 挨拶 | 鎌倉の歴史をたどる散歩に出かけましょう。 | チャンネル開始時の案内 |
| 会話レベル・長さ | `normal` | 会話とガイドの標準的な詳しさ |
| 会話イベント | スポット・再訪・節目・開始・終了を有効、休憩を無効 | AIガイドに会話を促すイベント |
| おすすめスポット | `shrine`・`historic`・`artwork` | チャンネルの題材に合うスポット |
| 雰囲気 | 語り口を有効、音の雰囲気は `temple` | ガイドの雰囲気の設定 |

### 素材集の参照

チャンネルは素材集 `kamakura-local-history` のバージョン 1 以上を、別名 `kamakura` で使います。各 cue の `source` はこの別名と素材 ID を `kamakura#素材ID` の形でつないで指定します。素材の内容や出典は [collection.json](collection.json) を参照してください。

### cue（発火条件と表示内容）

| cue ID | 発火条件 | 表示内容 |
|---|---|---|
| `hachimangu-visit` | 鶴岡八幡宮（OSM `way/34550401`）への到着 | `hachimangu-intro` を読み上げます。テキストが使えない場合は AI ガイド、続いて標準テキストへフォールバックし、`hachimangu-gate-illustration` をカード表示します。 |
| `daibutsu-visit` | 鎌倉大仏（OSM `node/260752586`）への到着 | `daibutsu-video-poster` をカード表示し、`kamakura-daibutsu-video` をシートから開けるようにします。 |
| `walk-finish` | 散歩終了イベント `finish` | `walk-farewell-music`（「蛍の光」）を再生します。 |

## ファイル構成

| ファイル | 内容 |
|---|---|
| [channel.json](channel.json) | チャンネルの設定。素材集の宣言と各素材の見せ方を含む |
| [collection.json](collection.json) | 素材集の設定。4 種類の素材、利用許諾、書き起こしの対応を含む |
| [resources/text/hachimangu-intro.md](resources/text/hachimangu-intro.md) | 読み上げる案内文 |
| [resources/img/hachimangu-grounds.png](resources/img/hachimangu-grounds.png) | 同梱するサンプルイラスト（image） |
| [resources/img/kamakura-daibutsu-poster.jpg](resources/img/kamakura-daibutsu-poster.jpg) | Pexels の大仏映像から作ったポスター画像 |
| [resources/text/walk-farewell-music-transcript.md](resources/text/walk-farewell-music-transcript.md) | 終了時に流す音楽の冒頭歌詞 |
| [resources/text/kamakura-daibutsu-video-transcript.md](resources/text/kamakura-daibutsu-video-transcript.md) | 映像の説明（映像に音声はありません） |

チャンネルが素材集の ID で素材を参照するため、素材集を先に登録・公開してからチャンネルを申請する流れを表しています。テキストと小さな画像は素材集 ZIP に含め、音声・映像はパッケージ外の HTTPS 素材として定義しています。

## 素材の種類と利用

| 種類 | 素材 ID | 配置・見せ方 | 補足 |
|---|---|---|---|
| text | `hachimangu-intro` | `speak` で読み上げ | 素材が使えないときは標準案内にフォールバック |
| image | `hachimangu-gate-illustration` | 鶴岡八幡宮の `card` に表示 | オリジナルのサンプルイラストをZIPに同梱 |
| image | `daibutsu-video-poster` | 大仏映像の `card` に表示 | Pexels 映像から作成したポスター画像 |
| audio | `walk-farewell-music` | 散歩の終了時に `play` | 日本語版「蛍の光」のギター弾き語り。歌詞は `walk-farewell-music-transcript` |
| video | `kamakura-daibutsu-video` | 高徳院の `sheet` から開く | 鎌倉大仏と見学者を映す Pexels 動画。説明は `kamakura-daibutsu-video-transcript` |

音楽は 60.3 秒・732,619 バイト、映像は 16.717 秒・33,974,358 バイトです。記載した SHA-256 は各URLから取得したファイルの値です。音楽は [Wikimedia Commons の「蛍の光」](https://commons.wikimedia.org/wiki/File:Hotaru_no_Hikari%28Auld_lang_syne_in_Japan%29.ogg)で、同ページでは Public domain とされています。書き起こしは冒頭部分です。映像とポスター画像は Miltan Monjib による[高徳院・鎌倉大仏の動画](https://www.pexels.com/video/tourists-at-kotoku-in-with-great-buddha-statue-34654527/)です。[Pexels License](https://www.pexels.com/license/)の条件に従ってください。実際の音声・映像の内容が散歩のシナリオに沿うよう、発音サンプルや無関係な花映像は使わず、終了時の音楽と訪問先の実映像を選んでいます。

鶴岡八幡宮のイラストはこのサンプル用に作成したもので、史実写真ではありません。散歩中の画面利用にはアプリの安全制約が適用され、映像は利用者が立ち止まってから開きます。素材を組み込んだチャンネルは、アプリ側が対応する素材の段（音声・映像）に達するまで一覧に表示されない場合があります。

## 利用時の注意

これはデータ形式と参照関係を示すためのサンプルで、署名済みのパッケージではありません。`publisher` と `producer` の値は差し替え用のプレースホルダーであり、実在のアカウント ID ではありません。署名鍵、`signature.json`、ZIP パッケージも含まれていません。

実際に申請する場合は、次の作業が必要です。

1. チャンネルと素材集の ID を管理画面で登録し、各 JSON の ID と一致させます。
2. `publisher` と `producer` を、それぞれの提供者の実際のアカウント ID に置き換えます。
3. `about.osm` と座標は鶴岡八幡宮・鎌倉大仏の OpenStreetMap 情報を使っています。題材や地点を変える場合は、その場所の実際の OSM ID と座標に更新します。
4. [素材提供者ガイド](../../manual/producer.md)と[チャンネル提供者ガイド](../../manual/publisher.md)に従ってパッケージを作成し、それぞれの提供者の鍵で署名して申請します。

テキストと小さな画像は素材集ZIPに含めます。音声・映像の公開元がファイルを差し替えると、記載済みの SHA-256・サイズ・再生時間と合わなくなることがあります。申請前にURLからファイルを再取得し、値とライセンス・出典を確認してください。サンプルの `producer`・`publisher` はプレースホルダーなので、実際の申請時は提供者のアカウント ID と署名に置き換えてください。
