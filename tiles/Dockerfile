# The weekly batch of the spot tiles (platform ADR-SPOT-TILES S-6): osmium-tool cuts the extract,
# pyosmium and shapely make the tiles, boto3 puts them in the bucket.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY make_tiles.py publish.py build.sh ./
RUN chmod +x build.sh

CMD ["/app/build.sh"]
