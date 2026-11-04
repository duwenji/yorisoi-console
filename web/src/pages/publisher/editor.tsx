import type { Schemas } from '@yorisoi-console/api-types';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { describe, ifMatch } from '../../api';
import { check, imageFormat } from '../../editor/check';
import { blankChannel, blankCollection, fromPackage, packageZip, packDraft, unpackDraft, type Draft, type Kind, type Listing } from '../../editor/draft';
import { deleteDraft, download, loadDraft, saveDraft } from '../../editor/draft-api';
import { useSession } from '../../main';
import { openKeyFile, signCollectionPackage, signPackage } from '../../publisher-crypto';
import { Status, Time, useLoad } from '../common';
import { PreReview, reviewFiles } from '../pre-review';
import { ValidationView } from '../validation';
import { STATE, upload } from './channels';
import { Cues, Declarations } from './editor-cues';
import { ChannelBasics, ChannelPrompts, ChannelTalk, CollectionBasics, OtherFields, TextField } from './editor-fields';
import { Resources } from './editor-resources';

// DES-014: making a channel or a collection on the screen. The draft is kept by the console
// (R-4); it is checked here as it is typed (R-9), by the machine review once saved (R-16), and
// signed and submitted from here as before (R-1).

const CHANNEL_KEYS = ['format', 'id', 'version', 'publisher', 'name', 'summary', 'lang', 'activities', 'genres', 'requires', 'greeting', 'talk', 'spots', 'guide', 'mood', 'resources', 'collections', 'cues'] as const;
const COLLECTION_KEYS = ['format', 'id', 'version', 'producer', 'name', 'summary', 'lang', 'grants', 'resources'] as const;
const CHECK_POLL_MS = 5000;

export const ChannelEditor = () => <Editor kind="channel" />;
export const CollectionEditor = () => <Editor kind="collection" />;

type Target = Schemas['Channel'] | Schemas['Collection'];

function Editor({ kind }: { kind: Kind }) {
  const { api, auth } = useSession();
  const params = useParams();
  const id = (kind === 'channel' ? params.channelId : params.collectionId) ?? '';
  const what = kind === 'channel' ? 'チャンネル' : '素材集';
  const back = kind === 'channel' ? `/channels/${id}` : `/collections/${id}`;

  const target = useLoad<Target>(
    async () => (kind === 'channel'
      ? (await api.GET('/api/channels/{channelId}', { params: { path: { channelId: id } } })).data
      : (await api.GET('/api/collections/{collectionId}', { params: { path: { collectionId: id } } })).data),
    [api, kind, id],
  );
  const reloadTarget = target.reload;
  const me = useLoad(async () => (await api.GET('/api/publisher')).data, [api]);
  const accountId = me.data?.activeAccountId ?? undefined;
  const latest = target.data?.latestApproved?.version;

  /** undefined while loading; null when there is no saved draft yet. */
  const [saved, setSaved] = useState<{ rev: number } | null>();
  const [draft, setDraft] = useState<Draft>();
  const [dirty, setDirty] = useState(false);
  const [summary, setSummary] = useState<Schemas['Draft'] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    loadDraft(auth, kind, id).then(
      (stored) => {
        if (!stored) return setSaved(null);
        setDraft(unpackDraft(stored.zip, kind));
        setSaved({ rev: stored.rev });
      },
      (e: unknown) => setError(describe(e)),
    );
  }, [auth, kind, id]);
  useEffect(() => setSummary(target.data?.draft ?? null), [target.data]);

  // While the machine review runs, read the summary again until it is done (R-18).
  useEffect(() => {
    if (summary?.check?.state !== 'running') return;
    const timer = setTimeout(reloadTarget, CHECK_POLL_MS);
    return () => clearTimeout(timer);
  }, [summary, reloadTarget]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const edit = useCallback((next: Draft) => { setDraft(next); setDirty(true); setNotice(undefined); }, []);
  const problems = useMemo(() => (draft ? check(draft, { id, accountId, latestApprovedVersion: latest }) : []), [draft, id, accountId, latest]);

  const save = async () => {
    if (!draft) return;
    setError(undefined);
    try {
      const out = await saveDraft(auth, kind, id, packDraft(draft), saved?.rev);
      setSaved({ rev: out.rev });
      setSummary(out);
      setDirty(false);
      setNotice('保存しました。');
    } catch (e) {
      setError(describe(e));
    }
  };
  const start = (d: Draft) => {
    setDraft(d);
    setDirty(true);
    setStarting(false);
    setNotice('まだ保存していません。「保存する」で管理システムに残ります。');
  };
  const remove = async () => {
    if (!saved || !window.confirm('下書きを消してよろしいですか？（元に戻せません）')) return;
    try {
      await deleteDraft(auth, kind, id, saved.rev);
      setSaved(null);
      setDraft(undefined);
      setDirty(false);
      setSummary(null);
    } catch (e) {
      setError(describe(e));
    }
  };
  const exportZip = () => {
    if (!draft) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([new Uint8Array(packageZip(draft))], { type: 'application/zip' }));
    a.download = `${id}-v${String(draft.manifest.version)}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (target.error || me.error) return <Status error={target.error ?? me.error} />;
  if (saved === undefined || !target.data) return <Status error={error} loading />;

  return (
    <section className="editor">
      <p><Link to={back}>← {what}の詳細</Link></p>
      <h1><code>{id}</code> の{what}を編集する</h1>
      {(!draft || starting) && (
        <StartFrom kind={kind} id={id} accountId={accountId} latest={latest} replacing={!!draft} onStart={start} onCancel={() => setStarting(false)} />
      )}
      {draft && !starting && (
        <>
          <div className="save-bar">
            <button onClick={() => void save()} disabled={!dirty || target.data.status !== 'active'}>保存する</button>
            <span className="small">
              {dirty ? <span className="warn">保存していない変更があります</span> : saved ? <>保存済み（{summary && <Time value={summary.updatedAt} />}）</> : null}
              {summary && <span className="muted">。最後の保存から 180 日で消えます（<Time value={summary.expiresAt} />）</span>}
            </span>
            <span className={`small ${problems.length ? 'error' : 'muted'}`}>{problems.length ? `直すところ ${problems.length} 件` : '画面の確認では問題なし'}</span>
            <button type="button" className="link" onClick={exportZip}>ZIP を書き出す</button>
            <button type="button" className="link" onClick={() => setStarting(true)}>別のものから始め直す</button>
            {saved && <button type="button" className="link" onClick={() => void remove()}>下書きを消す</button>}
          </div>
          {target.data.status !== 'active' && <p className="error">取り下げられた{what}の下書きは保存できません（読み込み・書き出し・削除はできます）。</p>}
          {notice && <p role="status">{notice}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <nav className="editor-nav small">
            {(kind === 'channel' ? ['基本', '話し方', 'プロンプト', '素材', 'きっかけ', '素材集', 'そのほか', '確かめる', '申請'] : ['基本', '素材', 'そのほか', '確かめる', '申請']).map((s) => (
              <a key={s} href={`#${s}`}>{s}</a>
            ))}
          </nav>
          <h2 id="基本">基本</h2>
          {kind === 'channel' ? <ChannelBasics d={draft} edit={edit} accountId={accountId} latest={latest} /> : <CollectionBasics d={draft} edit={edit} accountId={accountId} latest={latest} />}
          {kind === 'channel' && (
            <>
              <h2 id="話し方">話し方</h2>
              <ChannelTalk d={draft} edit={edit} />
              <h2 id="プロンプト">プロンプト</h2>
              <ChannelPrompts d={draft} edit={edit} />
            </>
          )}
          <h2 id="素材">素材</h2>
          <Resources d={draft} edit={edit} inCollection={kind === 'collection'} />
          {kind === 'channel' && (
            <>
              <h2 id="きっかけ">きっかけ</h2>
              <Cues d={draft} edit={edit} />
              <h2 id="素材集">使う素材集</h2>
              <Declarations d={draft} edit={edit} />
            </>
          )}
          <h2 id="そのほか">そのほかの項目</h2>
          <OtherFields d={draft} edit={edit} formKeys={kind === 'channel' ? CHANNEL_KEYS : COLLECTION_KEYS} />

          <h2 id="確かめる">確かめる</h2>
          <Problems problems={problems} />
          <DraftCheck kind={kind} id={id} summary={summary} dirty={dirty} saved={saved} onStarted={setSummary} />

          <h2 id="申請">申請</h2>
          <Submit kind={kind} id={id} draft={draft} edit={edit} problems={problems.length} onSubmitted={() => target.reload()} />
        </>
      )}
    </section>
  );
}

function Problems({ problems }: { problems: ReturnType<typeof check> }) {
  if (problems.length === 0) return <p className="muted">画面で確かめられる決まりには合っています。素材集の参照・利用許諾・外部の素材の中身などは、下の「機械審査にかける」で確かめます。</p>;
  return (
    <>
      <p className="error">申請の前に直すところがあります（{problems.length} 件）。保存はできます。</p>
      <ul className="small">{problems.slice(0, 100).map((p, i) => <li key={i}><strong>{p.where}</strong>: {p.message}</li>)}</ul>
    </>
  );
}

/** The machine review of the saved draft (R-16〜R-20). */
function DraftCheck({ kind, id, summary, dirty, saved, onStarted }: {
  kind: Kind; id: string; summary: Schemas['Draft'] | null; dirty: boolean; saved: { rev: number } | null; onStarted: (d: Schemas['Draft']) => void;
}) {
  const { api } = useSession();
  const [error, setError] = useState<string>();
  const check = summary?.check;
  const run = async () => {
    if (!saved) return;
    setError(undefined);
    try {
      const out = kind === 'channel'
        ? (await api.POST('/api/channels/{channelId}/draft/check', { params: { path: { channelId: id }, header: ifMatch(saved.rev) } })).data
        : (await api.POST('/api/collections/{collectionId}/draft/check', { params: { path: { collectionId: id }, header: ifMatch(saved.rev) } })).data;
      if (out) onStarted(out);
    } catch (e) {
      setError(describe(e));
    }
  };
  return (
    <div className="action">
      <h3>機械審査にかける</h3>
      <p className="small muted">
        保存した下書きを、申請と同じ機械審査にかけます（署名だけは確かめません）。申請の 1 日の数は使いません（1 日 50 回まで）。
        {kind === 'collection' && ' 外部の素材を読みに行くので、数十秒〜数分かかります。'}
      </p>
      <button type="button" disabled={!saved || dirty || check?.state === 'running'} onClick={() => void run()}>機械審査にかける</button>
      {dirty && <span className="small muted"> 保存してからかけられます</span>}
      {check?.state === 'running' && <p role="status">確かめています…（<Time value={check.startedAt} /> に開始）</p>}
      {check?.state === 'done' && (
        <div>
          <p className="small">
            <Time value={check.checkedAt} /> の結果
            {(check.rev !== summary?.rev || dirty) && <span className="warn">（このあとの変更は確かめていません）</span>}
          </p>
          <ValidationView validation={check.validation} />
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

/** Signs the draft's package in the browser and submits it as the ZIP form does (DES-003, R-1). */
function Submit({ kind, id, draft, edit, problems, onSubmitted }: { kind: Kind; id: string; draft: Draft; edit: (d: Draft) => void; problems: number; onSubmitted: () => void }) {
  const { api } = useSession();
  const [keyText, setKeyText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const listing = draft.listing;
  const setListing = (patch: Partial<Listing>) => {
    const next = { ...listing, ...patch };
    for (const k of Object.keys(next) as (keyof Listing)[]) if (next[k] === '' || (Array.isArray(next[k]) && (next[k] as string[]).length === 0)) delete next[k];
    edit({ ...draft, listing: next });
  };
  const split = (s: string) => s.split(/[,\s、]+/).filter(Boolean);
  const pickIcon = async (f: File | undefined) => {
    setError(undefined);
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (imageFormat(bytes) !== 'png' || bytes.length > 100 * 1024) return setError('アイコンは PNG で 100KB 以下にしてください（256×256 以下）');
    edit({ ...draft, icon: bytes });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      setProgress('鍵を開いています…');
      const key = await openKeyFile(keyText, passphrase);
      setProgress('パッケージに署名しています…');
      const pkg = packageZip(draft);
      const signed = kind === 'channel' ? await signPackage(pkg, key, { channel: id }) : await signCollectionPackage(pkg, key, { collection: id });
      if (signed.zip.length > 2 * 1024 * 1024) throw new Error('署名したパッケージが 2MB を超えています');
      setProgress('申請を作っています…');
      if (kind === 'channel') {
        const { data } = await api.POST('/api/channels/{channelId}/submissions', {
          params: { path: { channelId: id } },
          body: {
            ...(listing.description ? { description: listing.description } : {}), ...(listing.tags?.length ? { tags: listing.tags } : {}),
            ...(listing.regions?.length ? { regions: listing.regions } : {}), ...(listing.note ? { note: listing.note } : {}),
          },
        });
        if (!data) throw new Error('申請を作れませんでした');
        setProgress('パッケージを送っています…');
        await upload(data.uploads.package, new Blob([new Uint8Array(signed.zip)], { type: 'application/zip' }));
        setProgress('アイコンを送っています…');
        await upload(data.uploads.icon, new Blob([new Uint8Array(draft.icon!)], { type: 'image/png' }));
      } else {
        const { data } = await api.POST('/api/collections/{collectionId}/submissions', { params: { path: { collectionId: id } }, body: { ...(listing.note ? { note: listing.note } : {}) } });
        if (!data) throw new Error('申請を作れませんでした');
        setProgress('パッケージを送っています…');
        await upload(data.uploads.package, new Blob([new Uint8Array(signed.zip)], { type: 'application/zip' }));
      }
      setProgress(`版 ${signed.version} を申請しました。結果は${kind === 'channel' ? 'チャンネル' : '素材集'}の詳細の「申請」に出ます。下書きは残るので、次の版もここから作れます。`);
      setPassphrase('');
      onSubmitted();
    } catch (err) {
      setProgress(undefined);
      setError(describe(err));
    }
  };
  const ready = problems === 0 && (kind === 'collection' || !!draft.icon);
  return (
    <>
      <form className="action" onSubmit={(e) => void submit(e)}>
        <h3>署名して申請する</h3>
        {kind === 'channel' && (
          <>
            <label>
              アイコン（PNG、256×256 以下、100KB 以下。下書きに入ります）
              <input type="file" accept="image/png" onChange={(e) => void pickIcon(e.target.files?.[0])} />
              {draft.icon ? <span className="small muted">選んであります（{Math.ceil(draft.icon.length / 1024)}KB）</span> : <span className="small error">まだありません</span>}
            </label>
            <TextField label="説明（アプリの一覧に出ます）" rows={3} max={1000} value={listing.description ?? ''} onChange={(v) => setListing({ description: v })} />
            <TextField label="タグ（英小文字・数字・ハイフン、8 個まで、空白か読点で区切る）" value={(listing.tags ?? []).join(' ')} onChange={(v) => setListing({ tags: split(v) })} />
            <TextField label="地域（geohash の接頭辞、8 個まで。空欄はどこでも）" value={(listing.regions ?? []).join(' ')} onChange={(v) => setListing({ regions: split(v) })} />
          </>
        )}
        <TextField label={kind === 'channel' ? '運営への説明（審査のときに読まれます）' : '運営への説明（素材の権利・出どころなど）'} rows={2} max={2000} value={listing.note ?? ''} onChange={(v) => setListing({ note: v })} />
        <label>
          鍵のファイル
          <input type="file" accept="application/json,.json" onChange={(e) => void e.target.files?.[0]?.text().then(setKeyText)} />
        </label>
        <label>
          合言葉
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        <button disabled={!ready || !keyText || !passphrase || (progress !== undefined && !progress.startsWith('版'))}>署名して申請する</button>
        {!ready && <span className="small muted">{problems ? '「確かめる」の直すところを直してから申請できます。' : 'アイコンを選んでから申請できます。'}</span>}
        {progress && <p role="status">{progress}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      <PreReview kind={kind} who="provider" load={async () => reviewFiles(packageZip(draft))} />
    </>
  );
}

/** How a draft starts (DES-014「始め方」): blank, from one's own submission, or from a local ZIP. */
function StartFrom({ kind, id, accountId, latest, replacing, onStart, onCancel }: {
  kind: Kind; id: string; accountId?: string | undefined; latest?: number | undefined; replacing: boolean; onStart: (d: Draft) => void; onCancel: () => void;
}) {
  const { api } = useSession();
  const [error, setError] = useState<string>();
  const subs = useLoad(
    async () => (kind === 'channel'
      ? (await api.GET('/api/channels/{channelId}/submissions', { params: { path: { channelId: id }, query: { limit: 20 } } })).data
      : (await api.GET('/api/collections/{collectionId}/submissions', { params: { path: { collectionId: id }, query: { limit: 20 } } })).data),
    [api, kind, id],
  );
  const next = (latest ?? 0) + 1;
  const confirmed = () => !replacing || window.confirm('今の下書きを置き換えます。よろしいですか？（保存するまでは元の下書きが残ります）');
  /** A package's version is moved past the approved one, and its owner set to this account. */
  const adopt = (d: Draft): Draft => {
    const version = typeof d.manifest.version === 'number' && d.manifest.version > (latest ?? 0) ? d.manifest.version : next;
    const owner = kind === 'channel' ? 'publisher' : 'producer';
    return { ...d, manifest: { ...d.manifest, version, ...(accountId ? { [owner]: accountId } : {}) } };
  };
  const fromSubmission = async (s: { submissionId: string; description?: string; tags?: string[]; regions?: string[]; note?: string }) => {
    setError(undefined);
    if (!confirmed()) return;
    try {
      const urls = kind === 'channel'
        ? (await api.GET('/api/channels/{channelId}/submissions/{submissionId}/package', { params: { path: { channelId: id, submissionId: s.submissionId } } })).data
        : (await api.GET('/api/collections/{collectionId}/submissions/{submissionId}/package', { params: { path: { collectionId: id, submissionId: s.submissionId } } })).data;
      if (!urls) throw new Error('パッケージを取得できませんでした');
      const iconUrl = (urls as { iconUrl?: string | null }).iconUrl;
      const icon = iconUrl ? await download(iconUrl) : undefined;
      const listing: Listing = {
        ...(s.description ? { description: s.description } : {}), ...(s.tags?.length ? { tags: s.tags } : {}),
        ...(s.regions?.length ? { regions: s.regions } : {}), ...(s.note ? { note: s.note } : {}),
      };
      onStart(adopt(fromPackage(await download(urls.packageUrl), kind, { listing, ...(icon ? { icon } : {}) })));
    } catch (e) {
      setError(describe(e));
    }
  };
  const fromFile = async (f: File | undefined) => {
    setError(undefined);
    if (!f || !confirmed()) return;
    try {
      onStart(adopt(fromPackage(new Uint8Array(await f.arrayBuffer()), kind)));
    } catch (e) {
      setError(describe(e));
    }
  };
  const blank = () => {
    if (!confirmed()) return;
    onStart(kind === 'channel' ? blankChannel(id, accountId ?? '', next) : blankCollection(id, accountId ?? '', next));
  };
  const usable = (subs.data?.items ?? []).filter((s) => !['uploading', 'expired', 'validating'].includes(s.state));
  return (
    <div className="action wide">
      <h3>{replacing ? '別のものから始め直す' : '下書きを始める'}</h3>
      {!accountId && <p className="warn">先に「鍵」で鍵を紐づけてください（パッケージにアカウントIDを書きます）。</p>}
      <p><button type="button" onClick={blank}>空から始める</button> <span className="small muted">必須の項目に既定の値を入れます（版 {next}）</span></p>
      <h4>自分の申請から</h4>
      <Status error={subs.error} loading={subs.loading} />
      {usable.length === 0 && !subs.loading && <p className="small muted">使える申請はありません。</p>}
      <ul className="plain">
        {usable.map((s) => (
          <li key={s.submissionId}>
            版 {s.version ?? '—'} <span className={`tag ${s.state}`}>{STATE[s.state] ?? s.state}</span> <Time value={s.createdAt} />{' '}
            <button type="button" className="link" onClick={() => void fromSubmission(s)}>これから始める</button>
          </li>
        ))}
      </ul>
      <p className="small muted">承認された版はいつでも、そのほかの申請は結果が出てから 90 日まで使えます。</p>
      <h4>手元の ZIP から</h4>
      <label>
        署名の前・後どちらの ZIP でも（<code>signature.json</code> は捨てます）
        <input type="file" accept=".zip,application/zip" onChange={(e) => void fromFile(e.target.files?.[0])} />
      </label>
      {replacing && <button type="button" className="link" onClick={onCancel}>やめて編集に戻る</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
