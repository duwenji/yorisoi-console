#!/bin/sh
# The weekly batch of the spot tiles (platform API-SPOT-TILES S-6), run as the Fargate task's command.
# BUCKET and DISTRIBUTION_ID come from the task's environment; PUBLISH_ARGS may be --force.
set -eu

work=${WORK_DIR:-/data}
mkdir -p "$work"
cd "$work"
ua="yorisoi-spot-tiles/1 (weekly batch; https://github.com/duwenji/yorisoi-platform)"

echo '{"event":"download"}'
curl -fsSL --retry 3 -A "$ua" -o japan.osm.pbf https://download.geofabrik.de/asia/japan-latest.osm.pbf
curl -fsSL --retry 3 -A "$ua" -o japan.poly https://download.geofabrik.de/asia/japan.poly
timestamp=$(osmium fileinfo -g header.option.osmosis_replication_timestamp japan.osm.pbf)

# What the apps search (API-SPOT-TILES「抜き出しの条件」); make_tiles.py applies the rest (names,
# access, chains). The members of relations are kept for their outlines.
echo '{"event":"filter"}'
osmium tags-filter japan.osm.pbf \
  nwr/historic \
  nwr/tourism=attraction,museum,viewpoint,artwork,gallery \
  nwr/leisure=park,garden \
  nwr/natural=tree,peak,spring,water,beach \
  nwr/amenity=place_of_worship,toilets,drinking_water,vending_machine,shelter,bench,bicycle_parking,bicycle_repair_station,compressed_air,restaurant,cafe,ice_cream,marketplace \
  nwr/shop=convenience,bicycle,confectionery,pastry,bakery,chocolate,deli,tea,coffee,alcohol,wine,seafood,butcher,greengrocer,cheese,spices,tofu,rice,craft,gift,antiques,art,books,second_hand,stationery,fabric,clothes,shoes,bag,jewelry,leather,musical_instrument,music,toys,florist,kitchen,interior_decoration \
  n/highway=traffic_signals \
  --overwrite -o filtered.osm.pbf
rm japan.osm.pbf

echo '{"event":"make"}'
rm -rf out
python /app/make_tiles.py filtered.osm.pbf japan.poly out --timestamp "$timestamp"

echo '{"event":"publish"}'
# shellcheck disable=SC2086
python /app/publish.py out ${PUBLISH_ARGS:-}
