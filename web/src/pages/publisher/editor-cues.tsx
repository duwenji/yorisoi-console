import { BUILTIN_PRODUCERS, VOCABULARY as V } from '@yorisoi-console/protocol/vocabulary';
import { useState } from 'react';
import { collectionsOf, cuesOf, resourcesOf, withList, type Draft, type Json } from '../../editor/draft';
import { PointMap } from '../point-map';
import { Choices, NumberField, Select, TextField, type Edit } from './editor-fields';

// DES-014: the cues and the collections a channel uses (platform API-CHANNEL-PACKAGE「きっかけ」
// 「素材集の宣言」). A cue keeps any field the form doesn't show (`params` is edited as JSON).

const PRESENT_LABEL: Record<string, string> = {
  speak: '読み上げ', card: 'カード', notify: '通知', sheet: '解説の画面', play: '録音の再生', ambient: '背景音として流す', fullscreen: '全画面',
};
const EVENT_LABEL: Record<string, string> = { select: 'このチャンネルを選んだ', start: '散歩の開始', finish: '散歩の終了', idle: '語りの合間' };
const REPEAT_LABEL: Record<string, string> = { oncePerWalk: '散歩ごとに 1 度（既定）', oncePerDay: '1 日に 1 度', once: 'その端末で 1 度だけ' };
const NARRATION_LABEL: Record<string, string> = { replace: 'AI の解説の代わりに出す（既定）', add: 'AI の解説の後に出す' };
type TriggerKind = 'spot' | 'any' | 'point' | 'event';

const triggerKind = (t: Json): TriggerKind => (t.type === 'spot' ? (t.any === true ? 'any' : 'spot') : t.type === 'point' ? 'point' : 'event');
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

function freshCueId(cues: Json[], base = 'cue'): string {
  const ids = new Set(cues.map((c) => String(c.id)));
  for (let i = 1; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function Cues({ d, edit }: { d: Draft; edit: Edit }) {
  const cues = cuesOf(d);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<number>();
  const set = (list: Json[]) => edit(withList(d, 'cues', list));
  const add = () => {
    set([...cues, { id: freshCueId(cues), trigger: { type: 'spot', osm: '' }, present: [{ as: 'speak', resource: '' }] }]);
    setOpen(cues.length);
  };
  const shown = cues.map((c, i) => [c, i] as const).filter(([c]) => !filter || JSON.stringify(c).includes(filter));
  return (
    <div className="form-grid">
      <p className="small muted">
        どの素材を、いつ、どの見せ方で出すかを決めます。見せ方ごとに、出せる素材の種類と、歩いているときに出せるかはアプリが決めています（解説の画面と全画面は、利用者が押したときだけ開きます）。
      </p>
      <div className="inline">
        <button type="button" onClick={add}>きっかけを足す</button>
        {cues.length > 5 && <input placeholder="絞り込む（ID・名前・素材）" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <span className="muted small">{cues.length}/500</span>
      </div>
      {shown.map(([c, i]) => (
        <CueCard key={i} d={d} cue={c} open={open === i}
          onChange={(next) => set(cues.map((x, j) => (j === i ? next : x)))}
          onCopy={() => { set([...cues.slice(0, i + 1), { ...structuredClone(c), id: freshCueId(cues, String(c.id)) }, ...cues.slice(i + 1)]); setOpen(i + 1); }}
          onRemove={() => set(cues.filter((_, j) => j !== i))} />
      ))}
    </div>
  );
}

function CueCard({ d, cue, open, onChange, onCopy, onRemove }: { d: Draft; cue: Json; open: boolean; onChange: (c: Json) => void; onCopy: () => void; onRemove: () => void }) {
  const trigger = (cue.trigger as Json | undefined) ?? {};
  const kind = triggerKind(trigger);
  const present = Array.isArray(cue.present) ? (cue.present as Json[]) : [];
  const setField = (key: string, value: unknown) => {
    const next = { ...cue };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const setTrigger = (t: Json) => {
    const next: Json = { ...cue, trigger: t };
    if (t.type !== 'spot') delete next.narration;
    if (t.type === 'event' && t.event === 'idle') delete next.repeat;
    onChange(next);
  };
  const changeKind = (k: TriggerKind) =>
    setTrigger(k === 'spot' ? { type: 'spot', osm: '' } : k === 'any' ? { type: 'spot', any: true, categories: [] } : k === 'point' ? { type: 'point', radiusM: 40 } : { type: 'event', event: 'select' });
  const summary = kind === 'event' ? EVENT_LABEL[str(trigger.event)] : kind === 'point' ? '地点' : kind === 'any' ? '種類のどのスポットでも' : str(trigger.name) || str(trigger.osm);
  return (
    <details className="card" open={open}>
      <summary><code>{String(cue.id)}</code> {summary} → {present.map((p) => PRESENT_LABEL[str(p.as)] ?? str(p.as)).join('・')}</summary>
      <div className="form-grid">
        <TextField label="ID（英小文字・数字・ハイフン）" value={str(cue.id)} onChange={(v) => setField('id', v)} />
        <Select label="きっかけ" value={kind} options={['spot', 'any', 'point', 'event']} onChange={(v) => changeKind(v as TriggerKind)}
          labels={{ spot: 'スポットに近づいた', any: '決めた種類のどのスポットでも', point: '地点の半径に入った', event: '出来事' }} />
        {kind === 'spot' && (
          <>
            <TextField label="OSM の ID（node/…・way/…・relation/…）" value={str(trigger.osm)} onChange={(v) => setTrigger({ ...trigger, osm: v.trim() })} />
            <TextField label="スポットの名前（任意。ID が違っても同じ名前で 200m 以内なら同じスポット）" max={60} value={str(trigger.name)}
              onChange={(v) => { const t = { ...trigger }; if (v) t.name = v; else delete t.name; setTrigger(t); }} />
          </>
        )}
        {kind === 'any' && (
          <Choices label="スポットの種類（1〜8 個）" options={Object.keys(V.spotKinds)} labels={V.spotKinds as Record<string, string>} value={strs(trigger.categories)}
            onChange={(v) => setTrigger({ ...trigger, categories: v })} />
        )}
        {kind === 'point' && (
          <>
            <NumberField label="半径（m、20〜300）" value={trigger.radiusM} min={20} max={300} onChange={(v) => setTrigger({ ...trigger, radiusM: v })} />
            <p className="small muted">
              位置: {trigger.lat !== undefined ? `${String(trigger.lat)}, ${String(trigger.lon)}` : 'まだありません'}。
              車道・線路・私有地・立入禁止・危険な場所を避け、立ち止まりやすい場所にしてください（審査で確かめます）。
            </p>
            <PointMap lat={trigger.lat as number | undefined} lon={trigger.lon as number | undefined} radiusM={trigger.radiusM as number | undefined}
              onChange={(lat, lon) => setTrigger({ ...trigger, lat, lon })} />
          </>
        )}
        {kind === 'event' && <Select label="出来事" value={str(trigger.event)} options={V.cueEvents} labels={EVENT_LABEL} onChange={(v) => setTrigger({ ...trigger, event: v })} />}
        {trigger.type === 'spot' && <Select label="AI の解説との関係" value={str(cue.narration)} options={V.narration} labels={NARRATION_LABEL} blank="書かない（置き換える）" onChange={(v) => setField('narration', v)} />}
        {trigger.event !== 'idle' && <Select label="繰り返し" value={str(cue.repeat)} options={V.repeat} labels={REPEAT_LABEL} blank="書かない（散歩ごとに 1 度）" onChange={(v) => setField('repeat', v)} />}
        <fieldset>
          <legend>見せ方（上から順に出す。1〜4 個）</legend>
          {present.map((p, i) => (
            <PresentRow key={i} d={d} p={p} idle={trigger.event === 'idle'}
              onChange={(next) => setField('present', present.map((x, j) => (j === i ? next : x)))}
              onRemove={() => setField('present', present.filter((_, j) => j !== i))} />
          ))}
          {present.length < 4 && <button type="button" onClick={() => setField('present', [...present, { as: 'card', resource: '' }])}>見せ方を足す</button>}
        </fieldset>
        <div className="inline">
          <button type="button" onClick={onCopy}>複製する</button>
          <button type="button" className="danger" onClick={onRemove}>このきっかけを消す</button>
        </div>
      </div>
    </details>
  );
}

/** The candidates a `source` may name, for the input's suggestions. */
function suggestions(d: Draft): string[] {
  const own = resourcesOf(d).map((r) => `self#${r.id}`);
  const aliases = collectionsOf(d).map((c) => String(c.as));
  const selectors = Array.isArray(d.manifest.selectors) ? (d.manifest.selectors as Json[]).map((s) => String(s.as)) : [];
  return [...aliases, ...selectors, ...Object.keys(BUILTIN_PRODUCERS), ...own];
}

function PresentRow({ d, p, idle, onChange, onRemove }: { d: Draft; p: Json; idle: boolean; onChange: (p: Json) => void; onRemove: () => void }) {
  const as = str(p.as);
  const types = (V.presentAs as Record<string, string[]>)[as] ?? [];
  const byReference = p.source !== undefined || p.sources !== undefined;
  const fitting = resourcesOf(d).filter((r) => types.includes(r.type)).map((r) => r.id);
  const [params, setParams] = useState(p.params ? JSON.stringify(p.params) : '');
  const [paramsError, setParamsError] = useState<string>();
  /** Keeps `as` and `params`, and the other fields of the chosen way to name the material. */
  const base = (): Json => {
    const next = { ...p };
    for (const k of ['resource', 'resources', 'source', 'sources']) delete next[k];
    return next;
  };
  const setMode = (reference: boolean) =>
    onChange(reference ? { ...base(), ...(as === 'sheet' ? { sources: [] } : { source: [] }) } : { ...base(), ...(as === 'sheet' ? { resources: [] } : { resource: '' }) });
  const applyParams = () => {
    if (params.trim() === '') { setParamsError(undefined); const next = { ...p }; delete next.params; return onChange(next); }
    try {
      const value = JSON.parse(params) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
      setParamsError(undefined);
      onChange({ ...p, params: value });
    } catch {
      setParamsError('JSON のオブジェクトにしてください（例 {"categories": ["event"], "prelude": "by-the-way"}）');
    }
  };
  return (
    <div className="present-row">
      <Select label="見せ方" value={as} options={Object.keys(V.presentAs)} labels={PRESENT_LABEL}
        onChange={(v) => onChange(v === 'sheet' || as === 'sheet' ? { as: v, ...(p.params ? { params: p.params } : {}), ...(byReference ? (v === 'sheet' ? { sources: [] } : { source: [] }) : (v === 'sheet' ? { resources: [] } : { resource: '' })) } : { ...p, as: v })} />
      <span className="small muted">出せる素材: {types.join('・')}</span>
      <Select label="素材の指し方" value={byReference ? 'ref' : 'own'} options={idle ? ['ref'] : ['own', 'ref']}
        labels={{ own: 'このチャンネルの素材', ref: '素材提供者への参照（素材集・組み込み）' }} onChange={(v) => setMode(v === 'ref')} />
      {!byReference && as !== 'sheet' && <Select label="素材" value={str(p.resource)} options={fitting} blank="選ぶ" onChange={(v) => onChange({ ...base(), resource: v })} />}
      {!byReference && as === 'sheet' && <Choices label="素材（1〜10 個）" options={fitting} value={strs(p.resources)} onChange={(v) => onChange({ ...base(), resources: v })} />}
      {byReference && as !== 'sheet' && (
        <>
          <TextField label="候補（並べた順に求め、最初に出せた素材を使う。1〜3 個を空白で区切る）" value={strs(p.source).join(' ')}
            onChange={(v) => onChange({ ...base(), source: v.split(/[\s,、]+/).filter(Boolean) })}
            hint="例: kamakura#daibutsu-photo builtin:commons-photo（別名#ID は素材集の素材、別名だけなら題材で選ぶ、builtin: は組み込みの素材提供者）" />
          <span className="small muted">使える名前: {suggestions(d).join('　')}</span>
        </>
      )}
      {byReference && as === 'sheet' && (
        <TextField label="並べる素材（1 行に 1 つ。行ごとに候補を 1〜3 個、空白で区切る）" rows={3}
          value={(Array.isArray(p.sources) ? (p.sources as unknown[]) : []).map((s) => strs(s).join(' ')).join('\n')}
          onChange={(v) => onChange({ ...base(), sources: v.split('\n').map((line) => line.split(/[\s,、]+/).filter(Boolean)).filter((g) => g.length).map((g) => (g.length === 1 ? g[0] : g)) })} />
      )}
      {byReference && (
        <label>
          組み込みの素材提供者への指示（任意、JSON。例 スタジオの分類と前置き）
          <input value={params} onChange={(e) => setParams(e.target.value)} onBlur={applyParams} placeholder='{"categories": ["event"], "prelude": "by-the-way"}' />
          {paramsError && <span className="error small">{paramsError}</span>}
        </label>
      )}
      <button type="button" className="link" onClick={onRemove}>この見せ方を外す</button>
    </div>
  );
}

export function Declarations({ d, edit }: { d: Draft; edit: Edit }) {
  const items = collectionsOf(d);
  const set = (list: Json[]) => edit(withList(d, 'collections', list));
  const patch = (i: number, key: string, value: unknown) => set(items.map((x, j) => (j === i ? { ...x, [key]: value } : x)));
  return (
    <div className="form-grid">
      <p className="small muted">
        ほかの素材提供者の素材集を使うときに宣言します（5 個まで）。使えるのは、リストに載っていて利用許諾があなたを含む素材集だけです。宣言した別名は、きっかけの「素材提供者への参照」で使います。
      </p>
      {items.length > 0 && (
        <table className="compact">
          <thead><tr><th>別名</th><th>素材集の ID</th><th>最低の版</th><th></th></tr></thead>
          <tbody>
            {items.map((c, i) => (
              <tr key={i}>
                <td><input value={str(c.as)} onChange={(e) => patch(i, 'as', e.target.value)} /></td>
                <td><input value={str(c.id)} onChange={(e) => patch(i, 'id', e.target.value)} /></td>
                <td><input type="number" min={1} value={typeof c.minVersion === 'number' ? c.minVersion : ''} onChange={(e) => patch(i, 'minVersion', e.target.value === '' ? undefined : Number(e.target.value))} /></td>
                <td><button type="button" className="link" onClick={() => set(items.filter((_, j) => j !== i))}>外す</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {items.length < 5 && <button type="button" onClick={() => set([...items, { as: '', id: '', minVersion: 1 }])}>素材集を足す</button>}
    </div>
  );
}
