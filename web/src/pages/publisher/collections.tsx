import { Fragment, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { describe, ifMatch } from '../../api';
import { useSession } from '../../main';
import { openKeyFile, signCollectionPackage } from '../../publisher-crypto';
import { Empty, Status, Time, useLoad } from '../common';
import { PreReview, reviewFiles } from '../pre-review';
import { StageNote, ValidationView } from '../validation';

// The producer's pages (DES-010 N-1〜N-3): collections, their submissions, and who uses them.

const STATE: Record<string, string> = {
  uploading: 'アップロード待ち', validating: '機械の確認中', validation_failed: '機械の確認で不合格', awaiting_review: '審査待ち',
  in_review: '審査中', approved: '承認', returned: '差し戻し', rejected: '却下', withdrawn: '取り消し', expired: '期限切れ',
  superseded: '置き換え済み', revoked: '取り下げ',
};

/** The account's collections; without the producer role, how to start (C-15). */
export function PublisherCollections() {
  const { api } = useSession();
  const me = useLoad(async () => (await api.GET('/api/publisher')).data, [api]);
  const producer = me.data?.roles?.includes('producer') ?? false;
  const list = useLoad(async () => (producer ? (await api.GET('/api/collections')).data : undefined), [api, producer]);
  const [collectionId, setCollectionId] = useState('');
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
  const register = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.POST('/api/collections', { body: { collectionId } });
      setCollectionId('');
      list.reload();
    } catch (err) {
      setError(describe(err));
    }
  };

  return (
    <section>
      <h1>素材集</h1>
      <Status error={me.error} loading={me.loading} />
      {me.data && !producer && (
        <div className="action">
          <p>
            素材集は、テキスト・画像・音声・映像の素材をまとめて審査に出し、チャンネルから使ってもらうためのものです（観光協会の音声ガイド、写真集など）。
            チャンネルを作らなくても、素材だけを届けられます。使い方は利用ガイドの「素材提供者」を見てください。
          </p>
          <p className="muted">最初の素材集の審査で、運営が、名乗っている団体・個人であることと素材の権利を、登録した連絡先で確かめます。</p>
          <button onClick={() => void start()}>素材提供者として始める</button>
        </div>
      )}
      {producer && (
        <>
          <Status error={list.error} loading={list.loading} />
          {list.data?.items.length === 0 && <Empty>まだ素材集がありません。下で素材集 ID を登録してください。</Empty>}
          <ul className="plain">
            {list.data?.items.map((c) => (
              <li key={c.collectionId}>
                <Link to={`/collections/${c.collectionId}`}><code>{c.collectionId}</code></Link> {c.latestApproved?.name}{' '}
                {c.listed ? <span className="tag active">公開中</span> : c.status === 'revoked' ? <span className="tag revoked">取り下げ</span> : <span className="tag">未公開</span>}
                {(c.externalCheck?.failures ?? []).length > 0 && <span className="tag revoked">外部の素材に不具合</span>}
              </li>
            ))}
          </ul>
          <form className="action" onSubmit={(e) => void register(e)}>
            <h3>素材集 ID を登録する</h3>
            <label>
              英小文字・数字・ハイフンの 3〜40 文字（チャンネルの ID とは別。あとから変えられず、取り下げても再利用できません）
              <input required pattern="[a-z0-9\-]{3,40}" placeholder="kamakura-audio-guide" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} />
            </label>
            <button>登録する</button>
          </form>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

async function upload(target: { url: string; fields: Record<string, string> }, file: Blob) {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`アップロードできませんでした（${res.status}）`);
}

/** One collection: its listed version, the daily check, who uses it, and its submissions. */
export function PublisherCollection() {
  const { api } = useSession();
  const { collectionId = '' } = useParams();
  const path = { collectionId };
  const col = useLoad(async () => (await api.GET('/api/collections/{collectionId}', { params: { path } })).data, [api, collectionId]);
  const users = useLoad(async () => (await api.GET('/api/collections/{collectionId}/used-by', { params: { path } })).data, [api, collectionId]);
  const subs = useLoad(async () => (await api.GET('/api/collections/{collectionId}/submissions', { params: { path, query: { limit: 20 } } })).data, [api, collectionId]);

  const [zip, setZip] = useState<File>();
  const [keyText, setKeyText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!zip) return;
    setError(undefined);
    try {
      setProgress('鍵を開いています…');
      const key = await openKeyFile(keyText, passphrase);
      setProgress('素材集に署名しています…');
      const signed = await signCollectionPackage(new Uint8Array(await zip.arrayBuffer()), key, { collection: collectionId });
      if (signed.zip.length > 2 * 1024 * 1024) throw new Error('署名したパッケージが 2MB を超えています（大きな素材は外部の URL に置いてください）');
      setProgress('申請を作っています…');
      const { data } = await api.POST('/api/collections/{collectionId}/submissions', { params: { path }, body: { ...(note ? { note } : {}) } });
      if (!data) throw new Error('申請を作れませんでした');
      setProgress('パッケージを送っています…');
      await upload(data.uploads.package, new Blob([new Uint8Array(signed.zip)], { type: 'application/zip' }));
      setProgress(`版 ${signed.version} を申請しました。外部の素材を読むので、機械の確認には数十秒〜数分かかります（「申請の状態を読み込み直す」で確かめてください）。`);
      setPassphrase('');
      subs.reload();
      col.reload();
    } catch (err) {
      setProgress(undefined);
      setError(describe(err));
    }
  };

  const c = col.data;
  return (
    <section>
      <p><Link to="/collections">← 素材集の一覧</Link></p>
      <h1><code>{collectionId}</code> {c?.latestApproved?.name}</h1>
      <Status error={col.error} loading={col.loading} />
      {c && (
        <dl className="facts">
          <dt>状態</dt>
          <dd>{c.listed ? '公開中' : c.status === 'revoked' ? '取り下げ' : '未公開'}</dd>
          <dt>公開中の版</dt>
          <dd>
            {c.latestApproved ? (
              <>
                版 {c.latestApproved.version}（<Time value={c.latestApproved.approvedAt} />）、{c.latestApproved.media.join('・')}、タグ {c.latestApproved.tags.join('・') || '—'}、
                利用許諾 {c.latestApproved.grants.publishers === '*' ? '誰でも' : `${(c.latestApproved.grants.publishers as string[]).length} のチャンネル提供者`}、
                使ってよいアプリ {c.latestApproved.grants.apps?.join('・') ?? 'すべてのアプリ'}、AI の根拠 {c.latestApproved.grants.grounding ? '使ってよい' : '使わない'}
                <div><StageNote appStage={c.latestApproved.appStage} minAppVersions={c.latestApproved.minAppVersions} /></div>
              </>
            ) : '—'}
          </dd>
          <dt>毎日の確認</dt>
          <dd>
            {c.externalCheck ? (
              (c.externalCheck.failures ?? []).length === 0 ? <>問題なし（<Time value={c.externalCheck.checkedAt} />）</> : (
                <>
                  取得できない外部の素材があります（<Time value={c.externalCheck.checkedAt} />）。直らないあいだ、その素材は出ません。
                  {c.externalCheck.failures!.map((f) => <div key={f.resourceId} className="small"><code>{f.resourceId}</code> {f.status} <code>{f.url}</code></div>)}
                </>
              )
            ) : '—'}
          </dd>
          {c.revocations?.map((r) => (
            <Fragment key={r.revokedAt}>
              <dt>取り下げ</dt>
              <dd><Time value={r.revokedAt} />: {r.reason}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      <h2>使っているチャンネル</h2>
      <Status error={users.error} loading={users.loading} />
      {users.data?.items.length === 0 && <Empty>まだ使っているチャンネルはありません。</Empty>}
      <ul className="plain">
        {users.data?.items.map((u) => (
          <li key={u.channelId}>
            <code>{u.channelId}</code> {u.channelName} 版 {u.channelVersion}（{u.publisherName || '—'}）
            {u.resources.length > 0 && <span className="small"> 参照している素材: {u.resources.join('、')}</span>}
          </li>
        ))}
      </ul>
      <p className="muted small">ここにある素材を消したり種類を変えたりした版は、機械の確認で不合格になります（公開中のチャンネルが壊れないように）。</p>

      <div className="action">
        <h3>画面で作る</h3>
        <p className="muted">
          <code>collection.json</code> と素材（題材・タグを含む）を画面のフォームで作り、下書きとして保存できます。下書きのまま機械審査にかけ、そのまま署名して申請できます。
        </p>
        <Link to={`/collections/${collectionId}/edit`}>{c?.draft ? `下書きを編集する（${new Date(c.draft.updatedAt).toLocaleString('ja-JP')} に保存）` : '下書きを作る'}</Link>
      </div>

      <h2>申請</h2>
      <Status error={subs.error} loading={subs.loading} />
      {subs.data?.items.length === 0 && <Empty>まだ申請していません。</Empty>}
      {subs.data && subs.data.items.length > 0 && (
        <table>
          <thead>
            <tr><th>申請</th><th>版</th><th>状態</th><th>機械の確認</th><th></th></tr>
          </thead>
          <tbody>
            {subs.data.items.map((s) => (
              <tr key={s.submissionId}>
                <td><Time value={s.createdAt} /></td>
                <td>{s.version ?? '—'}</td>
                <td>
                  <span className={`tag ${s.state}`}>{STATE[s.state] ?? s.state}</span>
                  {s.decision && s.decision.action !== 'approve' && (
                    <div className="small">
                      {s.decision.message}
                      {(s.decision.findings ?? []).map((f) => <div key={f.item + f.detail}>審査基準 {f.item}: {f.detail}</div>)}
                    </div>
                  )}
                </td>
                <td><ValidationView validation={s.validation} /></td>
                <td>
                  {(s.state === 'awaiting_review' || s.state === 'in_review') && (
                    <button
                      className="link"
                      onClick={() =>
                        void api
                          .POST('/api/collections/{collectionId}/submissions/{submissionId}/withdraw', { params: { path: { collectionId, submissionId: s.submissionId }, header: ifMatch(s.rev) } })
                          .then(() => { subs.reload(); col.reload(); }, (err: unknown) => setError(describe(err)))
                      }
                    >
                      取り消す
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button onClick={() => subs.reload()}>申請の状態を読み込み直す</button>

      <form className="action" onSubmit={(e) => void submit(e)}>
        <h3>ZIP から申請する</h3>
        <p className="muted">
          手元で作った署名する前の ZIP（<code>collection.json</code> と <code>resources/</code>）を選びます。この画面があなたの鍵で署名し、<code>signature.json</code> を足して送ります。
          大きな画像・音声・映像は外部の URL（HTTPS）に置き、<code>collection.json</code> に SHA-256 と大きさを書きます。形式は利用ガイドの「素材提供者」を見てください。
        </p>
        <label>
          素材集（ZIP）
          <input type="file" accept=".zip,application/zip" required onChange={(e) => setZip(e.target.files?.[0])} />
        </label>
        <label>
          鍵のファイル
          <input type="file" accept="application/json,.json" required onChange={(e) => void e.target.files?.[0]?.text().then(setKeyText)} />
        </label>
        <label>
          合言葉
          <input type="password" required value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        <label>
          運営への説明（素材の権利・出どころなど。審査のときに読まれます）
          <textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button disabled={!zip || !keyText || !passphrase || (progress !== undefined && !progress.startsWith('版'))}>署名して申請する</button>
        {progress && <p role="status">{progress}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      {zip && <PreReview kind="collection" who="provider" load={async () => reviewFiles(new Uint8Array(await zip.arrayBuffer()))} />}
    </section>
  );
}
