import { describe, expect, it } from 'vitest';
import { bounds, cellsIn, encode, fromPixel, toPixel } from '../src/geohash';

describe('geohash', () => {
  it('encodes as the usual geohash does', () => {
    // Tokyo Station; the apps use the same cells (platform API-LOCAL-MATERIALS).
    expect(encode(35.6812, 139.7671, 6)).toBe('xn76ur');
    expect(encode(35.6812, 139.7671, 7)).toBe('xn76urx');
    expect(encode(57.64911, 10.40744, 6)).toBe('u4pruy');
  });

  it('has bounds that contain the point and match the cell size', () => {
    const b = bounds('xn76ur');
    expect(b.south).toBeLessThanOrEqual(35.6812);
    expect(b.north).toBeGreaterThan(35.6812);
    expect(b.east - b.west).toBeCloseTo(360 / 2 ** 15, 10);
    expect(b.north - b.south).toBeCloseTo(180 / 2 ** 15, 10);
    expect(encode((b.south + b.north) / 2, (b.west + b.east) / 2)).toBe('xn76ur');
  });

  it('lists the cells over a box, neighbours included', () => {
    const b = bounds('xn76ur');
    const box = { south: b.south - 0.001, north: b.north + 0.001, west: b.west - 0.001, east: b.east + 0.001 };
    const cells = cellsIn(box);
    expect(cells).toHaveLength(9);
    expect(cells).toContain('xn76ur');
    for (const c of cells) expect(c).toHaveLength(6);
  });

  it('turns positions into map pixels and back', () => {
    const p = toPixel(35.6812, 139.7671, 15);
    const back = fromPixel(p.x, p.y, 15);
    expect(back.lat).toBeCloseTo(35.6812, 6);
    expect(back.lng).toBeCloseTo(139.7671, 6);
  });
});
