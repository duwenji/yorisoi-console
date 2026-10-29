# スポットのタイルの手順

運営のスポットのタイル（platform [ADR-SPOT-TILES](https://github.com/duwenji/yorisoi-platform/blob/main/docs/decisions/ADR-SPOT-TILES.md)・[API-SPOT-TILES](https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-SPOT-TILES.md)）を配備し、作り直し、止まったときに直す手順。タイルは管理システムとも運営の AI とも別のスタック（`YorisoiSpotTiles-<env>`）で、別の CDK アプリ（`infra/bin/tiles.ts`）から配備する。

## 構成

| 部品 | 内容 |
|---|---|
| S3 | `v1/base/<geohash>.json`・`v1/shops/<geohash>.json`（gzip）、`LICENSE.txt`、前回のタイルの中身のハッシュ `_state/manifest.json`。公開しない |
| CloudFront | バケットを OAC で配る。アクセスログは取らない（S-12）。範囲外のタイルは 404（バケットの一覧を許している）。根は `LICENSE.txt` |
| ECS Fargate のタスク（`tiles/`） | Geofabrik の日本の抽出を取り、`osmium tags-filter` で絞り、`make_tiles.py` でタイルにし、`publish.py` で中身が変わったタイルだけ上げる。4 vCPU・16GB・ディスク 40GB |
| EventBridge Scheduler | 毎週水曜 3:00（日本時間）にタスクを動かす |
| EventBridge のルール → SNS（メール） | タスクがエラーで止まったとき。タイルが前回より 1 割を超えて減ったときも、上げずに止まる（終了コード 2） |

設定は `infra/lib/tiles-config.ts` にある。VPC は公開サブネットだけで、NAT ゲートウェイは置かない（タスクに公開 IP を付ける）。

## 配備

イメージを組み立てるので、Docker が動いている必要がある。

```sh
aws sso login --profile sanpo-dev
export AWS_PROFILE=sanpo-dev
cd infra
npx cdk -a "npx tsx bin/tiles.ts" diff   -c env=dev
npx cdk -a "npx tsx bin/tiles.ts" deploy -c env=dev
```

| 環境 | 配信の基点 |
|---|---|
| 開発用 | 未配備 |
| 本番 | 未配備 |

初めて配備すると、警報の宛先に SNS の確認メールが届く。リンクを開くまで警報は届かない。配備しただけではタイルはないので、次の「いま作る」で 1 回動かす。

## いま作る

次の水曜を待たずに作るときは、スタックの出力の値でタスクを動かす。

```sh
out() { aws cloudformation describe-stacks --stack-name YorisoiSpotTiles-dev --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
aws ecs run-task --launch-type FARGATE \
  --cluster "$(out ClusterName)" --task-definition "$(out TaskDefinition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$(out Subnets)],securityGroups=[$(out SecurityGroup)],assignPublicIp=ENABLED}"
```

進み具合はロググループ（`BatchLogs`）で見る。`download` → `filter` → `make` → `publish` の順に出て、最後に `{"event":"published", "uploaded":…, "tiles":…}` が出れば終わり。

確かめる:

```sh
curl -sI "$(out TilesUrl)v1/base/xn76u.json"   # 200、ETag あり、Content-Encoding: gzip
curl -sI "$(out TilesUrl)v1/base/zzzzz.json"   # 404（範囲外）
curl -s  "$(out TilesUrl)"                     # LICENSE.txt
```

## 減ったと言って止まったとき

`{"event":"not_published","reason":"elements dropped from … to …"}` で止まったときは、前の週のタイルがそのまま配られている。Geofabrik の抽出が壊れていた、OSM で大きな削除があった、などを確かめる。

- 抽出がおかしかった: 次の週を待つか、翌日に「いま作る」で動かし直す
- 減ったのが正しい（大量の誤ったデータが消されたなど）: `PUBLISH_ARGS=--force` を渡して動かす

```sh
aws ecs run-task ...（上と同じ） \
  --overrides '{"containerOverrides":[{"name":"make","environment":[{"name":"PUBLISH_ARGS","value":"--force"}]}]}'
```

## 抜き出しの条件を変えるとき

条件は API-SPOT-TILES「抜き出しの条件」が正本で、kit-geo の `OverpassClient.query` と同じに保つ。変えるときは、契約・`OverpassClient`・`tiles/build.sh`（`osmium tags-filter` の式）・`tiles/make_tiles.py`（`classify`）を一緒に変え、`tiles/test` を足す。

## テスト

```sh
cd tiles
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt pytest jsonschema
PYTHONPATH=. .venv/Scripts/python -m pytest -q test
```

`test_tiles_match_the_schema` は、隣に yorisoi-platform があれば（または `SPOT_TILE_SCHEMA` で）契約の JSON Schema で確かめる。
