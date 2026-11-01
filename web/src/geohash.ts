// Geohash cells for choosing where a placement goes (platform API-LOCAL-MATERIALS: geohash6, about
// 1.2 km × 0.6 km), and the Web Mercator arithmetic to draw them over map tiles.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Cells of a given length: their size in degrees, and how many there are along each axis. */
function grid(length: number) {
  const bits = length * 5;
  const lngBits = Math.ceil(bits / 2);
  const latBits = Math.floor(bits / 2);
  return { lngBits, latBits, dLng: 360 / 2 ** lngBits, dLat: 180 / 2 ** latBits };
}

/** The cell at column [x] (from 180°W) and row [y] (from 90°S): bits interleaved, longitude first. */
function fromIndex(x: number, y: number, length: number): string {
  const { lngBits, latBits } = grid(length);
  let hash = '';
  let value = 0;
  let count = 0;
  let lng = lngBits - 1;
  let lat = latBits - 1;
  for (let i = 0; i < length * 5; i++) {
    const bit = i % 2 === 0 ? (x >> lng--) & 1 : (y >> lat--) & 1;
    value = (value << 1) | bit;
    if (++count === 5) {
      hash += BASE32[value];
      value = 0;
      count = 0;
    }
  }
  return hash;
}

export function encode(lat: number, lng: number, length = 6): string {
  const { dLng, dLat } = grid(length);
  return fromIndex(Math.floor((lng + 180) / dLng), Math.floor((lat + 90) / dLat), length);
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function bounds(hash: string): Bounds {
  let south = -90, north = 90, west = -180, east = 180;
  let even = true;
  for (const ch of hash) {
    const value = BASE32.indexOf(ch);
    if (value < 0) throw new Error(`not a geohash: ${hash}`);
    for (let bit = 4; bit >= 0; bit--) {
      const on = (value >> bit) & 1;
      if (even) {
        const mid = (west + east) / 2;
        if (on) west = mid; else east = mid;
      } else {
        const mid = (south + north) / 2;
        if (on) south = mid; else north = mid;
      }
      even = !even;
    }
  }
  return { south, west, north, east };
}

/** Every cell of [length] that overlaps the box. */
export function cellsIn(box: Bounds, length = 6): string[] {
  const { dLng, dLat } = grid(length);
  const x0 = Math.floor((box.west + 180) / dLng);
  const x1 = Math.floor((box.east + 180) / dLng);
  const y0 = Math.floor((box.south + 90) / dLat);
  const y1 = Math.floor((box.north + 90) / dLat);
  const out: string[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(fromIndex(x, y, length));
  return out;
}

/** World pixel coordinates in Web Mercator at [zoom], 256-pixel tiles. */
export function toPixel(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

export function fromPixel(x: number, y: number, zoom: number): { lat: number; lng: number } {
  const size = 256 * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng: (x / size) * 360 - 180 };
}
