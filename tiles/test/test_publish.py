"""What publish.py uploads, deletes, and refuses (platform API-SPOT-TILES S-6)."""

import publish


def manifest(tiles: dict, spots: int = 100) -> dict:
    return {"osmTimestamp": "t", "tiles": tiles, "counts": {"spots": spots, "facilities": 0, "shops": 0, "signals": 0}}


def test_only_changed_and_new_tiles_are_uploaded_and_gone_ones_deleted():
    old = manifest({"base/a": "1", "base/b": "2", "base/c": "3"})
    new = manifest({"base/a": "1", "base/b": "9", "base/d": "4"})
    assert publish.changes(old, new) == (["base/b", "base/d"], ["base/c"])
    assert publish.changes(None, new) == (["base/a", "base/b", "base/d"], [])


def test_a_big_drop_is_refused():
    old = manifest({f"base/{i}": "x" for i in range(100)}, spots=1000)
    assert publish.dropped(old, manifest({f"base/{i}": "x" for i in range(95)}, spots=950)) is None
    assert "tiles dropped" in publish.dropped(old, manifest({f"base/{i}": "x" for i in range(80)}, spots=1000))
    assert "elements dropped" in publish.dropped(old, manifest({f"base/{i}": "x" for i in range(100)}, spots=500))
    assert publish.dropped(None, manifest({})) is None
