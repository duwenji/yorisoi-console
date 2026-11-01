import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Schemas } from '@yorisoi-console/api-types';
import { STUDIO_CATEGORIES, type StudioCategory } from '@yorisoi-console/protocol';
import { describe, ifMatch } from '../api';
import { useSession } from '../main';
import { CellMap } from './cell-map';
import { Empty, ReasonForm, Status, Time, useLoad } from './common';

// The studio's pages (DES-013 K-14〜K-17): providers apply and put up studios; the operator
// approves providers and answers appeals.

const RULES_URL = 'https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/studio-rules.md';
const RULES_VERSION = 2;
const AUDIO_MAX_BYTES = 512 * 1024;

const STUDIO_STATUS: Record<Schemas['StudioStatus'], string> = {
  none: '申し込んでいない', requested: '審査待ち', approved: '承認', declined: '見送り', suspended: '止めている', revoked: '取り消し',
};

const STUDIO_STATE: Record<Schemas['StudioState'], string> = {
  uploading: '音声待ち', checking: '確認中', returned: '返した', appealed: '申し出中', live: '載っている', stopped: '止めた',
  suspended: '止められた', removed: '消された', rejected: '載せない',
};

/** What the automatic check found (platform policies/studio-rules.md 2.2, 3). */
const CHECK_ITEMS: Record<string, string> = {
  '2.2.1': '2.2.1 安全を損なう誘い',
  '2.2.2': '2.2.2 連絡先（URL・電話番号・メールアドレス・SNS）',
  '2.2.3': '2.2.3 人を傷つけるもの・個人の情報',
  '2.2.4': '2.2.4 政治・宗教',
  '2.2.5': '2.2.5 お金にかかわる勧誘',
  '2.2.6': '2.2.6 出会い・交際',
  '2.2.7': '2.2.7 賭け事',
  '2.2.8': '2.2.8 酒類・たばこ',
  '2.2.9': '2.2.9 健康・医療の効き目',
  '2.2.10': '2.2.10 成人向け・暴力的なもの',
  '2.2.11': '2.2.11 違法なもの・権利を侵すもの',
  '2.2.12': '2.2.12 なりすまし',
  audio_missing: '音声が届いていません。もう一度作り直してください',
  audio_format: '音声が M4A（AAC）でないか、512 KB を超えています',
  audio_length: '音声が 30 秒を超えています',
  transcribe_failed: '音声を文字に起こせませんでした',
  check_unavailable: '今は確認できませんでした。少し待ってから作り直してください',
  unclear: '確認で問題が見つかりました（項目を特定できませんでした）',
};

const JST = (local: string) => new Date(`${local}:00+09:00`).toISOString();
const jstInput = (date: Date) => new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 16);

function CheckResult({ check }: { check: Schemas['Studio']['check'] }) {
  if (!check || check.items.length === 0) return null;
  return (
    <div className="small">
      {check.items.map((i) => <div key={i} className="warn">{CHECK_ITEMS[i] ?? i}</div>)}
      {check.transcript !== undefined && <div className="muted">音声の書き起こし: {check.transcript || '（なし）'}</div>}
    </div>
  );
}

// ---- the provider ----

/** The producer's studio: how to start without the producer role, the application until approved, then their studios. */
export function ProviderStudio() {
  const { api } = useSession();
  const me = useLoad(async () => (await api.GET('/api/publisher')).data, [api]);
  const producer = me.data?.roles?.includes('producer') ?? false;
  const studio = useLoad(async () => (await api.GET('/api/studio')).data, [api]);
  const s = studio.data;
  const [error, setError] = useState<string>();
  const start = async () => {
    if (!me.data) return;
    setError(undefined);
    try {
      await api.POST('/api/publisher/roles/producer', { params: { header: ifMatch(me.data.rev) } });
      me.reload();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <section>
      <h1>スタジオ</h1>
      <p className="muted">
        スタジオは、素材提供者が場所と期間を決めて載せるお知らせです。その場所に来たアプリの利用者に「〇〇からのお知らせです。」に続けて読み上げられます。
        AI の語りの材料にはならず、出した人の言葉のまま届きます。いつ・どう読み上げるかは利用者が使っているチャンネルが決めるので、チャンネルによっては読み上げられません。
      </p>
      <Status error={me.error ?? studio.error} loading={me.loading || studio.loading} />
      {me.data && !producer && s?.status === 'none' && (
        <div className="action">
          <p>スタジオを出せるのは素材提供者です。素材集を出していなくても、素材提供者として始めれば申し込めます。</p>
          <button onClick={() => void start()}>素材提供者として始める</button>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      )}
      {s && (
        <dl className="facts">
          <dt>承認</dt>
          <dd>
            <span className={`tag ${s.status}`}>{STUDIO_STATUS[s.status]}</span>{' '}
            {s.status === 'suspended' && <>（<Time value={s.suspendedUntil} /> まで）</>}
            {s.status === 'revoked' && <>（申し込み直せるのは <Time value={s.reapplyAfter} /> から）</>}
          </dd>
          {s.displayName && (<><dt>出す名前</dt><dd>{s.displayName}</dd></>)}
          {s.reason && (<><dt>運営からの理由</dt><dd>{s.reason}</dd></>)}
        </dl>
      )}
      {s && producer && (s.status === 'none' || s.status === 'declined' || (s.status === 'revoked' && s.reapplyAfter !== undefined && s.reapplyAfter <= new Date().toISOString())) && (
        <Application previous={s} onDone={studio.reload} />
      )}
      {s?.status === 'requested' && <p>運営が申し込みを確かめています。結果はメールでお知らせします。</p>}
      {s && s.status !== 'none' && s.status !== 'requested' && <Studios approved={s.status === 'approved'} />}
    </section>
  );
}

function Application({ previous, onDone }: { previous: Schemas['StudioAccount']; onDone: () => void }) {
  const { api } = useSession();
  const [displayName, setDisplayName] = useState(previous.displayName ?? '');
  const [description, setDescription] = useState(previous.description ?? '');
  const [plans, setPlans] = useState(previous.plans ?? '');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.POST('/api/studio/application', { body: { displayName, description, plans, agreedVersion: RULES_VERSION } });
      onDone();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <form className="action" onSubmit={(e) => void submit(e)}>
      <h3>スタジオを出す承認を申し込む</h3>
      <p className="muted small">運営が、本人であること・出す名前・載せたいものを確かめて承認します（目安 5 日。無料）。承認のあとは、スタジオごとの承認はなく、あなたの責任で載せます。</p>
      <label>
        出す名前（読み上げに使います。40 文字まで。個人は屋号・活動名でもかまいません）
        <input required maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label>
        どんな団体・人か、どこで活動しているか、本人確認の手がかり（公式サイト・公式 SNS など）
        <textarea required rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        どんなお知らせを、どの辺りで、どれくらいの頻度で載せたいか
        <textarea required rows={3} maxLength={1000} value={plans} onChange={(e) => setPlans(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span><a href={RULES_URL} target="_blank" rel="noreferrer">スタジオの決まり</a>（版 {RULES_VERSION}）を読み、守ることに同意します。中身の責任は自分が持ちます。</span>
      </label>
      <button disabled={!agreed}>申し込む</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function Studios({ approved }: { approved: boolean }) {
  const { api } = useSession();
  const list = useLoad(async () => (await api.GET('/api/studio/studios')).data, [api]);
  const [error, setError] = useState<string>();
  const act = async (p: Schemas['Studio'], action: 'submit' | 'stop' | 'appeal', message?: string) => {
    setError(undefined);
    try {
      await api.POST('/api/studio/studios/{studioId}/{action}', {
        params: { path: { studioId: p.studioId, action }, header: ifMatch(p.rev) },
        ...(message !== undefined ? { body: { message } } : {}),
      });
      list.reload();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <>
      <h2>スタジオ</h2>
      <Status error={list.error} loading={list.loading} />
      {list.data?.items.length === 0 && <Empty>まだスタジオがありません。</Empty>}
      {list.data?.items.map((p) => (
        <article key={p.studioId} className="card">
          <p>
            <span className={`tag ${p.state}`}>{STUDIO_STATE[p.state]}</span>{' '}
            {p.state === 'live' && p.endsAt <= new Date().toISOString() && <span className="tag">期間が終わった</span>} <span className="tag">{STUDIO_CATEGORIES[p.category]}</span> {p.text}
          </p>
          <dl className="facts">
            <dt>期間</dt>
            <dd><Time value={p.startsAt} /> 〜 <Time value={p.endsAt} />{p.hours && `（毎日 ${p.hours.from}〜${p.hours.to}）`}</dd>
            <dt>区画</dt>
            <dd>{p.cells.map((c) => <code key={c}>{c} </code>)}</dd>
            <dt>音声</dt>
            <dd>{p.audio?.durationSec !== undefined ? `${p.audio.durationSec} 秒` : p.audio ? 'あり' : 'なし'}</dd>
            {p.check && p.check.items.length > 0 && (<><dt>確認の結果</dt><dd><CheckResult check={p.check} /></dd></>)}
            {p.appeal && (<><dt>申し出</dt><dd><Time value={p.appeal.at} />: {p.appeal.message}</dd></>)}
            {p.decision && (<><dt>運営の判断</dt><dd><Time value={p.decision.at} />{p.decision.message && `: ${p.decision.message}`}</dd></>)}
          </dl>
          {p.state === 'live' && <button className="danger" onClick={() => window.confirm('このスタジオを止めますか？止めたスタジオは戻せません。') && void act(p, 'stop')}>止める</button>}
          {p.state === 'returned' && <Appeal onSubmit={(message) => act(p, 'appeal', message)} />}
          {(p.state === 'live' || p.state === 'stopped' || p.state === 'suspended' || p.state === 'removed') && <Stats studioId={p.studioId} />}
        </article>
      ))}
      <button onClick={() => list.reload()}>読み込み直す</button>
      {error && <p className="error" role="alert">{error}</p>}
      {approved ? <NewStudio onDone={list.reload} /> : <p className="muted">今は新しいスタジオを作れません。</p>}
    </>
  );
}

function Appeal({ onSubmit }: { onSubmit: (message: string) => Promise<void> }) {
  const [message, setMessage] = useState('');
  return (
    <form className="action" onSubmit={(e) => { e.preventDefault(); void onSubmit(message); }}>
      <p className="muted small">直すときは、新しいスタジオとして作り直してください。確認が誤っていると思うときは、運営に申し出られます（7 日以内に返事します）。</p>
      <label>
        運営への申し出
        <textarea required rows={2} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <button disabled={!message.trim()}>申し出る</button>
    </form>
  );
}

function NewStudio({ onDone }: { onDone: () => void }) {
  const { api } = useSession();
  const now = new Date();
  const [category, setCategory] = useState<StudioCategory | ''>('');
  const [text, setText] = useState('');
  const [cells, setCells] = useState<string[]>([]);
  const [startsAt, setStartsAt] = useState(jstInput(now));
  const [endsAt, setEndsAt] = useState(jstInput(new Date(now.getTime() + 2 * 24 * 3600_000)));
  const [useHours, setUseHours] = useState(false);
  const [from, setFrom] = useState('10:00');
  const [to, setTo] = useState('18:00');
  const [audio, setAudio] = useState<File>();
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (audio && audio.size > AUDIO_MAX_BYTES) return setError('音声は 512 KB までです');
    try {
      setProgress('スタジオを作っています…');
      const { data } = await api.POST('/api/studio/studios', {
        body: { category: category as StudioCategory, text, cells, startsAt: JST(startsAt), endsAt: JST(endsAt), ...(useHours ? { hours: { from, to } } : {}), ...(audio ? { audio: { bytes: audio.size } } : {}) },
      });
      if (!data) throw new Error('スタジオを作れませんでした');
      if (data.upload && audio) {
        setProgress('音声を送っています…');
        const form = new FormData();
        for (const [k, v] of Object.entries(data.upload.fields)) form.append(k, v);
        form.append('file', new Blob([await audio.arrayBuffer()], { type: 'audio/mp4' }));
        const res = await fetch(data.upload.url, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`音声を送れませんでした（${res.status}）`);
        await api.POST('/api/studio/studios/{studioId}/{action}', { params: { path: { studioId: data.studio.studioId, action: 'submit' }, header: ifMatch(data.studio.rev) } });
      }
      setProgress(`確認を始めました。${audio ? '音声を文字に起こすので、1〜2 分かかります。' : '数秒で終わります。'}「読み込み直す」で結果を確かめてください。`);
      setText('');
      setCells([]);
      setAudio(undefined);
      onDone();
    } catch (err) {
      setProgress(undefined);
      setError(describe(err));
    }
  };

  return (
    <form className="action wide" onSubmit={(e) => void submit(e)}>
      <h3>新しいスタジオ</h3>
      <p className="muted small">
        載せる前に、運営の AI が <a href={RULES_URL} target="_blank" rel="noreferrer">スタジオの決まり</a> の「載せないスタジオ」に当たらないかを確かめます（音声は文字に起こして確かめます）。
        当たらなければすぐに載ります。URL・電話番号は文字にも音声にも入れられません。場所と名前で探せるようにしてください。
      </p>
      <label>
        分類（中身に合うものを 1 つ。チャンネルが出すスタジオを選ぶのに使います。合わないと、載せる前の確認で返されます）
        <select required value={category} onChange={(e) => setCategory(e.target.value as StudioCategory)}>
          <option value="" disabled>選んでください</option>
          {Object.entries(STUDIO_CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>
        お知らせの文（200 文字まで。読み上げます）
        <textarea required rows={3} maxLength={200} value={text} onChange={(e) => setText(e.target.value.replace(/[\r\n]/g, ''))} />
      </label>
      <div>
        <div className="small">届ける区画（約 1.2 km × 0.6 km。9 つまで）</div>
        <CellMap value={cells} onChange={setCells} />
      </div>
      <label>
        始まり（日本時間。今から 30 日以内）
        <input type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
      </label>
      <label>
        終わり（始まりから 1〜30 日）
        <input type="datetime-local" required value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={useHours} onChange={(e) => setUseHours(e.target.checked)} />
        <span>読み上げる時間帯を決める</span>
      </label>
      {useHours && (
        <div className="cell-map-tools">
          <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} /> 〜 <input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      )}
      <label>
        音声（任意。M4A（AAC）、30 秒・512 KB まで。曲や他人の声は、使ってよいものだけ）
        <input type="file" accept=".m4a,audio/mp4,audio/x-m4a" onChange={(e) => setAudio(e.target.files?.[0])} />
      </label>
      <button disabled={!text.trim() || cells.length === 0 || (progress !== undefined && !progress.startsWith('確認'))}>載せる</button>
      {progress && <p role="status">{progress}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

// ---- the operator ----

/** Applications waiting, and appeals (スタジオの決まり 1.4・3). */
export function OperatorStudio() {
  const { api } = useSession();
  const apps = useLoad(async () => (await api.GET('/api/admin/studio/applications')).data, [api]);
  const appeals = useLoad(async () => (await api.GET('/api/admin/studio/appeals')).data, [api]);
  return (
    <section>
      <h1>スタジオ</h1>
      <p className="muted">
        運営はスタジオごとには承認しません。スタジオを出す素材提供者を確かめて承認し（<a href={RULES_URL} target="_blank" rel="noreferrer">スタジオの決まり</a> 1）、
        自動の確認の誤りの申し出に答えます（同 3）。素材提供者の承認を止める・取り消すのは、提供者の画面から行います。
      </p>
      <h2>承認の審査待ち</h2>
      <Status error={apps.error} loading={apps.loading} />
      {apps.data?.items.length === 0 && <Empty>ありません。</Empty>}
      {apps.data?.items.map((a) => <ApplicationReview key={a.publisherId} account={a} onDone={apps.reload} />)}
      <h2>申し出</h2>
      <Status error={appeals.error} loading={appeals.loading} />
      {appeals.data?.items.length === 0 && <Empty>ありません。</Empty>}
      {appeals.data?.items.map((p) => <AppealReview key={p.studioId} studio={p} onDone={appeals.reload} />)}
      <ReportedStudios />
      <ReportedNotes />
      <Bans />
      <ClosedAreas />
    </section>
  );
}

const CHECKS: [keyof Schemas['StudioChecks'], string][] = [
  ['identity', '1.3.1 本人確認ができる。名乗っている団体・人と申し込んだ人が同じ'],
  ['name', '1.3.2 出す名前が、ほかの団体・人と紛らわしくない'],
  ['content', '1.3.3 載せたいものが、主に「載せないスタジオ」に当たらない'],
  ['history', '1.3.4 過去にスタジオの承認を取り消されていない'],
];

function ApplicationReview({ account: a, onDone }: { account: Schemas['StudioAccount']; onDone: () => void }) {
  const { api } = useSession();
  const [checks, setChecks] = useState<Schemas['StudioChecks']>({ identity: false, name: false, content: false, history: false });
  const [error, setError] = useState<string>();
  const path = { publisherId: a.publisherId };
  const approve = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.POST('/api/admin/publishers/{publisherId}/studio/{decision}', { params: { path: { ...path, decision: 'approve' }, header: ifMatch(a.rev) }, body: { checks } });
      onDone();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <article className="card">
      <dl className="facts">
        <dt>素材提供者</dt>
        <dd><Link to={`/publishers/${a.publisherId}`}>{a.publisherId}</Link></dd>
        <dt>出す名前</dt>
        <dd>{a.displayName}</dd>
        <dt>団体・人</dt>
        <dd>{a.description}</dd>
        <dt>載せたいもの</dt>
        <dd>{a.plans}</dd>
        <dt>申し込み</dt>
        <dd><Time value={a.requestedAt} />（スタジオの決まり 版 {a.agreedVersion} に同意）</dd>
      </dl>
      <form className="action" onSubmit={(e) => void approve(e)}>
        <h3>確かめて承認する</h3>
        {CHECKS.map(([key, label]) => (
          <label key={key} className="check">
            <input type="checkbox" checked={checks[key]} onChange={(e) => setChecks({ ...checks, [key]: e.target.checked })} />
            <span>{label}</span>
          </label>
        ))}
        <button disabled={!CHECKS.every(([k]) => checks[k])}>承認する</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      <ReasonForm
        label="見送る"
        submit={async (reason) => {
          await api.POST('/api/admin/publishers/{publisherId}/studio/{decision}', { params: { path: { ...path, decision: 'decline' }, header: ifMatch(a.rev) }, body: { reason } });
          onDone();
        }}
      >
        <p className="muted">理由（スタジオの決まりの項目番号を付ける）は提供者にメールで伝わります。直せるものは、直して申し込み直せます。</p>
      </ReasonForm>
    </article>
  );
}

function AppealReview({ studio: p, onDone }: { studio: Schemas['Studio']; onDone: () => void }) {
  const { api } = useSession();
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string>();
  const path = { studioId: p.studioId };
  const publish = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.POST('/api/admin/studio/studios/{studioId}/{decision}', { params: { path: { ...path, decision: 'publish' }, header: ifMatch(p.rev) }, body: message ? { message } : {} });
      onDone();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <article className="card">
      <p><span className="tag">{STUDIO_CATEGORIES[p.category]}</span> {p.text}</p>
      <dl className="facts">
        <dt>素材提供者</dt>
        <dd><Link to={`/publishers/${p.publisherId}`}>{p.providerName}</Link></dd>
        <dt>期間・区画</dt>
        <dd><Time value={p.startsAt} /> 〜 <Time value={p.endsAt} />、{p.cells.join(' ')}</dd>
        <dt>確認の結果</dt>
        <dd><CheckResult check={p.check} /></dd>
        <dt>申し出</dt>
        <dd>{p.appeal && <><Time value={p.appeal.at} />: {p.appeal.message}</>}</dd>
      </dl>
      <form className="action" onSubmit={(e) => void publish(e)}>
        <h3>確かめて載せる</h3>
        <label>
          素材提供者へのメッセージ（任意）
          <input maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <button>載せる</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      <ReasonForm
        label="載せない"
        danger
        submit={async (reason) => {
          await api.POST('/api/admin/studio/studios/{studioId}/{decision}', { params: { path: { ...path, decision: 'reject' }, header: ifMatch(p.rev) }, body: { message: reason } });
          onDone();
        }}
      >
        <p className="muted">理由は素材提供者にメールで伝わります。AI の指摘だけで載せないと決めないでください。</p>
      </ReasonForm>
    </article>
  );
}

/** The studio approval on a provider's page: stop for a while, resume, or revoke (スタジオの決まり 4.3). */
export function PublisherStudioAdmin({ publisherId }: { publisherId: string }) {
  const { api } = useSession();
  const studio = useLoad(async () => (await api.GET('/api/admin/publishers/{publisherId}/studio', { params: { path: { publisherId } } })).data, [api, publisherId]);
  const [until, setUntil] = useState(jstInput(new Date(Date.now() + 31 * 24 * 3600_000)).slice(0, 10));
  const s = studio.data;
  const decide = async (decision: 'suspend' | 'resume' | 'revoke', body: Schemas['StudioDecision'] = {}) => {
    if (!s) return;
    await api.POST('/api/admin/publishers/{publisherId}/studio/{decision}', { params: { path: { publisherId, decision }, header: ifMatch(s.rev) }, body });
    studio.reload();
  };
  return (
    <>
      <h2>スタジオ</h2>
      <Status error={studio.error} loading={studio.loading} />
      {s && (
        <dl className="facts">
          <dt>承認</dt>
          <dd>
            <span className={`tag ${s.status}`}>{STUDIO_STATUS[s.status]}</span>{' '}
            {s.status === 'suspended' && <>（<Time value={s.suspendedUntil} /> まで）</>}
            {s.status === 'revoked' && <>（申し込み直せるのは <Time value={s.reapplyAfter} /> から）</>}
          </dd>
          {s.displayName && (<><dt>出す名前</dt><dd>{s.displayName}</dd></>)}
          {s.reason && (<><dt>理由</dt><dd>{s.reason}</dd></>)}
          {s.decidedAt && (<><dt>決めた日</dt><dd><Time value={s.decidedAt} /></dd></>)}
        </dl>
      )}
      {s?.status === 'approved' && (
        <ReasonForm label="期間を決めて止める" danger submit={(reason) => decide('suspend', { reason, until: JST(`${until}T00:00`) })}>
          <p className="muted">軽い違反を直さない・繰り返すとき（スタジオの決まり 4.3）。載っているスタジオも届けなくなります。</p>
          <label>
            いつまで（1〜3 か月先）
            <input type="date" required value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        </ReasonForm>
      )}
      {s?.status === 'suspended' && <button onClick={() => void decide('resume').catch(() => studio.reload())}>止めたのを戻す</button>}
      {(s?.status === 'approved' || s?.status === 'suspended') && (
        <ReasonForm label="承認を取り消す" danger submit={(reason) => decide('revoke', { reason })}>
          <p className="muted">重い違反・なりすまし・権利侵害の繰り返しのとき（スタジオの決まり 4.3）。載っているスタジオを消し、申し込み直しは 1 年後からです。</p>
        </ReasonForm>
      )}
    </>
  );
}

// ---- after things are up (K-17, K-18) ----

const REASON: Record<string, string> = {
  danger: '安全を損なう', harassment: '人を傷つける・つきまとい', ad: '宣伝・勧誘', rights: '権利の侵害', inappropriate: '聞かせるのに合わない', other: 'そのほか',
};
const reasons = (list: string[]) => list.map((r) => REASON[r] ?? r).join('・');
const count = (a: Schemas['Approx']) => (a ? `${a.atLeast} 人以上` : '3 人未満');

/** The provider's day counts of a studio, as approximate numbers (K-18). */
function Stats({ studioId }: { studioId: string }) {
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const stats = useLoad(async () => (open ? (await api.GET('/api/studio/studios/{studioId}/stats', { params: { path: { studioId } } })).data : undefined), [api, studioId, open]);
  if (!open) return <button className="link" onClick={() => setOpen(true)}>聞いた数を見る</button>;
  const s = stats.data;
  return (
    <div className="small">
      <Status error={stats.error} loading={stats.loading} />
      {s && (
        <>
          <p>合計: 聞いた {count(s.total.heard)}、開いた {count(s.total.opened)}（少ない数は、聞いた人の居場所の手がかりになるので出しません）</p>
          {s.days.length > 0 && (
            <table>
              <thead><tr><th>日</th><th>聞いた</th><th>開いた</th></tr></thead>
              <tbody>{s.days.map((d) => <tr key={d.date}><td>{d.date}</td><td>{count(d.heard)}</td><td>{count(d.opened)}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function ReportedStudios() {
  const { api } = useSession();
  const list = useLoad(async () => (await api.GET('/api/admin/studio/reported-studios')).data, [api]);
  const [error, setError] = useState<string>();
  const decide = async (p: Schemas['Studio'], decision: 'restore' | 'remove', reason?: string) => {
    setError(undefined);
    try {
      await api.POST('/api/admin/studio/studios/{studioId}/{decision}', { params: { path: { studioId: p.studioId, decision }, header: ifMatch(p.rev) }, body: reason ? { reason } : {} });
      list.reload();
    } catch (err) {
      setError(describe(err));
      throw err;
    }
  };
  return (
    <>
      <h2>通報されたスタジオ</h2>
      <p className="muted small">3 台以上から、または「安全」「権利」で通報されたスタジオは、届けるのを止めています（スタジオの決まり 4.1）。判断の目安は、重いもの 24 時間・軽いもの 7 日です。</p>
      <Status error={list.error} loading={list.loading} />
      {list.data?.items.length === 0 && <Empty>ありません。</Empty>}
      {list.data?.items.map(({ studio: p, reports, reasons: rs, firstAt }) => (
        <article key={p.studioId} className="card">
          <p><span className={`tag ${p.state}`}>{STUDIO_STATE[p.state]}</span> {p.text}</p>
          <dl className="facts">
            <dt>素材提供者</dt>
            <dd><Link to={`/publishers/${p.publisherId}`}>{p.providerName}</Link></dd>
            <dt>通報</dt>
            <dd>{reports} 台（{reasons(rs)}）、最初の通報 <Time value={firstAt} /></dd>
            <dt>期間・区画</dt>
            <dd><Time value={p.startsAt} /> 〜 <Time value={p.endsAt} />、{p.cells.join(' ')}</dd>
            {p.check?.transcript !== undefined && (<><dt>音声の書き起こし</dt><dd>{p.check.transcript}</dd></>)}
          </dl>
          <button onClick={() => void decide(p, 'restore').catch(() => undefined)}>{p.state === 'suspended' ? '問題なし（戻す）' : '問題なし'}</button>
          <ReasonForm label="消す" danger submit={(reason) => decide(p, 'remove', reason)}>
            <p className="muted">理由（スタジオの決まりの項目番号）は素材提供者にメールで伝わります。繰り返すときは、提供者の画面で承認を止める・取り消すも考えてください。</p>
          </ReasonForm>
        </article>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

function ReportedNotes() {
  const { api } = useSession();
  const list = useLoad(async () => (await api.GET('/api/admin/studio/reported-notes')).data, [api]);
  const [ban, setBan] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const decide = async (noteId: string, decision: 'restore' | 'remove', reason?: string) => {
    setError(undefined);
    const days = ban[noteId] ?? '';
    try {
      await api.POST('/api/admin/studio/notes/{noteId}/{decision}', {
        params: { path: { noteId, decision } },
        body: { ...(reason ? { reason } : {}), ...(decision === 'remove' && days !== '' ? { ban: days === 'forever' ? {} : { days: Number(days) } } : {}) },
      });
      list.reload();
    } catch (err) {
      setError(describe(err));
      throw err;
    }
  };
  return (
    <>
      <h2>通報された一言</h2>
      <p className="muted small">3 台以上から通報された一言は、だれにも届けていません（隠している）。置いた端末は運営にも分かりません。消すと本文も消え、置いた端末を締め出せます。</p>
      <Status error={list.error} loading={list.loading} />
      {list.data?.items.length === 0 && <Empty>ありません。</Empty>}
      {list.data?.items.map((n) => (
        <article key={n.noteId} className="card">
          <p><span className={`tag ${n.state === 'hidden' ? 'suspended' : n.state}`}>{n.state === 'hidden' ? '隠している' : n.state}</span> {n.text ?? <span className="muted">（本文なし）</span>}</p>
          <dl className="facts">
            <dt>場所</dt>
            <dd><code>{n.cell}</code> {n.spotName}</dd>
            <dt>通報</dt>
            <dd>{n.reports} 台（{reasons(n.reasons)}）、最初の通報 <Time value={n.firstAt} /></dd>
            <dt>置いた・期限</dt>
            <dd><Time value={n.createdAt} /> 〜 <Time value={n.expiresAt} /></dd>
          </dl>
          {n.state === 'hidden' && <button onClick={() => void decide(n.noteId, 'restore').catch(() => undefined)}>問題なし（戻す）</button>}
          <ReasonForm label="消す" danger submit={(reason) => decide(n.noteId, 'remove', reason)}>
            <label>
              置いた端末の締め出し
              <select value={ban[n.noteId] ?? ''} onChange={(e) => setBan({ ...ban, [n.noteId]: e.target.value })}>
                <option value="">締め出さない</option>
                <option value="7">7 日</option>
                <option value="30">30 日</option>
                <option value="90">90 日</option>
                <option value="forever">期限なし</option>
              </select>
            </label>
          </ReasonForm>
        </article>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

function Bans() {
  const { api } = useSession();
  const list = useLoad(async () => (await api.GET('/api/admin/studio/bans')).data, [api]);
  const [error, setError] = useState<string>();
  const lift = async (noteId: string) => {
    if (!window.confirm('締め出しを解きますか？')) return;
    setError(undefined);
    try {
      await api.DELETE('/api/admin/studio/bans/{noteId}', { params: { path: { noteId } } });
      list.reload();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <>
      <h2>締め出し</h2>
      <p className="muted small">もとの一言で示します。アプリを入れ直すと別の端末として扱われる点に注意してください。</p>
      <Status error={list.error} loading={list.loading} />
      {list.data?.items.length === 0 && <Empty>ありません。</Empty>}
      {list.data && list.data.items.length > 0 && (
        <table>
          <thead><tr><th>もとの一言</th><th>理由</th><th>締め出した</th><th>期限</th><th></th></tr></thead>
          <tbody>
            {list.data.items.map((b) => (
              <tr key={b.noteId}>
                <td><code>{b.noteId}</code></td>
                <td>{b.reason}</td>
                <td><Time value={b.createdAt} /></td>
                <td>{b.until ? <Time value={b.until} /> : '期限なし'}</td>
                <td><button className="link" onClick={() => void lift(b.noteId)}>解く</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

function ClosedAreas() {
  const { api } = useSession();
  const list = useLoad(async () => (await api.GET('/api/admin/studio/areas')).data, [api]);
  const [cell, setCell] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const close = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.POST('/api/admin/studio/areas', { body: { cell, reason } });
      setCell('');
      setReason('');
      list.reload();
    } catch (err) {
      setError(describe(err));
    }
  };
  const open = async (c: string) => {
    setError(undefined);
    try {
      await api.DELETE('/api/admin/studio/areas/{cell}', { params: { path: { cell: c } } });
      list.reload();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <>
      <h2>置けない区画</h2>
      <p className="muted small">学校・病院・私有地の周りなど。一言は置けず、スタジオもその区画を選べなくなります（アプリには 5 分以内に効きます）。区画は geohash の 5〜7 文字（5 文字は約 5 km 四方、6 文字は約 1.2 km × 0.6 km、7 文字は約 150 m 四方）。</p>
      <Status error={list.error} loading={list.loading} />
      {list.data?.items.length === 0 && <Empty>ありません。</Empty>}
      <ul className="plain">
        {list.data?.items.map((a) => (
          <li key={a.cell}><code>{a.cell}</code> {a.reason} <span className="muted small"><Time value={a.createdAt} /></span> <button className="link" onClick={() => void open(a.cell)}>外す</button></li>
        ))}
      </ul>
      <form className="action" onSubmit={(e) => void close(e)}>
        <label>
          区画（geohash 5〜7 文字）
          <input required pattern="[0-9b-hjkmnp-z]{5,7}" value={cell} onChange={(e) => setCell(e.target.value.trim().toLowerCase())} />
        </label>
        <label>
          理由
          <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button>置けないようにする</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </>
  );
}
