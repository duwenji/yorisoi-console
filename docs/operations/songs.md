# 季節の歌の手順

運営が配る季節の歌（platform [API-SONGS](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-SONGS.md)）を作り、確かめ、配信に上げる手順。歌はスポットのタイルと同じバケットと CloudFront（`YorisoiSpotTiles-<env>`）の `songs/v1/` に置く。タイルの書き出しは `v1/` のタイルしか触らないので、歌は消されない。

## 置き場所

| ファイル | 内容 |
|---|---|
| `songs/scores/{id}.ly` | 曲のメロディ（LilyPond）。頭のコメントに、音符を取った先（Wikipedia の記事の版、またはスキャンの本とページ）を書く |
| `songs/catalog.yaml` | 曲の一覧の元: 題名・季節・時間帯・天気・テンポ（楽譜のテンポを置き換えるとき）・権利（作詞者・作曲者と亡くなった年・初出の楽譜・確かめた日と人） |
| `songs/make_songs.py` | 権利を確かめ、楽譜を MIDI にし（lilypond）、数式の音色で鳴らし、M4A にする（ffmpeg） |
| `songs/publish_songs.py` | 音と一覧をバケットに上げ、一覧を CloudFront で無効化する |
| `songs/Dockerfile` | 上の 2 つを動かすイメージ（lilypond・ffmpeg・Python） |

## 曲を足す

1. メロディを `songs/scores/{id}.ly` に置く。日本語版 Wikipedia の記事に楽譜（`<score>`）があればその中身を、なければパブリックドメインの唱歌集のスキャン（広島大学図書館の教科書コレクションなど）から読み取って書く。歌詞は入れない
2. `songs/catalog.yaml` に曲を足す。`checkedAt`・`checkedBy` は空のまま
3. 下書きを作って聴く

```sh
cd songs
docker build -t yorisoi-songs .
docker run --rm -v "$PWD/out:/out" yorisoi-songs python make_songs.py /out --draft
```

4. `out/audio/` の音を、初出の唱歌集の楽譜と照らして聴く。作詞者・作曲者と亡くなった年も確かめる。1968 年以後に亡くなった人の曲は、道具が止める
5. 合っていれば `checkedAt`（日付）と `checkedBy`（確かめた人）を書き、PR にする

## 配信に上げる

確かめ済みの曲だけで作り直して上げる。`--draft` で作った一覧は上げられない。

```sh
aws sso login --profile sanpo-dev
export AWS_PROFILE=sanpo-dev
out() { aws cloudformation describe-stacks --stack-name YorisoiSpotTiles-dev --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
cd songs
docker build -t yorisoi-songs .
docker run --rm -v "$PWD/out:/out" yorisoi-songs python make_songs.py /out
docker run --rm -v "$PWD/out:/out" -v "$HOME/.aws:/root/.aws:ro" -e AWS_PROFILE \
  -e BUCKET="$(out BucketName)" -e DISTRIBUTION_ID="$(out DistributionId)" \
  yorisoi-songs python publish_songs.py /out
```

確かめる:

```sh
curl -s --compressed "$(out TilesUrl)songs/v1/catalog.json" | head -c 300
curl -sI "$(out TilesUrl)songs/v1/audio/<一覧の file>"   # 200、Content-Type: audio/mp4
```

## テスト

```sh
cd songs
docker run --rm -v "$PWD:/src" -w /src yorisoi-songs sh -c "pip install pytest && PYTHONPATH=. python -m pytest -q test"
```
