import { useEffect, useState, type ReactNode } from 'react';
import { KNOWN_APPS_FOR_SCREEN, VOCABULARY as V } from './editor-vocabulary';
import { chars, forbiddenText } from '../../editor/check';
import { fileText, getIn, withFileText, withManifest, type Draft, type Json } from '../../editor/draft';

// DES-014: the fields of channel.json and collection.json the screens edit. Each edit returns a
// new draft; anything else in the manifest is kept (R-11).

export type Edit = (next: Draft) => void;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A text input with its count against [max]. */
export function TextField({ label, value, onChange, max, rows, placeholder, hint }: {
  label: ReactNode; value: string; onChange: (v: string) => void; max?: number; rows?: number; placeholder?: string; hint?: ReactNode;
}) {
  const count = chars(value);
  return (
    <label>
      <span>{label}{max !== undefined && <span className={`small ${count > max ? 'error' : 'muted'}`}>（{count}/{max}）</span>}</span>
      {rows ? <textarea rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /> : <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
      {hint && <span className="small muted">{hint}</span>}
    </label>
  );
}

/** A number input; empty is undefined. */
export function NumberField({ label, value, onChange, step, min, max }: {
  label: ReactNode; value: unknown; onChange: (v: number | undefined) => void; step?: number | 'any'; min?: number; max?: number;
}) {
  return (
    <label>
      {label}
      <input type="number" step={step ?? 1} min={min} max={max} value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    </label>
  );
}

/** Checkboxes over [options]; the value is the chosen ones in the options' order. */
export function Choices({ label, options, value, onChange, labels }: {
  label: ReactNode; options: readonly string[]; value: string[]; onChange: (v: string[]) => void; labels?: Record<string, string>;
}) {
  return (
    <fieldset className="choices">
      <legend>{label}</legend>
      {options.map((o) => (
        <label key={o} className="check">
          <input type="checkbox" checked={value.includes(o)} onChange={(e) => onChange(options.filter((x) => (x === o ? e.target.checked : value.includes(x))))} />
          {labels?.[o] ?? o}
        </label>
      ))}
    </fieldset>
  );
}

export function Select({ label, value, options, onChange, labels, blank }: {
  label: ReactNode; value: string; options: readonly string[]; onChange: (v: string) => void; labels?: Record<string, string>; blank?: string;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {blank !== undefined && <option value="">{blank}</option>}
        {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
      </select>
    </label>
  );
}

const ACTIVITY: Record<string, string> = { walk: '散歩', cycle: 'サイクリング' };
const GENRE: Record<string, string> = { general: '話題を絞らない', history: '歴史', nature: '自然', food: '食', shopping: '買い物' };
const FEATURE: Record<string, string> = {
  'slot:guide': 'スポットの解説の文章', 'slot:companion': '散歩の友の文章', 'trigger:spot': 'スポットのきっかけ', 'trigger:point': '地点のきっかけ',
  'trigger:event': '出来事のきっかけ', 'present:speak': '読み上げ', 'present:card': 'カード', 'present:notify': '通知', 'present:sheet': '解説の画面',
  'present:play': '録音の再生', 'present:ambient': '背景音として流す', 'present:fullscreen': '全画面',
};
const TALK_LEVEL: Record<string, string> = { quiet: '控えめ', normal: 'ふつう', chatty: 'おしゃべり' };
const TALK_EVENT: Record<string, string> = { spot: '初めてのスポットの解説', revisit: '再訪の一言', milestone: '距離・時間の区切り', rest: '休憩', start: '開始のあいさつ', finish: '終了の振り返り' };
const LENGTH: Record<string, string> = { short: '短い（100〜150 字）', normal: 'ふつう（200〜300 字）', long: '長い（300〜450 字）' };
const SOUND: Record<string, string> = { auto: '雰囲気から選ぶ', rain: '雨', waves: '波', wind: '風', birds: '鳥', insects: '虫', temple: '寺' };
export const SLOT_LABEL: Record<string, string> = {
  'prompts/guide/persona.md': 'スポットの解説の語り手（役割・口調）',
  'prompts/guide/focus.md': '解説で重点を置くこと',
  'prompts/companion/persona.md': '散歩の友の語り手',
  'prompts/companion/topics.md': '雑談の話題の選び方',
  'prompts/companion/events/start.md': '開始のときの追加の指示',
  'prompts/companion/events/revisit.md': '再訪のときの追加の指示',
  'prompts/companion/events/milestone.md': '区切りのときの追加の指示',
  'prompts/companion/events/rest.md': '休憩のときの追加の指示',
  'prompts/companion/events/finish.md': '終了のときの追加の指示',
};

/** The fields both kinds share: id, version, owner, name, summary. */
function Header({ d, edit, accountId, owner, latest }: { d: Draft; edit: Edit; accountId?: string | undefined; owner: 'publisher' | 'producer'; latest?: number | undefined }) {
  const m = d.manifest;
  return (
    <>
      <dl className="facts">
        <dt>ID</dt><dd><code>{str(m.id)}</code></dd>
        <dt>{owner === 'publisher' ? 'チャンネル提供者' : '素材提供者'}</dt>
        <dd>
          <code>{str(m[owner]) || '—'}</code>{' '}
          {accountId && m[owner] !== accountId && (
            <button type="button" className="link" onClick={() => edit(withManifest(d, [owner], accountId))}>自分のアカウントID {accountId} にする</button>
          )}
        </dd>
      </dl>
      <NumberField label={<>版{latest !== undefined && <span className="small muted">（最後に承認された版 {latest}。それより大きく）</span>}</>} value={m.version} min={1}
        onChange={(v) => edit(withManifest(d, ['version'], v))} />
      <TextField label="名前（アプリの一覧に出ます）" max={20} value={str(m.name)} onChange={(v) => edit(withManifest(d, ['name'], v))} />
      <TextField label="要約" max={60} value={str(m.summary)} onChange={(v) => edit(withManifest(d, ['summary'], v))} />
    </>
  );
}

export function ChannelBasics({ d, edit, accountId, latest }: { d: Draft; edit: Edit; accountId?: string | undefined; latest?: number | undefined }) {
  const m = d.manifest;
  return (
    <div className="form-grid">
      <Header d={d} edit={edit} accountId={accountId} owner="publisher" latest={latest} />
      <Choices label="過ごし方（このチャンネルが合うもの。合うアプリにだけ届きます）" options={V.activities} labels={ACTIVITY} value={strs(m.activities)}
        onChange={(v) => edit(withManifest(d, ['activities'], v))} />
      <Choices label="ジャンル（3 個まで）" options={V.genres} labels={GENRE} value={strs(m.genres)} onChange={(v) => edit(withManifest(d, ['genres'], v))} />
      <Choices label="必要な機能（これがないアプリには届きません。書かない機能は、ないアプリで使われないだけ）" options={V.features} labels={FEATURE}
        value={strs(getIn(m, ['requires', 'features']))} onChange={(v) => edit(withManifest(d, ['requires'], v.length ? { ...(m.requires as Json | undefined), features: v } : undefined))} />
      <p className="small muted">今の各アプリの機能: {KNOWN_APPS_FOR_SCREEN}</p>
      <TextField label="あいさつ（切り替えたときにそのまま読み上げます。AI は使いません）" max={60} value={str(m.greeting)} onChange={(v) => edit(withManifest(d, ['greeting'], v))} />
    </div>
  );
}

export function ChannelTalk({ d, edit }: { d: Draft; edit: Edit }) {
  const m = d.manifest;
  const prefer = strs(getIn(m, ['spots', 'prefer']));
  const skip = strs(getIn(m, ['spots', 'skip']));
  const setKind = (kind: string, as: '' | 'prefer' | 'skip') => {
    const p = prefer.filter((k) => k !== kind);
    const s = skip.filter((k) => k !== kind);
    if (as === 'prefer') p.push(kind);
    if (as === 'skip') s.push(kind);
    edit(withManifest(d, ['spots'], { ...(m.spots as Json | undefined), prefer: p, skip: s }));
  };
  return (
    <div className="form-grid">
      <Select label="話す頻度" value={str(getIn(m, ['talk', 'level']))} options={V.talkLevels} labels={TALK_LEVEL} onChange={(v) => edit(withManifest(d, ['talk', 'level'], v))} />
      <fieldset className="choices">
        <legend>話す出来事（天気の急変・日の入り・施設の案内は、どのチャンネルでも話します）</legend>
        {V.talkEvents.map((e) => (
          <label key={e} className="check">
            <input type="checkbox" checked={getIn(m, ['talk', 'events', e]) === true} onChange={(x) => edit(withManifest(d, ['talk', 'events', e], x.target.checked))} />
            {TALK_EVENT[e]}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>スポットの好み（優先は 8 個まで。話題にしない種類も地図と一覧には出ます）</legend>
        <table className="compact">
          <tbody>
            {Object.entries(V.spotKinds).map(([kind, label]) => (
              <tr key={kind}>
                <td>{label} <code className="small">{kind}</code></td>
                <td>
                  <select value={prefer.includes(kind) ? 'prefer' : skip.includes(kind) ? 'skip' : ''} onChange={(e) => setKind(kind, e.target.value as '' | 'prefer' | 'skip')}>
                    <option value="">ふつう</option>
                    <option value="prefer">優先する</option>
                    <option value="skip">話題にしない</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>
      <Select label="スポットの解説の長さ" value={str(getIn(m, ['guide', 'length']))} options={V.guideLengths} labels={LENGTH} onChange={(v) => edit(withManifest(d, ['guide', 'length'], v))} />
      <label className="check">
        <input type="checkbox" checked={getIn(m, ['mood', 'tone']) === true} onChange={(e) => edit(withManifest(d, ['mood', 'tone'], e.target.checked))} />
        話し方のトーンを雰囲気に合わせる
      </label>
      <Select label="背景音" value={str(getIn(m, ['mood', 'sound']))} options={V.sounds} labels={SOUND} onChange={(v) => edit(withManifest(d, ['mood', 'sound'], v))} />
    </div>
  );
}

export function ChannelPrompts({ d, edit }: { d: Draft; edit: Edit }) {
  const total = Object.keys(V.slots).reduce((n, path) => n + chars(fileText(d, path)), 0);
  return (
    <div className="form-grid">
      <p className="small muted">
        空の欄には、アプリの標準のチャンネルの文章が入ります。<code>{'{{'}</code>・URL・見出し（# で始まる行）は書けません。どのチャンネルでも、アプリが最後に共通の指示（個人情報を尋ねない、危険な場所に誘わない、事実でないことを事実として話さない）を付けます。
        合計 <span className={total > V.slotsTotal ? 'error' : ''}>{total}</span>/{V.slotsTotal} 文字。
      </p>
      {Object.entries(V.slots).map(([path, max]) => {
        const value = fileText(d, path);
        const why = value ? forbiddenText(value) : undefined;
        return (
          <TextField key={path} label={<>{SLOT_LABEL[path]} <code className="small">{path}</code></>} rows={path.includes('/events/') ? 2 : 4} max={max} value={value}
            hint={why && <span className="error">{why}</span>} onChange={(v) => edit(withFileText(d, path, v.replace(/\r\n?/g, '\n')))} />
        );
      })}
    </div>
  );
}

const APPS = Object.keys(V.apps);

export function CollectionBasics({ d, edit, accountId, latest }: { d: Draft; edit: Edit; accountId?: string | undefined; latest?: number | undefined }) {
  const m = d.manifest;
  const publishers = getIn(m, ['grants', 'publishers']);
  const everyone = publishers === '*';
  const apps = getIn(m, ['grants', 'apps']);
  return (
    <div className="form-grid">
      <Header d={d} edit={edit} accountId={accountId} owner="producer" latest={latest} />
      <fieldset>
        <legend>利用許諾: 使ってよいチャンネル提供者</legend>
        <label className="check"><input type="radio" checked={everyone} onChange={() => edit(withManifest(d, ['grants', 'publishers'], '*'))} /> 誰でも</label>
        <label className="check"><input type="radio" checked={!everyone} onChange={() => edit(withManifest(d, ['grants', 'publishers'], []))} /> 決めたチャンネル提供者だけ</label>
        {!everyone && (
          <TextField label="アカウントID（sg1…。1 行に 1 つ、50 個まで）" rows={3} value={strs(publishers).join('\n')}
            onChange={(v) => edit(withManifest(d, ['grants', 'publishers'], v.split(/\s+/).filter(Boolean)))} />
        )}
      </fieldset>
      <Choices label="利用許諾: 使ってよいアプリ（選ばなければすべてのアプリ）" options={APPS} labels={V.apps} value={strs(apps)}
        onChange={(v) => edit(withManifest(d, ['grants', 'apps'], v.length ? v : undefined))} />
      <label className="check">
        <input type="checkbox" checked={getIn(m, ['grants', 'grounding']) === true} onChange={(e) => edit(withManifest(d, ['grants', 'grounding'], e.target.checked ? true : undefined))} />
        AI の根拠に使ってよい（本文・代替テキスト・書き起こしに「{'{{'}」と URL を書けなくなります）
      </label>
    </div>
  );
}

/**
 * The manifest's fields the forms don't edit, as JSON (R-11): `selectors`, `shorthands` and
 * anything newer. Applied when it parses as an object.
 */
export function OtherFields({ d, edit, formKeys }: { d: Draft; edit: Edit; formKeys: readonly string[] }) {
  const others = Object.fromEntries(Object.entries(d.manifest).filter(([k]) => !formKeys.includes(k)));
  const shown = JSON.stringify(others, null, 2);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string>();
  useEffect(() => setText(shown), [shown]);
  const apply = () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return setError('JSON として読めません');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return setError('JSON のオブジェクトにしてください');
    const clash = Object.keys(value).filter((k) => formKeys.includes(k));
    if (clash.length) return setError(`${clash.join('・')} はフォームの欄で編集してください`);
    setError(undefined);
    const kept = Object.fromEntries(Object.entries(d.manifest).filter(([k]) => formKeys.includes(k)));
    edit({ ...d, manifest: { ...kept, ...(value as Json) } });
  };
  return (
    <div className="form-grid">
      <p className="small muted">
        フォームにない項目（<code>selectors</code>・<code>shorthands</code> など）をここで直接編集します。書き方は platform API-CHANNEL-PACKAGE・API-MATERIALS のとおりです。
      </p>
      <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} spellCheck={false} />
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
