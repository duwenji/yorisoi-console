"""Makes the operator's spot tiles (platform API-SPOT-TILES) from an OpenStreetMap extract.

    python make_tiles.py <filtered.osm.pbf> <area.poly> <out dir> [--timestamp <ISO 8601>]

The extract is the one `build.sh` cuts out with `osmium tags-filter` (the members of relations
kept). Writes `v1/base/<geohash>.json` and `v1/shops/<geohash>.json` for every geohash of 5
characters that the area's polygon reaches, even empty ones (API-SPOT-TILES ST-3), and
`manifest.json`: each tile's content hash (without its times) and the counts, for `publish.py`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import osmium
import shapely
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.prepared import prep

PRECISION = 5
BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"
# A geohash of 5 characters is 13 bits of longitude and 12 of latitude.
CELL_LON = 360 / 2**13
CELL_LAT = 180 / 2**12
M_PER_DEG = 111_320.0
SIMPLIFY_M = 5.0

FORMAT = "yorisoi-spot-tile"
VERSION = 1
LICENSE = "ODbL-1.0"
ATTRIBUTION = "© OpenStreetMap contributors"

# ---- what goes in a tile (API-SPOT-TILES「抜き出しの条件」; kit-geo OverpassClient.query) ----

SPOT_TOURISM = {"attraction", "museum", "viewpoint", "artwork", "gallery"}
SPOT_LEISURE = {"park", "garden"}
SPOT_NATURAL = {"tree", "peak", "spring", "water", "beach"}
VENDING_EXCLUDED = re.compile("ticket|parking|cigarette|excrement|condom|newspaper|fuel|photo")
SHOP_VALUES = {
    "sweets": {"confectionery", "pastry", "bakery", "chocolate"},
    "food_shop": {"deli", "tea", "coffee", "alcohol", "wine", "seafood", "butcher", "greengrocer", "cheese", "spices", "tofu", "rice"},
    "crafts": {"craft", "gift", "antiques", "art"},
    "shop": {
        "books", "second_hand", "stationery", "fabric", "clothes", "shoes", "bag", "jewelry", "leather",
        "musical_instrument", "music", "toys", "florist", "kitchen", "interior_decoration",
    },
}


def _open(t: dict) -> bool:
    return t.get("access") not in ("private", "no")


# Each kind as kit-geo FacilityKind tells it (`matches`), and whether it is one the apps search for (`filters`).
FACILITIES: list[tuple[str, object, object]] = [
    ("TOILETS", lambda t: t.get("amenity") == "toilets", _open),
    ("DRINKING_WATER", lambda t: t.get("amenity") == "drinking_water", _open),
    ("VENDING_MACHINE", lambda t: t.get("amenity") == "vending_machine", lambda t: not VENDING_EXCLUDED.search(t.get("vending", ""))),
    ("SHELTER", lambda t: t.get("amenity") == "shelter", _open),
    ("BENCH", lambda t: t.get("amenity") == "bench", lambda t: True),
    ("BICYCLE_PARKING", lambda t: t.get("amenity") == "bicycle_parking", _open),
    ("CONVENIENCE_STORE", lambda t: t.get("shop") == "convenience", lambda t: True),
    ("BICYCLE_SHOP", lambda t: t.get("shop") == "bicycle", lambda t: True),
    (
        "BICYCLE_PUMP",
        lambda t: t.get("amenity") == "compressed_air" or (t.get("amenity") == "bicycle_repair_station" and t.get("service:bicycle:pump") == "yes"),
        lambda t: t.get("amenity") != "compressed_air" or _open(t),
    ),
]


def classify(t: dict) -> tuple[str, str | None] | None:
    """('facility', kind), ('spot', None) or ('shop', kind); None when the element goes in no tile."""
    for kind, matches, searched in FACILITIES:
        if matches(t):
            # An amenity is never a spot or a shop, searched or not.
            return ("facility", kind) if searched(t) else None
    if "name" not in t:
        return None
    if (
        "historic" in t
        or t.get("tourism") in SPOT_TOURISM
        or t.get("amenity") == "place_of_worship"
        or t.get("leisure") in SPOT_LEISURE
        or t.get("natural") in SPOT_NATURAL
    ):
        return ("spot", None)
    if "brand" in t or "brand:wikidata" in t:
        return None
    amenity = t.get("amenity")
    if amenity == "restaurant":
        return ("shop", "restaurant")
    if amenity in ("cafe", "ice_cream"):
        return ("shop", "cafe")
    if amenity == "marketplace":
        return ("shop", "market")
    for kind, values in SHOP_VALUES.items():
        if t.get("shop") in values:
            return ("shop", kind)
    return None


# ---- geohash ----


def encode(lat: float, lon: float, precision: int = PRECISION) -> str:
    lat_lo, lat_hi, lon_lo, lon_hi = -90.0, 90.0, -180.0, 180.0
    out, bits, ch, even = [], 0, 0, True
    while len(out) < precision:
        if even:
            mid = (lon_lo + lon_hi) / 2
            if lon >= mid:
                ch, lon_lo = ch * 2 + 1, mid
            else:
                ch, lon_hi = ch * 2, mid
        else:
            mid = (lat_lo + lat_hi) / 2
            if lat >= mid:
                ch, lat_lo = ch * 2 + 1, mid
            else:
                ch, lat_hi = ch * 2, mid
        even = not even
        bits += 1
        if bits == 5:
            out.append(BASE32[ch])
            bits, ch = 0, 0
    return "".join(out)


def read_poly(path: Path) -> MultiPolygon:
    """An Osmosis polygon file (Geofabrik's `.poly`): rings of `lon lat`, holes marked with `!`."""
    outers, holes, ring, name = [], [], None, None
    lines = [l.strip() for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    for line in lines[1:]:
        if ring is None:
            if line == "END":
                break
            name, ring = line, []
        elif line == "END":
            (holes if name.startswith("!") else outers).append(Polygon(ring))
            ring = None
        else:
            lon, lat = map(float, line.split()[:2])
            ring.append((lon, lat))
    shape = shapely.union_all(outers)
    for h in holes:
        shape = shape.difference(h)
    return shape if isinstance(shape, MultiPolygon) else MultiPolygon([shape])


def covering(area: MultiPolygon) -> set[str]:
    """The geohashes of 5 characters whose cells the area reaches."""
    min_lon, min_lat, max_lon, max_lat = area.bounds
    inside = prep(area)
    found = set()
    i0, i1 = math.floor((min_lon + 180) / CELL_LON), math.floor((max_lon + 180) / CELL_LON)
    j0, j1 = math.floor((min_lat + 90) / CELL_LAT), math.floor((max_lat + 90) / CELL_LAT)
    for i in range(i0, i1 + 1):
        lon = -180 + i * CELL_LON
        for j in range(j0, j1 + 1):
            lat = -90 + j * CELL_LAT
            if inside.intersects(box(lon, lat, lon + CELL_LON, lat + CELL_LAT)):
                found.add(encode(lat + CELL_LAT / 2, lon + CELL_LON / 2))
    return found


# ---- shapes ----


def simplify(coords: list[tuple[float, float]]) -> list[float]:
    """A line of (lat, lon), cut to 5m (Douglas-Peucker) and rounded, as `[lat, lon, ...]`."""
    if len(coords) > 2:
        k = math.cos(math.radians(coords[0][0])) * M_PER_DEG
        line = LineString([(lon * k, lat * M_PER_DEG) for lat, lon in coords]).simplify(SIMPLIFY_M, preserve_topology=False)
        coords = [(y / M_PER_DEG, x / k) for x, y in line.coords]
    return [v for lat, lon in coords for v in (round(lat, 5), round(lon, 5))]


def center(points: list[tuple[float, float]]) -> tuple[float, float]:
    """The centre of the box around the points, as Overpass's `center`."""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return (min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2


# ---- reading ----


@dataclass
class Wanted:
    type: str
    id: int
    tags: dict
    what: tuple[str, str | None]
    lat: float = 0.0
    lon: float = 0.0
    lines: list[list[tuple[float, float]]] = field(default_factory=list)
    closed: bool = False
    member_ways: list[int] = field(default_factory=list)
    member_nodes: list[int] = field(default_factory=list)


def tags_of(o) -> dict:
    return {t.k: t.v for t in o.tags}


def read(pbf: Path) -> tuple[list[Wanted], list[tuple[float, float]]]:
    """The elements that go in tiles, with positions and outlines, and the traffic signals."""
    relations: list[Wanted] = []
    member_ways: dict[int, list[tuple[float, float]]] = {}
    member_nodes: dict[int, tuple[float, float]] = {}
    for r in osmium.FileProcessor(str(pbf), osmium.osm.RELATION):
        t = tags_of(r)
        what = classify(t)
        if what is None:
            continue
        w = Wanted("relation", r.id, t, what)
        w.member_ways = [m.ref for m in r.members if m.type == "w"]
        w.member_nodes = [m.ref for m in r.members if m.type == "n"]
        for ref in w.member_ways:
            member_ways[ref] = []
        for ref in w.member_nodes:
            member_nodes[ref] = None
        relations.append(w)

    found: list[Wanted] = []
    signals: list[tuple[float, float]] = []
    for o in osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY).with_locations():
        if o.is_node():
            if not o.location.valid():
                continue
            here = (o.location.lat, o.location.lon)
            if o.id in member_nodes:
                member_nodes[o.id] = here
            if len(o.tags) == 0:
                continue
            t = tags_of(o)
            if t.get("highway") == "traffic_signals":
                signals.append(here)
                continue
            what = classify(t)
            if what is not None:
                found.append(Wanted("node", o.id, t, what, *here))
        else:
            try:
                coords = [(n.location.lat, n.location.lon) for n in o.nodes]
            except osmium.InvalidLocationError:
                continue
            if not coords:
                continue
            if o.id in member_ways:
                member_ways[o.id] = coords
            t = tags_of(o)
            what = classify(t)
            if what is not None:
                w = Wanted("way", o.id, t, what, *center(coords))
                w.lines = [coords]
                w.closed = len(o.nodes) > 2 and o.nodes[0].ref == o.nodes[-1].ref
                found.append(w)

    for w in relations:
        w.lines = [member_ways[ref] for ref in w.member_ways if member_ways.get(ref)]
        points = [p for line in w.lines for p in line] + [member_nodes[ref] for ref in w.member_nodes if member_nodes.get(ref)]
        if not points:
            continue
        w.lat, w.lon = center(points)
        found.append(w)
    return found, signals


# ---- writing ----


def element(w: Wanted) -> dict:
    out = {"id": f"{w.type}/{w.id}", "lat": round(w.lat, 5), "lon": round(w.lon, 5)}
    kind = w.what[0]
    if kind == "facility":
        out["kind"] = w.what[1]
        name = w.tags.get("name:ja") or w.tags.get("name")
        if name:
            out["name"] = name
        if w.what[1] == "SHELTER" and w.tags.get("shelter_type") == "public_transport":
            out["publicTransport"] = True
        return out
    out["tags"] = dict(sorted(w.tags.items()))
    if kind == "spot" and w.type != "node":
        lines = [l for l in (simplify(line) for line in w.lines) if len(l) >= 4]
        if lines:
            if w.type == "way":
                area = w.closed and w.tags.get("area") != "no"
            else:
                area = w.tags.get("type") in ("multipolygon", "boundary") and w.tags.get("area") != "no"
            out["shape"] = {"area": area, "lines": lines}
    return out


def order(e: dict) -> tuple[int, int]:
    kind, _, number = e["id"].partition("/")
    return ({"node": 0, "way": 1, "relation": 2}[kind], int(number))


def make(pbf: Path, poly: Path, out: Path, timestamp: str) -> dict:
    found, signals = read(pbf)
    tiles: dict[str, dict[str, list]] = defaultdict(lambda: {"spots": [], "facilities": [], "shops": [], "signals": []})
    for w in found:
        bucket = {"facility": "facilities", "spot": "spots", "shop": "shops"}[w.what[0]]
        tiles[encode(w.lat, w.lon)][bucket].append(element(w))
    for lat, lon in sorted(signals):
        tiles[encode(lat, lon)]["signals"].append((round(lat, 5), round(lon, 5)))

    hashes = covering(read_poly(poly)) | set(tiles)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {"osmTimestamp": timestamp, "generatedAt": generated, "tiles": {}, "counts": defaultdict(int)}
    for h in sorted(hashes):
        t = tiles.get(h, {"spots": [], "facilities": [], "shops": [], "signals": []})
        layers = {
            "base": {
                "spots": sorted(t["spots"], key=order),
                "facilities": sorted(t["facilities"], key=order),
                "signals": [v for p in t["signals"] for v in p],
            },
            "shops": {"shops": sorted(t["shops"], key=order)},
        }
        for layer, body in layers.items():
            content = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
            tile = {
                "format": FORMAT, "version": VERSION, "layer": layer, "tile": h,
                "osmTimestamp": timestamp, "generatedAt": generated, "license": LICENSE, "attribution": ATTRIBUTION,
                **body,
            }
            path = out / "v1" / layer / f"{h}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(tile, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            # Unchanged tiles aren't uploaded again, so their ETag stays (ST-5): hash without the times.
            manifest["tiles"][f"{layer}/{h}"] = hashlib.sha256(f"{layer}/{h}:{content}".encode()).hexdigest()
        for key in ("spots", "facilities", "shops"):
            manifest["counts"][key] += len(t[key])
        manifest["counts"]["signals"] += len(t["signals"])
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return manifest


def main(argv: list[str]) -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("pbf", type=Path)
    p.add_argument("poly", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--timestamp", default=None, help="the time of the OpenStreetMap data (the extract's replication timestamp)")
    a = p.parse_args(argv)
    ts = a.timestamp or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    m = make(a.pbf, a.poly, a.out, ts)
    print(json.dumps({"tiles": len(m["tiles"]), **m["counts"]}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
