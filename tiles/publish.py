"""Puts the tiles `make_tiles.py` wrote into the bucket the CDN serves (platform API-SPOT-TILES).

    python publish.py <out dir>      (BUCKET, DISTRIBUTION_ID in the environment)

Only the tiles whose content changed are uploaded, so the others keep their ETag (ST-5). Tiles no
longer made are deleted. Stops without changing anything when the tiles or the elements in them
dropped by more than a tenth since last time (platform ADR-SPOT-TILES S-6): the previous week's
tiles stay. `--force` publishes anyway.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

STATE = "_state/manifest.json"
CACHE_CONTROL = "public, max-age=3600"
MAX_DROP = 0.1

LICENSE = """yorisoi spot tiles

These tiles are a database made from OpenStreetMap and are made available under the Open Database
License 1.0 (ODbL): https://opendatacommons.org/licenses/odbl/1-0/
Attribution: © OpenStreetMap contributors (https://www.openstreetmap.org/copyright)

Source: Geofabrik's extract of Japan (https://download.geofabrik.de/asia/japan.html)
OpenStreetMap data as of: {timestamp}
Format: https://github.com/duwenji/yorisoi-platform/blob/main/docs/contracts/API-SPOT-TILES.md
"""


def total(manifest: dict) -> int:
    return sum(manifest["counts"].values())


def dropped(old: dict | None, new: dict) -> str | None:
    """Why the new tiles look broken next to the old ones, if they do."""
    if not old:
        return None
    if len(new["tiles"]) < len(old["tiles"]) * (1 - MAX_DROP):
        return f"tiles dropped from {len(old['tiles'])} to {len(new['tiles'])}"
    if total(new) < total(old) * (1 - MAX_DROP):
        return f"elements dropped from {total(old)} to {total(new)}"
    return None


def changes(old: dict | None, new: dict) -> tuple[list[str], list[str]]:
    """The tiles to upload and the ones to delete."""
    before = (old or {}).get("tiles", {})
    upload = [k for k, h in new["tiles"].items() if before.get(k) != h]
    delete = [k for k in before if k not in new["tiles"]]
    return upload, delete


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("out", type=Path)
    p.add_argument("--force", action="store_true", help="publish even when the tiles dropped")
    a = p.parse_args(argv)
    bucket, distribution = os.environ["BUCKET"], os.environ["DISTRIBUTION_ID"]
    s3 = boto3.client("s3")

    new = json.loads((a.out / "manifest.json").read_text(encoding="utf-8"))
    try:
        old = json.loads(s3.get_object(Bucket=bucket, Key=STATE)["Body"].read())
    except ClientError as e:
        if e.response["Error"]["Code"] not in ("NoSuchKey", "404"):
            raise
        old = None

    why = dropped(old, new)
    if why and not a.force:
        print(json.dumps({"event": "not_published", "reason": why}), flush=True)
        return 2

    upload, delete = changes(old, new)

    def put(key: str) -> None:
        body = (a.out / "v1" / f"{key}.json").read_bytes()
        # mtime=0: the same tile gzips to the same bytes.
        s3.put_object(
            Bucket=bucket, Key=f"v1/{key}.json", Body=gzip.compress(body, mtime=0),
            ContentType="application/json", ContentEncoding="gzip", CacheControl=CACHE_CONTROL,
        )

    with ThreadPoolExecutor(32) as pool:
        list(pool.map(put, upload))
    for i in range(0, len(delete), 1000):
        s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": f"v1/{k}.json"} for k in delete[i : i + 1000]]})
    s3.put_object(
        Bucket=bucket, Key="LICENSE.txt", Body=LICENSE.format(timestamp=new["osmTimestamp"]).encode(),
        ContentType="text/plain; charset=utf-8", CacheControl=CACHE_CONTROL,
    )
    s3.put_object(Bucket=bucket, Key=STATE, Body=json.dumps(new).encode(), ContentType="application/json")
    if upload or delete:
        boto3.client("cloudfront").create_invalidation(
            DistributionId=distribution,
            InvalidationBatch={"Paths": {"Quantity": 2, "Items": ["/v1/*", "/LICENSE.txt"]}, "CallerReference": str(time.time())},
        )
    print(json.dumps({"event": "published", "uploaded": len(upload), "deleted": len(delete), "tiles": len(new["tiles"]), **new["counts"]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
