"""make_songs.py and publish_songs.py without lilypond, ffmpeg or the bucket (platform API-SONGS)."""

import json
from pathlib import Path

import pytest
import yaml

import make_songs
import publish_songs

HERE = Path(__file__).parent.parent


def song(**over):
    s = {
        "id": "momiji", "title": "紅葉", "seasons": ["autumn"], "timesOfDay": [], "weather": [],
        "rights": {
            "lyricist": {"name": "高野辰之", "died": 1947}, "composer": {"name": "岡野貞一", "died": 1941},
            "score": "尋常小学唱歌 第二学年用（1911）", "checkedAt": "2026-11-10", "checkedBy": "duwenji",
        },
    }
    s.update(over)
    return s


def test_a_checked_public_domain_song_passes():
    assert make_songs.check_song(song(), draft=False) == []


def test_a_maker_who_died_after_1967_is_refused():
    s = song()
    s["rights"]["lyricist"] = {"name": "中村雨紅", "died": 1972}
    assert any("not in the public domain" in e for e in make_songs.check_song(s, draft=True))


def test_an_unknown_maker_must_say_so():
    s = song()
    s["rights"]["composer"] = {"name": "岡野貞一", "died": None}
    assert any("no year of death" in e for e in make_songs.check_song(s, draft=True))
    s["rights"]["composer"] = {"name": "不詳（文部省唱歌）", "died": None}
    assert make_songs.check_song(s, draft=True) == []


def test_unchecked_songs_are_made_only_as_a_draft():
    s = song()
    s["rights"]["checkedAt"] = None
    assert make_songs.check_song(s, draft=True) == []
    assert any("not checked" in e for e in make_songs.check_song(s, draft=False))


def test_values_outside_the_lists_are_refused():
    assert make_songs.check_song(song(seasons=["monsoon"]), draft=True)
    assert make_songs.check_song(song(seasons=[]), draft=True)
    assert make_songs.check_song(song(weather=["fog"]), draft=True)
    assert make_songs.check_song(song(id="Momiji!"), draft=True)


def test_every_song_in_the_catalog_has_a_melody_and_follows_the_rules():
    catalog = yaml.safe_load((HERE / "catalog.yaml").read_text(encoding="utf-8"))
    for s in catalog["songs"]:
        assert (HERE / "scores" / f"{s['id']}.ly").exists(), s["id"]
        assert make_songs.check_song(s, draft=True) == [], s["id"]
        make_songs.notes_from(HERE / "scores" / f"{s['id']}.ly", s["rights"])
    seasons = [x for s in catalog["songs"] for x in s["seasons"]]
    for season in ("spring", "summer", "autumn", "winter"):
        assert seasons.count(season) >= 3, season


def test_the_notes_of_a_wikipedia_melody_are_credited_to_its_revision():
    credit = make_songs.notes_from(HERE / "scores" / "momiji.ly", {})
    assert credit["license"] == "CC BY-SA 4.0" and "oldid=" in credit["url"]


@pytest.mark.parametrize("one_pass", [10.0, 14.0, 25.0, 29.4, 31.0, 45.0, 59.0, 75.0, 95.0])
def test_every_song_lasts_30_to_60_seconds(one_pass):
    times, speed = make_songs.plan(one_pass)
    assert 30 <= make_songs.length(one_pass, times, speed) <= 60
    assert speed >= 1.0


def test_a_draft_or_a_sound_not_as_the_catalog_says_is_not_published(tmp_path):
    (tmp_path / "audio").mkdir()
    body = b"sound"
    (tmp_path / "audio" / "momiji-1.m4a").write_bytes(body)
    import hashlib
    entry = {"id": "momiji", "file": "momiji-1.m4a", "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(), "rights": song()["rights"]}
    catalog = {"format": "yorisoi-songs", "version": 1, "songs": [entry]}
    (tmp_path / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")
    assert publish_songs.check(tmp_path)["songs"][0]["id"] == "momiji"

    (tmp_path / "catalog.json").write_text(json.dumps({**catalog, "draft": True}), encoding="utf-8")
    with pytest.raises(publish_songs.Refused):
        publish_songs.check(tmp_path)
    (tmp_path / "catalog.json").write_text(json.dumps({**catalog, "songs": [{**entry, "bytes": 3}]}), encoding="utf-8")
    with pytest.raises(publish_songs.Refused):
        publish_songs.check(tmp_path)


def test_only_new_sounds_go_up_and_only_unnamed_ones_go():
    catalog = {"songs": [{"file": "a-1.m4a"}, {"file": "b-2.m4a"}]}
    assert publish_songs.changes(catalog, {"a-1.m4a", "old-9.m4a"}) == (["b-2.m4a"], ["old-9.m4a"])
