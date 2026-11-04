import { useRef, useState, type PointerEvent } from 'react';
import { fromPixel, toPixel } from '../geohash';

// Choosing one place for a draft (DES-014): a cue's point or a resource's subject. GSI tiles as
// for the studio's cells (cell-map.tsx); a click puts the point, a drag moves the map.

const WIDTH = 640;
const HEIGHT = 360;
const TILE = 256;
const TILES = 'https://cyberjapandata.gsi.go.jp/xyz/std';
/** Tokyo Station, until a point is chosen. */
const START = { lat: 35.6812, lng: 139.7671 };

/** Metres per pixel at [lat] and [zoom] (Web Mercator). */
const metresPerPixel = (lat: number, zoom: number) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

export function PointMap({ lat, lon, radiusM, onChange }: { lat?: number | undefined; lon?: number | undefined; radiusM?: number | undefined; onChange: (lat: number, lon: number) => void }) {
  const has = Number.isFinite(lat) && Number.isFinite(lon);
  const [center, setCenter] = useState(has ? { lat: lat!, lng: lon! } : START);
  const [zoom, setZoom] = useState(has ? 17 : 14);
  const [place, setPlace] = useState('');
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const view = useRef<HTMLDivElement>(null);

  const c = toPixel(center.lat, center.lng, zoom);
  const left = c.x - WIDTH / 2;
  const top = c.y - HEIGHT / 2;
  const tiles: { x: number; y: number }[] = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + HEIGHT) / TILE); ty++) {
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + WIDTH) / TILE); tx++) tiles.push({ x: tx, y: ty });
  }
  const marker = has ? toPixel(lat!, lon!, zoom) : undefined;

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
    setCenter(fromPixel(c.x - dx, c.y - dy, zoom));
  };
  const onUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = undefined;
    if (!d || d.moved || !view.current) return;
    const box = view.current.getBoundingClientRect();
    const p = fromPixel(left + e.clientX - box.left, top + e.clientY - box.top, zoom);
    onChange(Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6);
  };
  const go = () => {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(place);
    if (m) setCenter({ lat: Number(m[1]), lng: Number(m[2]) });
  };

  return (
    <div className="cell-map">
      <div className="cell-map-tools">
        <input placeholder="緯度, 経度（例 35.3260, 139.5565。地図サービスからコピー）" value={place} onChange={(e) => setPlace(e.target.value)} />
        <button type="button" onClick={go}>移動</button>
        <button type="button" onClick={() => setZoom((z) => Math.min(18, z + 1))} aria-label="拡大">＋</button>
        <button type="button" onClick={() => setZoom((z) => Math.max(5, z - 1))} aria-label="縮小">－</button>
        <span className="muted small">ドラッグで動かす。押したところが位置になる</span>
      </div>
      <div ref={view} className="cell-map-view" style={{ width: WIDTH, height: HEIGHT }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => (drag.current = undefined)}>
        {tiles.map((t) => (
          <img key={`${t.x}/${t.y}`} alt="" draggable={false} src={`${TILES}/${zoom}/${t.x}/${t.y}.png`} style={{ left: t.x * TILE - left, top: t.y * TILE - top }} />
        ))}
        {marker && (
          <svg width={WIDTH} height={HEIGHT} style={{ pointerEvents: 'none' }}>
            {radiusM !== undefined && radiusM > 0 && (
              <circle className="point-radius" cx={marker.x - left} cy={marker.y - top} r={radiusM / metresPerPixel(lat!, zoom)} />
            )}
            <circle className="point-marker" cx={marker.x - left} cy={marker.y - top} r={6} />
          </svg>
        )}
        <span className="cell-map-credit">地理院タイル</span>
      </div>
    </div>
  );
}
