import { useRef, useState, type PointerEvent } from 'react';
import { bounds, cellsIn, encode, fromPixel, toPixel } from '../geohash';

// Choosing a studio's cells (DES-013 K-16, REQ-STUDIO D-17): GSI tiles with the geohash6 grid
// over them; a click takes or leaves a cell. No map library: the tiles are plain images.

const WIDTH = 720;
const HEIGHT = 440;
const TILE = 256;
const TILES = 'https://cyberjapandata.gsi.go.jp/xyz/std';
/** Tokyo Station, until a cell is chosen or a place is entered. */
const START = { lat: 35.6812, lng: 139.7671 };

export function CellMap({ value, onChange, max = 9 }: { value: string[]; onChange: (cells: string[]) => void; max?: number }) {
  const first = value[0] ? bounds(value[0]) : undefined;
  const [center, setCenter] = useState(first ? { lat: (first.south + first.north) / 2, lng: (first.west + first.east) / 2 } : START);
  const [zoom, setZoom] = useState(14);
  const [place, setPlace] = useState('');
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);

  const c = toPixel(center.lat, center.lng, zoom);
  const left = c.x - WIDTH / 2;
  const top = c.y - HEIGHT / 2;
  const tiles: { x: number; y: number }[] = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + HEIGHT) / TILE); ty++) {
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + WIDTH) / TILE); tx++) tiles.push({ x: tx, y: ty });
  }
  const nw = fromPixel(left, top, zoom);
  const se = fromPixel(left + WIDTH, top + HEIGHT, zoom);
  const cells = cellsIn({ south: se.lat, north: nw.lat, west: nw.lng, east: se.lng });

  const toggle = (cell: string) => {
    if (drag.current?.moved) return;
    if (value.includes(cell)) onChange(value.filter((v) => v !== cell));
    else if (value.length < max) onChange([...value, cell]);
  };
  const moveBy = (dx: number, dy: number) => setCenter(fromPixel(c.x + dx, c.y + dy, zoom));
  const onDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.buttons === 0) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    moveBy(-dx, -dy);
  };
  const onUp = () => {
    // Let the click that ends a drag see `moved`, then forget it.
    setTimeout(() => (drag.current = undefined), 0);
  };
  const go = () => {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(place);
    if (m) setCenter({ lat: Number(m[1]), lng: Number(m[2]) });
  };

  return (
    <div className="cell-map">
      <div className="cell-map-tools">
        <input placeholder="緯度, 経度（例 35.7275, 139.7671。地図サービスからコピー）" value={place} onChange={(e) => setPlace(e.target.value)} />
        <button type="button" onClick={go}>移動</button>
        <button type="button" onClick={() => setZoom((z) => Math.min(16, z + 1))} aria-label="拡大">＋</button>
        <button type="button" onClick={() => setZoom((z) => Math.max(13, z - 1))} aria-label="縮小">－</button>
        <span className="muted small">ドラッグで動かす。区画を押して選ぶ（{value.length}/{max}）</span>
      </div>
      <div className="cell-map-view" style={{ width: WIDTH, height: HEIGHT }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        {tiles.map((t) => (
          <img key={`${t.x}/${t.y}`} alt="" draggable={false} src={`${TILES}/${zoom}/${t.x}/${t.y}.png`} style={{ left: t.x * TILE - left, top: t.y * TILE - top }} />
        ))}
        <svg width={WIDTH} height={HEIGHT}>
          {cells.map((cell) => {
            const b = bounds(cell);
            const a = toPixel(b.north, b.west, zoom);
            const z = toPixel(b.south, b.east, zoom);
            const on = value.includes(cell);
            return (
              <rect
                key={cell}
                x={a.x - left}
                y={a.y - top}
                width={z.x - a.x}
                height={z.y - a.y}
                className={on ? 'on' : ''}
                onClick={() => toggle(cell)}
              >
                <title>{cell}</title>
              </rect>
            );
          })}
        </svg>
        <span className="cell-map-credit">地理院タイル</span>
      </div>
      <div className="small">
        選んだ区画:{' '}
        {value.length === 0 ? <span className="muted">まだありません</span> : value.map((v) => (
          <button key={v} type="button" className="link" title="外す" onClick={() => onChange(value.filter((x) => x !== v))}><code>{v}</code> ×</button>
        ))}{' '}
        <span className="muted">中心の区画: <code>{encode(center.lat, center.lng)}</code></span>
      </div>
    </div>
  );
}
