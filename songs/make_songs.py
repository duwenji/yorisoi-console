"""Makes the season's songs (platform API-SONGS) from the melodies in scores/ and catalog.yaml.

    python make_songs.py <out dir> [--draft]

For each song: checks the rights (D-14), turns its LilyPond melody into MIDI (lilypond), plays the
notes with a timbre made from sums of sines (S-5), and encodes the sound as AAC in M4A (ffmpeg).
Writes `<out>/audio/{id}-{hash}.m4a` and `<out>/catalog.json`. Runs in the image of the Dockerfile
beside it, which has lilypond and ffmpeg. `--draft` makes songs not yet checked too, to listen to
them before checking; such a catalog can't be published (publish_songs.py refuses it).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
import tempfile
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import mido
import numpy as np
import yaml

HERE = Path(__file__).parent
RATE = 44_100
FORMAT = "yorisoi-songs"
VERSION = 1

ID = re.compile(r"^[a-z0-9-]{2,40}$")
SEASONS = {"spring", "summer", "autumn", "winter", "all"}
TIMES = {"morning", "day", "evening", "night"}
WEATHER = {"clear", "cloudy", "rain", "snow"}

# A work is in the public domain in Japan when everyone who made it died in 1967 or before (D-14).
LAST_YEAR_DIED = 1967
MIN_SEC, MAX_SEC = 30, 60
MAX_BYTES = 1_000_000
FADE_SEC = 0.5
TARGET_DBFS = -20.0


class Refused(Exception):
    """The catalog or a song breaks a rule; nothing is written."""


# ---- the catalog ----


def check_song(s: dict, draft: bool) -> list[str]:
    """What is wrong with one song's entry (empty when nothing)."""
    errors = []
    sid = s.get("id", "")
    if not ID.match(sid):
        errors.append(f"id {sid!r}")
    if not s.get("title"):
        errors.append(f"{sid}: no title")
    seasons = set(s.get("seasons") or [])
    if not seasons or not seasons <= SEASONS:
        errors.append(f"{sid}: seasons {sorted(seasons)}")
    if not set(s.get("timesOfDay") or []) <= TIMES:
        errors.append(f"{sid}: timesOfDay {s.get('timesOfDay')}")
    if not set(s.get("weather") or []) <= WEATHER:
        errors.append(f"{sid}: weather {s.get('weather')}")
    rights = s.get("rights") or {}
    for role in ("lyricist", "composer"):
        person = rights.get(role) or {}
        died = person.get("died")
        if not person.get("name"):
            errors.append(f"{sid}: no {role}")
        elif died is None and "不詳" not in person["name"]:
            errors.append(f"{sid}: {role} {person['name']} has no year of death")
        elif died is not None and died > LAST_YEAR_DIED:
            errors.append(f"{sid}: {role} {person['name']} died in {died}, after {LAST_YEAR_DIED}: not in the public domain")
    if not rights.get("score"):
        errors.append(f"{sid}: no first songbook (score)")
    if not draft and not (rights.get("checkedAt") and rights.get("checkedBy")):
        errors.append(f"{sid}: not checked yet (checkedAt, checkedBy)")
    return errors


def notes_from(score: Path, rights: dict) -> dict:
    """Where the notes come from: the catalog's notesFrom, else the Wikipedia article the score's head names."""
    if rights.get("notesFrom"):
        return rights["notesFrom"]
    head = [line[1:].strip() for line in score.read_text(encoding="utf-8").splitlines()[:2] if line.startswith("%")]
    if len(head) < 2 or "Wikipedia" not in head[0] or "oldid=" not in head[1]:
        raise Refused(f"{score.name}: the head doesn't name the Wikipedia article and its revision")
    return {"title": head[0].split(" - Wikipedia")[0] + " - Wikipedia", "url": head[1], "license": "CC BY-SA 4.0"}


# ---- the notes ----


@dataclass
class Note:
    pitch: int
    start: float
    length: float


TEMPO = re.compile(r"\\tempo\s*\d+\.?\s*=\s*\d+")


def midi_of(score: Path, work: Path, tempo: int | None = None) -> Path:
    """
    The score's melody as MIDI, by lilypond. The score is a music expression, as on Wikipedia.
    [tempo] (quarter notes a minute), when given, replaces the score's own: some have none, and
    lilypond then plays at 60.
    """
    body = "\n".join(line for line in score.read_text(encoding="utf-8").splitlines() if not line.startswith("%"))
    if tempo:
        body = "{ \\tempo 4 = %d %s }" % (tempo, TEMPO.sub("", body))
    src = work / f"{score.stem}.ly"
    src.write_text(f'\\version "2.24.0"\n\\score {{\n{body}\n\\midi {{ }}\n}}\n', encoding="utf-8")
    subprocess.run(["lilypond", "--loglevel=ERROR", "-o", str(work / score.stem), str(src)], check=True)
    for ext in (".midi", ".mid"):
        out = work / f"{score.stem}{ext}"
        if out.exists():
            return out
    raise Refused(f"{score.name}: lilypond made no MIDI")


def notes_of(midi: Path) -> list[Note]:
    """The notes in seconds, by the tempo changes in the file."""
    f = mido.MidiFile(str(midi))
    notes, on, t = [], {}, 0.0
    for msg in f:  # merged tracks, msg.time in seconds
        t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            on[msg.note] = t
        elif msg.type in ("note_off", "note_on") and msg.note in on:
            start = on.pop(msg.note)
            notes.append(Note(msg.note, start, t - start))
    if not notes:
        raise Refused(f"{midi.name}: no notes")
    first = min(n.start for n in notes)
    return sorted((Note(n.pitch, n.start - first, n.length) for n in notes), key=lambda n: n.start)


GAP_SEC = 0.6
TAIL_SEC = 0.5


def length(one_pass: float, times: int, speed: float = 1.0) -> float:
    """How long [times] passes last at [speed], with a breath between them and a tail after."""
    return times * one_pass / speed + (times - 1) * GAP_SEC + TAIL_SEC


def plan(one_pass: float) -> tuple[int, float]:
    """How many times to play the melody, and how much faster (>1), to last 30–60 seconds."""
    times = 1
    while length(one_pass, times) < MIN_SEC:
        times += 1
    if length(one_pass, times) <= MAX_SEC:
        return times, 1.0
    # Too long at its tempo: a little faster, to end a second before the limit.
    budget = MAX_SEC - 1 - (times - 1) * GAP_SEC - TAIL_SEC
    return times, times * one_pass / budget


# ---- the sound ----


def tone(freq: float, length: float, rate: int = RATE) -> np.ndarray:
    """One note: a soft reed, its harmonics and a slow vibrato, with a short attack and release."""
    n = max(1, int(length * rate))
    t = np.arange(n) / rate
    vib = 1 + 0.003 * np.sin(2 * math.pi * 5.0 * t) * np.clip(t / 0.3, 0, 1)
    phase = 2 * math.pi * freq * np.cumsum(vib) / rate
    wave_ = np.sin(phase) + 0.30 * np.sin(2 * phase) + 0.12 * np.sin(3 * phase) + 0.05 * np.sin(4 * phase)
    attack, release = min(0.04, length / 4), min(0.12, length / 3)
    env = np.minimum(1.0, t / attack) * np.clip((length - t) / release, 0, 1)
    env *= 0.85 + 0.15 * np.exp(-t / 0.4)  # a little more at the start of each note
    return wave_ * env


def reverb(x: np.ndarray, rate: int = RATE) -> np.ndarray:
    """A small room: a few combs in parallel, mixed under the dry sound."""
    out = np.zeros(len(x) + rate)
    padded = np.concatenate([x, np.zeros(rate)])
    for delay_ms, gain in ((29.7, 0.75), (37.1, 0.72), (41.1, 0.70), (43.7, 0.68)):
        d = int(rate * delay_ms / 1000)
        y = padded.copy()
        for i in range(d, len(y), d):
            y[i : i + d] += gain * y[i - d : i][: len(y[i : i + d])]
        out += y
    return 0.8 * padded + 0.2 * out / 4


def render(notes: list[Note], times: int, speed: float) -> np.ndarray:
    one = max(n.start + n.length for n in notes)
    x = np.zeros(int(length(one, times, speed) * RATE))
    for k in range(times):
        offset = k * (one / speed + GAP_SEC)
        for n in notes:
            s = tone(440.0 * 2 ** ((n.pitch - 69) / 12), n.length / speed)
            i = int((offset + n.start / speed) * RATE)
            x[i : i + len(s)] += s[: len(x) - i]
    y = reverb(x)[: len(x)]
    fade = int(FADE_SEC * RATE)
    y[:fade] *= np.linspace(0, 1, fade)
    y[-fade:] *= np.linspace(1, 0, fade)
    rms = math.sqrt(float(np.mean(y**2))) or 1.0
    y *= 10 ** (TARGET_DBFS / 20) / rms
    peak = float(np.max(np.abs(y))) or 1.0
    if peak > 0.89:  # -1 dBFS
        y *= 0.89 / peak
    return y


def write_wav(path: Path, y: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


def encode(wav: Path, out: Path, title: str) -> None:
    subprocess.run(
        [
            "ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-ac", "1", "-ar", str(RATE),
            "-c:a", "aac", "-b:a", "64k", "-metadata", f"title={title}",
            "-metadata", "artist=yorisoi 運営", "-metadata", "copyright=CC BY-SA 4.0", str(out),
        ],
        check=True,
    )


# ---- all of it ----


def make(catalog_path: Path, scores: Path, out: Path, draft: bool = False) -> dict:
    catalog = yaml.safe_load(catalog_path.read_text(encoding="utf-8"))
    songs = catalog.get("songs") or []
    errors = [e for s in songs for e in check_song(s, draft)]
    ids = [s.get("id") for s in songs]
    errors += [f"{i}: twice" for i in set(ids) if ids.count(i) > 1]
    errors += [f"{s['id']}: no scores/{s['id']}.ly" for s in songs if not (scores / f"{s['id']}.ly").exists()]
    if errors:
        raise Refused("\n".join(errors))

    (out / "audio").mkdir(parents=True, exist_ok=True)
    entries = []
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for s in songs:
            score = scores / f"{s['id']}.ly"
            notes = notes_of(midi_of(score, work, s.get("tempo")))
            one = max(n.start + n.length for n in notes)
            times, speed = plan(one)
            y = render(notes, times, speed)
            wav = work / f"{s['id']}.wav"
            write_wav(wav, y)
            m4a = work / f"{s['id']}.m4a"
            encode(wav, m4a, s["title"])
            body = m4a.read_bytes()
            if len(body) > MAX_BYTES:
                raise Refused(f"{s['id']}: {len(body)} bytes, over {MAX_BYTES}")
            sha = hashlib.sha256(body).hexdigest()
            name = f"{s['id']}-{sha[:8]}.m4a"
            (out / "audio" / name).write_bytes(body)
            rights = dict(s["rights"])
            rights["notesFrom"] = notes_from(score, rights)
            entries.append({
                "id": s["id"], "title": s["title"], "seasons": s["seasons"],
                "timesOfDay": s.get("timesOfDay") or [], "weather": s.get("weather") or [],
                "durationSec": round(len(y) / RATE), "file": name, "bytes": len(body), "sha256": sha,
                "rights": rights,
            })
            print(json.dumps({"song": s["id"], "sec": round(len(y) / RATE), "times": times, "speed": round(speed, 3), "bytes": len(body)}, ensure_ascii=False), flush=True)

    result = {
        "format": FORMAT, "version": VERSION,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "credit": catalog["credit"],
        "songs": entries,
    }
    if draft:
        result["draft"] = True
    (out / "catalog.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return result


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("out", type=Path)
    p.add_argument("--draft", action="store_true", help="make songs not yet checked too, to listen to")
    a = p.parse_args()
    try:
        make(HERE / "catalog.yaml", HERE / "scores", a.out, a.draft)
    except Refused as e:
        print(e, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
