const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * The geohash of a position (API-CHANNEL-LIST P-15: a collection's regions are 3-letter geohashes of its
 * resources' subjects). The same encoding as core-format's `Regions.geohash`.
 */
export function geohash(lat: number, lon: number, precision = 3): string {
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new Error(`not on the earth: ${lat}, ${lon}`);
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180;
  let even = true;
  let bits = 0;
  let value = 0;
  let out = '';
  while (out.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      value <<= 1;
      if (lon >= mid) { value |= 1; lonLo = mid; } else lonHi = mid;
    } else {
      const mid = (latLo + latHi) / 2;
      value <<= 1;
      if (lat >= mid) { value |= 1; latLo = mid; } else latHi = mid;
    }
    even = !even;
    if (++bits === 5) {
      out += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return out;
}
