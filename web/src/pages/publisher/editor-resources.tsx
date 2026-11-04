import { RESOURCE_MIME } from '@yorisoi-console/protocol/vocabulary';
import { useEffect, useMemo, useState } from 'react';
import { imageFormat } from '../../editor/check';
import { cuesOf, fileText, withFile, withFileText, withResources, type Draft, type Json, type Resource } from '../../editor/draft';
import { sha256 } from '../../publisher-crypto';
import { PointMap } from '../point-map';
import { NumberField, Select, TextField, type Edit } from './editor-fields';

// DES-014: the resources (platform API-CHANNEL-PACKAGE「素材」, API-MATERIALS「素材集の形式」). Text and
// small images go in the package; images, audio and video can stay outside, with their size and
// SHA-256 worked out here from the local file (nothing is sent) or typed in (DES-014 未決事項 No.2).

const TYPE_LABEL: Record<string, string> = { text: 'テキスト', image: '画像', audio: '音声', video: '映像' };
const MAX_SIDE = 1600;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A resource id not used yet, from [base]. */
function freshId(items: Resource[], base: string): string {
  const ids = new Set(items.map((r) => r.id));
  for (let i = 1; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** The cues that name a resource, by id, so removing one can say what it breaks. */
function usedIn(d: Draft, id: string): string[] {
  return cuesOf(d).filter((c) => JSON.stringify(c.present ?? []).includes(`"${id}"`) || JSON.stringify(c.present ?? []).includes(`self#${id}"`)).map((c) => String(c.id));
}

/** A local image's longest side, or undefined when the browser can't read it. */
async function longestSide(bytes: Uint8Array): Promise<number | undefined> {
  try {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
    const side = Math.max(bitmap.width, bitmap.height);
    bitmap.close();
    return side;
  } catch {
    return undefined;
  }
}

/** A local audio or video file's length in seconds (rounded up), read by the browser. */
function mediaSeconds(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith('video') ? 'video' : 'audio');
    el.preload = 'metadata';
    el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Number.isFinite(el.duration) ? Math.ceil(el.duration) : undefined); };
    el.onerror = () => { URL.revokeObjectURL(url); resolve(undefined); };
    el.src = url;
  });
}

function ImagePreview({ bytes }: { bytes: Uint8Array }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([new Uint8Array(bytes)])), [bytes]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="thumb" alt="" src={url} />;
}

export function Resources({ d, edit, inCollection }: { d: Draft; edit: Edit; inCollection: boolean }) {
  const items = Array.isArray(d.manifest.resources) ? (d.manifest.resources as Resource[]) : [];
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string>();
  const replace = (i: number, r: Resource, draft = d) => edit(withResources(draft, items.map((x, j) => (j === i ? r : x))));
  const add = (type: 'text' | 'image' | 'outside') => {
    const id = freshId(items, type === 'outside' ? 'media' : type);
    const r: Resource =
      type === 'text' ? { id, type: 'text', file: `resources/text/${id}.md` }
        : type === 'image' ? { id, type: 'image', file: `resources/img/${id}.png`, alt: '', credit: { author: '', license: '' } }
          : { id, type: 'audio', url: 'https://', mime: 'audio/ogg', credit: { author: '', license: '' } };
    edit(withResources(d, [...items, r]));
  };
  const remove = (i: number) => {
    const uses = usedIn(d, items[i]!.id);
    if (uses.length && !window.confirm(`きっかけ ${uses.join('・')} がこの素材を使っています。消してよろしいですか？`)) return;
    edit(withResources(d, items.filter((_, j) => j !== i)));
  };
  const shown = items.map((r, i) => [r, i] as const).filter(([r]) => !filter || r.id.includes(filter) || JSON.stringify(r).includes(filter));
  return (
    <div className="form-grid">
      <p className="small muted">
        テキストと小さな画像（300KB まで、長い辺 1,600px まで）はパッケージに入れます。大きな画像・音声・映像は、あなたの HTTPS の置き場所に置いて URL を書きます。
        {inCollection ? ' 題材（スポット・地点）とタグを付けると、チャンネルが場所や基準で選べます。' : ''}
      </p>
      <div className="inline">
        <button type="button" onClick={() => add('text')}>テキストを足す</button>
        <button type="button" onClick={() => add('image')}>画像を足す</button>
        <button type="button" onClick={() => add('outside')}>外部の素材を足す</button>
        {items.length > 5 && <input placeholder="絞り込む（ID・中身）" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <span className="muted small">{items.length}/500</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {shown.map(([r, i]) => (
        <ResourceCard key={i} d={d} r={r} items={items} inCollection={inCollection} onChange={(next, draft) => replace(i, next, draft)} onRemove={() => remove(i)} onError={setError} />
      ))}
    </div>
  );
}

function ResourceCard({ d, r, items, inCollection, onChange, onRemove, onError }: {
  d: Draft; r: Resource; items: Resource[]; inCollection: boolean; onChange: (r: Resource, draft?: Draft) => void; onRemove: () => void; onError: (e: string | undefined) => void;
}) {
  const inPackage = typeof r.file === 'string';
  const set = (key: string, value: unknown) => {
    const next = { ...r } as Json;
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    onChange(next as Resource);
  };
  const setCredit = (key: string, value: string) => {
    const credit = { ...((r.credit as Json | undefined) ?? {}) };
    if (value === '' && key === 'source') delete credit[key];
    else credit[key] = value;
    onChange({ ...r, credit });
  };
  /** Renaming moves the resource's file along with it. */
  const rename = (id: string) => {
    if (!inPackage) return onChange({ ...r, id });
    const old = String(r.file);
    const file = old.replace(/\/[^/]*(\.[a-z]+)$/, `/${id}$1`);
    let draft = withFile(d, file, d.files[old]);
    if (file !== old) draft = withFile(draft, old, undefined);
    onChange({ ...r, id, file }, draft);
  };
  const pickImage = async (f: File | undefined) => {
    onError(undefined);
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const format = imageFormat(bytes);
    if (!format) return onError('JPEG・PNG・WebP の画像を選んでください');
    if (bytes.length > 300 * 1024) return onError('パッケージに入れる画像は 300KB までです（大きな画像は外部の素材にしてください）');
    const side = await longestSide(bytes);
    if (side !== undefined && side > MAX_SIDE) return onError(`長い辺を ${MAX_SIDE}px 以下にしてください（今 ${side}px）`);
    const file = `resources/img/${r.id}.${format === 'jpeg' ? 'jpg' : format}`;
    let draft = typeof r.file === 'string' && r.file !== file ? withFile(d, r.file, undefined) : d;
    draft = withFile(draft, file, bytes);
    onChange({ ...r, file }, draft);
  };
  const measure = async (f: File | undefined) => {
    onError(undefined);
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const next: Json = { ...r, size: bytes.length, sha256: hex(await sha256(bytes)) };
    if (r.type === 'audio' || r.type === 'video') {
      const seconds = await mediaSeconds(f);
      if (seconds !== undefined) next.durationSec = seconds;
    }
    if (f.type && (RESOURCE_MIME[r.type] ?? []).includes(f.type)) next.mime = f.type;
    onChange(next as Resource);
  };
  const texts = items.filter((x) => x.type === 'text').map((x) => x.id);
  const images = items.filter((x) => x.type === 'image').map((x) => x.id);
  return (
    <details className="card" open={!r.id || (r.type === 'text' && !fileText(d, String(r.file)))}>
      <summary>
        <code>{r.id}</code> {TYPE_LABEL[r.type] ?? r.type}{inPackage ? '' : '（外部）'}{' '}
        <span className="muted small">{r.type === 'text' && inPackage ? fileText(d, String(r.file)).slice(0, 40) : str(r.alt) || str(r.url)}</span>
      </summary>
      <div className="form-grid">
        <TextField label="ID（英小文字・数字・ハイフン。きっかけから指します）" value={r.id} onChange={rename} />
        {!inPackage && (
          <Select label="種類" value={r.type} options={['image', 'audio', 'video']} labels={TYPE_LABEL}
            onChange={(type) => onChange({ ...r, type, mime: RESOURCE_MIME[type]![0]! } as Resource)} />
        )}
        {r.type === 'text' && inPackage && (
          <TextField label="本文（読み上げ・カードにそのまま出します。URL は書けません）" rows={4} max={2000} value={fileText(d, String(r.file))}
            onChange={(v) => onChange(r, withFileText(d, String(r.file), v.replace(/\r\n?/g, '\n')))} />
        )}
        {r.type === 'image' && inPackage && (
          <label>
            画像のファイル（JPEG・PNG・WebP、300KB まで、長い辺 1,600px まで）
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => void pickImage(e.target.files?.[0])} />
            {d.files[String(r.file)] && <ImagePreview bytes={d.files[String(r.file)]!} />}
          </label>
        )}
        {!inPackage && (
          <>
            <TextField label="URL（https://）" value={str(r.url)} onChange={(v) => set('url', v)} />
            <Select label="形式" value={str(r.mime)} options={RESOURCE_MIME[r.type] ?? []} onChange={(v) => set('mime', v)} />
            <label>
              手元のファイルから大きさと SHA-256 を計算する（ファイルは送りません。置き場所に上げたものと同じファイルを選んでください）
              <input type="file" onChange={(e) => void measure(e.target.files?.[0])} />
            </label>
            <NumberField label="大きさ（バイト）" value={r.size} min={1} onChange={(v) => set('size', v)} />
            <TextField label="SHA-256（16 進数 64 文字）" value={str(r.sha256)} onChange={(v) => set('sha256', v.trim().toLowerCase())} hint="sha256sum（Windows は certutil -hashfile <ファイル> SHA256）でも計算できます" />
            {(r.type === 'audio' || r.type === 'video') && (
              <>
                <NumberField label="長さ（秒）" value={r.durationSec} min={1} onChange={(v) => set('durationSec', v)} />
                <Select label="書き起こし（テキストの素材）" value={str(r.transcript)} options={texts} blank="選ぶ" onChange={(v) => set('transcript', v)} />
              </>
            )}
            {r.type === 'video' && <Select label="最初に見せる絵（任意）" value={str(r.poster)} options={images} blank="なし" onChange={(v) => set('poster', v)} />}
          </>
        )}
        {r.type === 'image' && <TextField label="代替テキスト（何が写っているか）" max={120} value={str(r.alt)} onChange={(v) => set('alt', v)} />}
        {r.type !== 'text' && (
          <>
            <TextField label="作者" max={80} value={str((r.credit as Json | undefined)?.author)} onChange={(v) => setCredit('author', v)} />
            <TextField label="ライセンス（SPDX の識別子、PD、権利者の許諾なら permission）" max={40} value={str((r.credit as Json | undefined)?.license)} onChange={(v) => setCredit('license', v)} />
            <TextField label="出典（任意、https://）" value={str((r.credit as Json | undefined)?.source)} onChange={(v) => setCredit('source', v)} />
          </>
        )}
        {inCollection && <Subject r={r} onChange={onChange} />}
        <button type="button" className="danger" onClick={onRemove}>この素材を消す</button>
      </div>
    </details>
  );
}

/** A collection's resource: its subject (`about`) and tags (API-MATERIALS). */
function Subject({ r, onChange }: { r: Resource; onChange: (r: Resource) => void }) {
  const about = (r.about as Json | undefined) ?? undefined;
  const type = about ? String(about.type) : '';
  const setAbout = (patch: Json | undefined) => {
    const next = { ...r } as Json;
    if (patch === undefined) delete next.about;
    else next.about = patch;
    onChange(next as Resource);
  };
  const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
  return (
    <>
      <TextField label="タグ（3 個まで、空白で区切る。英小文字・数字・ハイフン）" value={tags.join(' ')}
        onChange={(v) => { const t = v.split(/[\s,、]+/).filter(Boolean); const next = { ...r } as Json; if (t.length) next.tags = t; else delete next.tags; onChange(next as Resource); }} />
      <Select label="題材" value={type} options={['spot', 'point']} labels={{ spot: 'スポット', point: '地点' }} blank="なし"
        onChange={(v) => setAbout(v === '' ? undefined : v === 'spot' ? { type: 'spot', osm: '', lat: about?.lat, lon: about?.lon } : { type: 'point', lat: about?.lat, lon: about?.lon, radiusM: 50 })} />
      {about && (
        <>
          {type === 'spot' && (
            <>
              <TextField label="OSM の ID（node/…・way/…・relation/…。OpenStreetMap でスポットを選ぶと出ます）" value={str(about.osm)} onChange={(v) => setAbout({ ...about, osm: v.trim() })} />
              <TextField label="スポットの名前（任意。ID が違っても同じ名前で 200m 以内なら同じスポット）" max={60} value={str(about.name)}
                onChange={(v) => { const next = { ...about }; if (v) next.name = v; else delete next.name; setAbout(next); }} />
            </>
          )}
          {type === 'point' && <NumberField label="半径（m、20〜300）" value={about.radiusM} min={20} max={300} onChange={(v) => setAbout({ ...about, radiusM: v })} />}
          <p className="small muted">位置: {about.lat !== undefined ? `${String(about.lat)}, ${String(about.lon)}` : 'まだありません'}（スポットは、その中か境界から 100m 以内の点）</p>
          <PointMap lat={about.lat as number | undefined} lon={about.lon as number | undefined} radiusM={type === 'point' ? (about.radiusM as number | undefined) : undefined}
            onChange={(lat, lon) => setAbout({ ...about, lat, lon })} />
        </>
      )}
    </>
  );
}
