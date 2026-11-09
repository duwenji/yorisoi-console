# Makes and publishes the season's songs (platform API-SONGS): lilypond turns the melodies into
# MIDI, numpy plays them, ffmpeg encodes them, boto3 puts them beside the spot tiles.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends lilypond ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY make_songs.py publish_songs.py catalog.yaml ./
COPY scores ./scores
