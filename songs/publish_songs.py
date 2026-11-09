"""Puts the songs make_songs.py wrote beside the spot tiles (platform API-SONGS S-1).

    python publish_songs.py <out dir>      (BUCKET, DISTRIBUTION_ID in the environment)

Uploads the sounds not there yet under songs/v1/audio/ (their names have their hash, so they never
change), then catalog.json, then deletes the sounds the catalog no longer names, and invalidates the
catalog on the CDN. Refuses a draft catalog (songs not yet checked) and one that breaks the format.
Touches nothing outside songs/: the spot tiles are the weekly batch's.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import boto3

PREFIX = "songs/v1/"
AUDIO_CACHE = "public, max-age=31536000, immutable"
CATALOG_CACHE = "public, max-age=3600"


class Refused(Exception):
    pass


def check(out: Path) -> dict:
    """The catalog to publish, if it may be: not a draft, and every sound as the catalog says."""
    catalog = json.loads((out / "catalog.json").read_text(encoding="utf-8"))
    if catalog.get("draft"):
        raise Refused("a draft catalog (songs not yet checked) can't be published")
    if catalog.get("format") != "yorisoi-songs" or catalog.get("version") != 1:
        raise Refused("not a yorisoi-songs v1 catalog")
    for s in catalog["songs"]:
        body = (out / "audio" / s["file"]).read_bytes()
        if len(body) != s["bytes"] or hashlib.sha256(body).hexdigest() != s["sha256"]:
            raise Refused(f"{s['file']}: not as the catalog says")
        if not (s["rights"].get("checkedAt") and s["rights"].get("checkedBy")):
            raise Refused(f"{s['id']}: not checked")
    return catalog


def changes(catalog: dict, there: set[str]) -> tuple[list[str], list[str]]:
    """The sounds to upload and the ones to delete, by their names under songs/v1/audio/."""
    wanted = {s["file"] for s in catalog["songs"]}
    return sorted(wanted - there), sorted(there - wanted)


def publish(out: Path, bucket: str, distribution: str | None) -> None:
    catalog = check(out)
    s3 = boto3.client("s3")
    there = set()
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=PREFIX + "audio/"):
        there |= {o["Key"].removeprefix(PREFIX + "audio/") for o in page.get("Contents", [])}
    upload, delete = changes(catalog, there)
    for name in upload:
        s3.put_object(
            Bucket=bucket, Key=f"{PREFIX}audio/{name}", Body=(out / "audio" / name).read_bytes(),
            ContentType="audio/mp4", CacheControl=AUDIO_CACHE,
        )
    body = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    s3.put_object(
        Bucket=bucket, Key=f"{PREFIX}catalog.json", Body=gzip.compress(body, mtime=0),
        ContentType="application/json", ContentEncoding="gzip", CacheControl=CATALOG_CACHE,
    )
    for name in delete:
        s3.delete_object(Bucket=bucket, Key=f"{PREFIX}audio/{name}")
    if distribution:
        boto3.client("cloudfront").create_invalidation(
            DistributionId=distribution,
            InvalidationBatch={"Paths": {"Quantity": 1, "Items": [f"/{PREFIX}catalog.json"]}, "CallerReference": str(time.time())},
        )
    print(json.dumps({"event": "published", "songs": len(catalog["songs"]), "uploaded": len(upload), "deleted": len(delete)}), flush=True)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("out", type=Path)
    a = p.parse_args()
    try:
        publish(a.out, os.environ["BUCKET"], os.environ.get("DISTRIBUTION_ID"))
    except Refused as e:
        print(e, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
