"""make_tiles.py against a hand-made extract (platform API-SPOT-TILES)."""

import json
import os
from pathlib import Path

import pytest

import make_tiles

HERE = Path(__file__).parent
# A small square around the fixture: tiles xn70z and its neighbours.
POLY = "test\n1\n 139.54 35.31\n 139.57 35.31\n 139.57 35.335\n 139.54 35.335\n 139.54 35.31\nEND\nEND\n"


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    out = tmp_path_factory.mktemp("tiles")
    poly = out / "area.poly"
    poly.write_text(POLY, encoding="utf-8")
    manifest = make_tiles.make(HERE / "fixture.osm", poly, out / "site", "2026-10-28T00:00:00Z")
    return out / "site", manifest


def tile(site: Path, layer: str, h: str) -> dict:
    return json.loads((site / "v1" / layer / f"{h}.json").read_text(encoding="utf-8"))


def by_id(items: list[dict]) -> dict[str, dict]:
    return {e["id"]: e for e in items}


def test_geohash():
    assert make_tiles.encode(35.6812, 139.7671) == "xn76u"
    assert make_tiles.encode(35.3262, 139.5566) == "xn70z"
    assert make_tiles.encode(35.8327, 140.1456) == "xn7ev"


def test_every_tile_the_area_reaches_is_written_even_empty(made):
    site, manifest = made
    hashes = {k.split("/")[1] for k in manifest["tiles"]}
    assert "xn70z" in hashes
    assert len(hashes) == len(make_tiles.covering(make_tiles.read_poly(site.parent / "area.poly")))
    for h in hashes:
        assert (site / "v1" / "base" / f"{h}.json").is_file()
        assert (site / "v1" / "shops" / f"{h}.json").is_file()


def test_spots_with_their_names_tags_and_outlines(made):
    site, _ = made
    base = tile(site, "base", "xn70z")
    assert base["format"] == "yorisoi-spot-tile" and base["version"] == 1 and base["layer"] == "base"
    assert base["license"] == "ODbL-1.0" and base["osmTimestamp"] == "2026-10-28T00:00:00Z"
    spots = by_id(base["spots"])
    assert set(spots) == {"node/1", "way/200", "way/201", "relation/300"}
    assert spots["node/1"]["tags"]["name:ja"] == "神社"
    assert "shape" not in spots["node/1"]

    park = spots["way/200"]
    assert park["shape"]["area"] is True
    # The centre of its box, rounded; the point 0.1m off the edge is cut.
    assert (park["lat"], park["lon"]) == (35.319, 139.5505)
    assert len(park["shape"]["lines"][0]) == 10
    assert spots["way/201"]["shape"]["area"] is False

    pond = spots["relation/300"]
    assert pond["shape"]["area"] is True
    assert pond["shape"]["lines"] == [[35.33, 139.56, 35.33, 139.562, 35.329, 139.562, 35.33, 139.56]]


def test_amenities_as_the_apps_search_them(made):
    site, _ = made
    facilities = by_id(tile(site, "base", "xn70z")["facilities"])
    assert {k: f["kind"] for k, f in facilities.items()} == {
        "node/3": "TOILETS", "node/5": "SHELTER", "node/7": "BENCH", "node/10": "CONVENIENCE_STORE",
    }
    assert facilities["node/5"]["publicTransport"] is True
    assert "name" not in facilities["node/3"]
    assert facilities["node/10"]["name"] == "Konbini"


def test_shops_without_chains_in_their_own_layer(made):
    site, _ = made
    shops = tile(site, "shops", "xn70z")
    assert set(shops) >= {"shops"} and "spots" not in shops
    assert [s["id"] for s in shops["shops"]] == ["node/8"]


def test_traffic_signals(made):
    site, _ = made
    assert tile(site, "base", "xn70z")["signals"] == [35.31655, 139.55012]


def test_the_hash_leaves_the_times_out(made, tmp_path):
    site, manifest = made
    poly = tmp_path / "area.poly"
    poly.write_text(POLY, encoding="utf-8")
    again = make_tiles.make(HERE / "fixture.osm", poly, tmp_path / "site", "2026-11-04T00:00:00Z")
    assert again["tiles"] == manifest["tiles"]
    assert manifest["counts"] == {"spots": 4, "facilities": 4, "shops": 1, "signals": 1}


def test_tiles_match_the_schema(made):
    """The JSON Schema of API-SPOT-TILES, from yorisoi-platform (SPOT_TILE_SCHEMA, or the folder beside this one)."""
    jsonschema = pytest.importorskip("jsonschema")
    path = Path(os.environ.get("SPOT_TILE_SCHEMA", HERE.parents[2] / "yorisoi-platform" / "docs" / "api" / "spot-tile.schema.json"))
    if not path.is_file():
        pytest.skip(f"no schema at {path}")
    validator = jsonschema.Draft202012Validator(json.loads(path.read_text(encoding="utf-8")))
    site, _ = made
    for f in (site / "v1").rglob("*.json"):
        errors = [e.message for e in validator.iter_errors(json.loads(f.read_text(encoding="utf-8")))]
        assert errors == [], f
