import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { fromPixel, toPixel } from '../geohash';

// Choosing one place for a draft (DES-014): a cue's point or a resource's subject. GSI tiles as
// for the studio's cells (cell-map.tsx); a click or the typed coordinates put the point, a drag moves the map.

const WIDTH = 640;
const HEIGHT = 360;
const TILE = 256;
const TILES = 'https://cyberjapandata.gsi.go.jp/xyz/std';
/** Tokyo Station, until a point is chosen. */
const START = { lat: 35.6812, lng: 139.7671 };
/** Close enough to see a 20m radius, for typed coordinates. */
const POINT_ZOOM = 17;

/** Metres per pixel at [lat] and [zoom] (Web Mercator). */
const metresPerPixel = (lat: number, zoom: number) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function PointMap({ lat, lon, radiusM, onChange }: { lat?: number | undefined; lon?: number | undefined; radiusM?: number | undefined; onChange: (lat: number, lon: number) => void }) {
  const has = Number.isFinite(lat) && Number.isFinite(lon);
  const [center, setCenter] = useState(has ? { lat: lat!, lng: lon! } : START);
  const [zoom, setZoom] = useState(has ? POINT_ZOOM : 14);
  const [place, setPlace] = useState(has ? `${String(lat)}, ${String(lon)}` : '');
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const view = useRef<HTMLDivElement>(null);

  // The box shows the chosen point, however it was chosen.
  useEffect(() => {
    if (Number.isFinite(lat) && Number.isFinite(lon)) setPlace(`${String(lat)}, ${String(lon)}`);
  }, [lat, lon]);

  /** Puts the point at [p]. Typed coordinates also bring the map there, close enough to see the radius; a click leaves the map as it is. */
  const choose = (p: { lat: number; lng: number }, typed: boolean) => {
    if (typed) {
      setCenter(p);
      setZoom((z) => Math.max(z, POINT_ZOOM));
    }
    onChange(round6(p.lat), round6(p.lng));
  };

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
    choose(fromPixel(left + e.clientX - box.left, top + e.clientY - box.top, zoom), false);
  };
  const go = () => {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(place);
    const p = m ? { lat: Number(m[1]), lng: Number(m[2]) } : undefined;
    if (p && Math.abs(p.lat) <= 85 && Math.abs(p.lng) <= 180) choose(p, true);
  };

  return (
    <div className="cell-map">
      <div className="cell-map-tools">
        <input aria-label="位置（緯度, 経度）" placeholder="緯度, 経度（例 35.3260, 139.5565。地図サービスからコピー）" value={place}
          onChange={(e) => setPlace(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }} />
        <button type="button" onClick={go}>この位置にする</button>
        <button type="button" onClick={() => setZoom((z) => Math.min(18, z + 1))} aria-label="拡大">＋</button>
        <button type="button" onClick={() => setZoom((z) => Math.max(5, z - 1))} aria-label="縮小">－</button>
        <span className="muted small">地図を押すか、緯度, 経度を入れて「この位置にする」。ドラッグで動かす</span>
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
