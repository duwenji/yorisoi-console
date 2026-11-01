import { unzipSync } from 'fflate';
import { Fragment, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Schemas } from '@yorisoi-console/api-types';
import { describe, ifMatch } from '../api';
import { useSession } from '../main';
import { Empty, ReasonForm, Status, Time, useLoad } from './common';
import { PreReview, reviewFiles } from './pre-review';
import { ITEMS } from './review';
import { StageNote, ValidationView } from './validation';

// The operator's side of collections (DES-010 N-4〜N-6): reviewing a submission, and a collection's page.

const STATE: Record<string, string> = { awaiting_review: '審査待ち', in_review: '審査中', approved: '承認', returned: '差し戻し', rejected: '却下', withdrawn: '取り消し' };

interface Resource {
  id: string;
  type: 'text' | 'image' | 'audio' | 'video';
  file?: string;
  url?: string;
  sha256?: string;
  size?: number;
  durationSec?: number;
  alt?: string;
  transcript?: string;
  credit?: { author: string; license: string; source?: string };
  about?: { type: 'spot' | 'point'; osm?: string; name?: string; lat: number; lon: number; radiusM?: number };
  tags?: string[];
}

/** Where a subject is, on OpenStreetMap (API-001 未決事項 No.5: a link, no map in the page). */
function AboutLink({ about }: { about: NonNullable<Resource['about']> }) {
  const map = `https://www.openstreetmap.org/?mlat=${about.lat}&mlon=${about.lon}#map=18/${about.lat}/${about.lon}`;
  return (
    <span>
      {about.type === 'spot' ? <>スポット {about.name ?? ''}（<a href={`https://www.openstreetmap.org/${about.osm}`} target="_blank" rel="noreferrer">{about.osm}</a>）</> : <>地点（半径 {about.radiusM}m）</>}
      {' '}<a href={map} target="_blank" rel="noreferrer">地図で見る</a>
    </span>
  );
}

/**
 * The collection's resources, one by one, unpacked in the browser (DES-010 N-4): texts in full,
 * images shown, outside audio and video playable from their own URLs, with credits, subjects and tags.
 */
function CollectionPackageView({ collectionId, submissionId }: { collectionId: string; submissionId: string }) {
  const { api } = useSession();
  const [manifest, setManifest] = useState<{ name: string; summary: string; grants: unknown; resources: Resource[] }>();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [images, setImages] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  useEffect(() => () => Object.values(images).forEach((u) => URL.revokeObjectURL(u)), [images]);
  const open = async () => {
    setError(undefined);
    try {
      const { data } = await api.GET('/api/admin/collections/{collectionId}/submissions/{submissionId}/package', { params: { path: { collectionId, submissionId } } });
      if (!data) return;
      const files = unzipSync(new Uint8Array(await (await fetch(data.packageUrl)).arrayBuffer()));
      const decoder = new TextDecoder();
      const m = JSON.parse(decoder.decode(files['collection.json']!));
      const t: Record<string, string> = {};
      const im: Record<string, string> = {};
      for (const r of m.resources as Resource[]) {
        if (r.file && files[r.file]) {
          if (r.type === 'text') t[r.id] = decoder.decode(files[r.file]);
          else im[r.id] = URL.createObjectURL(new Blob([new Uint8Array(files[r.file]!)]));
        }
      }
      setTexts(t);
      setImages(im);
      setManifest(m);
    } catch (e) {
      setError(describe(e));
    }
  };
  return (
    <div className="action">
      <h3>素材集の中身</h3>
      {!manifest && <button onClick={() => void open()}>開く</button>}
      {error && <p className="error">{error}</p>}
      {manifest && (
        <>
          <p>{manifest.name} — {manifest.summary}</p>
          <p className="small">利用許諾: <code>{JSON.stringify(manifest.grants)}</code></p>
          <p className="small">
            AI の根拠: {(manifest.grants as { grounding?: boolean }).grounding ? <strong>使ってよい（本文・代替テキスト・書き起こしを AI が言い換えて話す。審査基準 2.8）</strong> : '使わない'}
          </p>
          <p className="muted small">外部の素材を再生すると、あなたのブラウザが素材提供者の置き場所に直接つながります。</p>
          {manifest.resources.map((r) => (
            <details key={r.id} open>
              <summary><code>{r.id}</code> {r.type}{r.tags?.length ? `（${r.tags.join('・')}）` : ''}</summary>
              <div className="small">
                {r.about && <div>題材: <AboutLink about={r.about} /></div>}
                {r.credit && <div>出典: {r.credit.author} ／ {r.credit.license}{r.credit.source && <> ／ <a href={r.credit.source} target="_blank" rel="noreferrer">出どころ</a></>}</div>}
                {r.alt && <div>代替テキスト: {r.alt}</div>}
                {r.transcript && <div>書き起こし: <code>{r.transcript}</code></div>}
                {r.url && <div>外部: <code>{r.url}</code> {r.size} バイト{r.durationSec ? `、${r.durationSec} 秒` : ''}</div>}
              </div>
              {r.type === 'text' && <pre className="copy">{texts[r.id]}</pre>}
              {r.type === 'image' && <img src={images[r.id] ?? r.url} alt={r.alt ?? ''} style={{ maxWidth: '100%', maxHeight: 320 }} />}
              {r.type === 'audio' && r.url && <audio controls preload="none" src={r.url} />}
              {r.type === 'video' && r.url && <video controls preload="none" src={r.url} style={{ maxWidth: '100%' }} />}
            </details>
          ))}
        </>
      )}
    </div>
  );
}

/** Approve (with the identity check the first time, C-17), return or reject. */
function CollectionDecision({ sub, account, onDone }: { sub: Schemas['CollectionSubmission']; account: Schemas['Publisher'] | undefined; onDone: () => void }) {
  const { api } = useSession();
  const [findings, setFindings] = useState<{ item: string; detail: string }[]>([{ item: '2.6', detail: '' }]);
  const [message, setMessage] = useState('');
  const [method, setMethod] = useState('');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState<string>();
  const verified = account?.producerVerified ?? false;
  const path = { collectionId: sub.collectionId, submissionId: sub.submissionId };
  const decide = async (action: 'approve' | 'return' | 'reject') => {
    const label = { approve: '承認', return: '差し戻し', reject: '却下' }[action];
    if (!window.confirm(`${label}してよろしいですか？${action === 'approve' ? '\nリストに載り、チャンネルから使えるようになります。' : ''}`)) return;
    setError(undefined);
    try {
      const params = { path, header: ifMatch(sub.rev) };
      const common = message ? { message } : {};
      const filled = findings.filter((f) => f.detail.trim());
      if (action === 'approve') {
        await api.POST('/api/admin/collections/{collectionId}/submissions/{submissionId}/approve', { params, body: { ...common, ...(!verified ? { verification: { method, detail } } : {}) } });
      } else if (action === 'return') {
        await api.POST('/api/admin/collections/{collectionId}/submissions/{submissionId}/return', { params, body: { ...common, findings: filled } });
      } else {
        await api.POST('/api/admin/collections/{collectionId}/submissions/{submissionId}/reject', { params, body: { ...common, findings: filled } });
      }
      onDone();
    } catch (e) {
      setError(describe(e));
    }
  };
  return (
    <div className="action">
      <h3>判定</h3>
      <div className="facts">
        <dt>素材提供者</dt>
        <dd>{account ? <><Link to={`/publishers/${account.publisherId}`}>{account.displayName}</Link>（連絡先 {account.contact ?? '—'}）</> : '—'}</dd>
        <dt>身元の確認</dt>
        <dd>
          {verified
            ? <>確認済み{account?.producerVerification && `（${account.producerVerification.method}）`}</>
            : '未確認。承認するには、名乗っている団体・個人であることと素材の権利を、登録された連絡先など鍵とは別の経路で確かめ、下に記録してください（審査基準、MATERIALS D-20）'}
        </dd>
      </div>
      {!verified && (
        <>
          <label>確認の方法<input maxLength={100} value={method} placeholder="登録された連絡先への電話" onChange={(e) => setMethod(e.target.value)} /></label>
          <label>確認した内容<textarea rows={2} maxLength={2000} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        </>
      )}
      <p className="muted">差し戻し・却下には、審査基準の項目番号つきの理由を 1 つ以上入れます。理由と説明は素材提供者に見せます。</p>
      {findings.map((f, i) => (
        <div key={i} className="inline">
          <select value={f.item} onChange={(e) => setFindings((all) => all.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))}>
            {ITEMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input placeholder="理由" value={f.detail} onChange={(e) => setFindings((all) => all.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)))} />
        </div>
      ))}
      <button className="link" onClick={() => setFindings((all) => [...all, { item: '2.6', detail: '' }])}>理由を足す</button>
      <label>
        素材提供者への説明
        <textarea rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <div className="inline">
        <button onClick={() => void decide('approve')} disabled={!verified && (!method.trim() || !detail.trim())}>承認する</button>
        <button onClick={() => void decide('return')} disabled={!findings.some((f) => f.detail.trim())}>差し戻す</button>
        <button className="danger" onClick={() => void decide('reject')} disabled={!findings.some((f) => f.detail.trim())}>却下する</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function CollectionReviewPage() {
  const { api } = useSession();
  const { collectionId = '', submissionId = '' } = useParams();
  const path = { collectionId, submissionId };
  const sub = useLoad(async () => (await api.GET('/api/collections/{collectionId}/submissions/{submissionId}', { params: { path } })).data, [api, collectionId, submissionId]);
  const reviews = useLoad(async () => (await api.GET('/api/admin/collections/{collectionId}/submissions/{submissionId}/reviews', { params: { path } })).data, [api, collectionId, submissionId]);
  const account = useLoad(async () => {
    const col = (await api.GET('/api/collections/{collectionId}', { params: { path: { collectionId } } })).data;
    return col ? (await api.GET('/api/admin/publishers/{publisherId}', { params: { path: { publisherId: col.publisherId } } })).data : undefined;
  }, [api, collectionId]);
  const [error, setError] = useState<string>();
  const s = sub.data;
  const act = (work: () => Promise<unknown>) => () => {
    setError(undefined);
    work().then(() => { sub.reload(); reviews.reload(); }, (e: unknown) => setError(describe(e)));
  };
  return (
    <section>
      <p><Link to="/review">← 審査の一覧</Link> ／ <Link to={`/collections/${collectionId}`}>素材集</Link></p>
      <h1>素材集 <code>{collectionId}</code> {s?.version !== undefined && s?.version !== null && `版 ${s.version}`}</h1>
      <Status error={sub.error} loading={sub.loading} />
      {error && <p className="error" role="alert">{error}</p>}
      {s && (
        <>
          <dl className="facts">
            <dt>状態</dt>
            <dd><span className={`tag ${s.state}`}>{STATE[s.state] ?? s.state}</span></dd>
            <dt>素材提供者のアカウントID</dt>
            <dd><code>{s.accountId}</code></dd>
            <dt>運営への説明</dt>
            <dd>{s.note ?? '—'}</dd>
            <dt>機械の確認</dt>
            <dd><ValidationView validation={s.validation} /></dd>
            <dt>パッケージ</dt>
            <dd><code title={s.sha256 ?? ''}>{s.sha256?.slice(0, 12)}…</code> {s.size} バイト</dd>
          </dl>
          {s.state === 'awaiting_review' && (
            <button onClick={act(() => api.POST('/api/admin/collections/{collectionId}/submissions/{submissionId}/start', { params: { path, header: ifMatch(s.rev) } }))}>審査を始める</button>
          )}
          {s.state === 'in_review' && (
            <button className="link" onClick={act(() => api.POST('/api/admin/collections/{collectionId}/submissions/{submissionId}/release', { params: { path, header: ifMatch(s.rev) } }))}>
              審査を戻す（ほかの担当者に任せる）
            </button>
          )}
          <CollectionPackageView collectionId={collectionId} submissionId={submissionId} />
          {s.state === 'in_review' && (
            <PreReview
              kind="collection" who="operator"
              load={async () => {
                const { data } = await api.GET('/api/admin/collections/{collectionId}/submissions/{submissionId}/package', { params: { path } });
                if (!data) throw new Error('パッケージを読めませんでした');
                return reviewFiles(new Uint8Array(await (await fetch(data.packageUrl)).arrayBuffer()));
              }}
            />
          )}
          {s.state === 'in_review' && <CollectionDecision sub={s} account={account.data} onDone={() => { sub.reload(); reviews.reload(); account.reload(); }} />}
          {s.decision && (
            <div className="action">
              <h3>判定</h3>
              <p>{s.decision.action === 'approve' ? '承認' : s.decision.action === 'return' ? '差し戻し' : '却下'}（<Time value={s.decision.at} />）{s.decision.message && `: ${s.decision.message}`}</p>
              <ul>{(s.decision.findings ?? []).map((f) => <li key={f.item + f.detail}>{f.item}: {f.detail}</li>)}</ul>
            </div>
          )}
        </>
      )}
      <h2>審査の記録</h2>
      <Status error={reviews.error} loading={reviews.loading} />
      {reviews.data?.items.length === 0 && <Empty>まだ記録はありません。</Empty>}
      <ul className="plain">
        {reviews.data?.items.map((r) => (
          <li key={r.at}>
            <Time value={r.at} /> <code>{r.action}</code> {r.message}
            {(r.findings ?? []).map((f) => <div key={f.item + f.detail} className="small">{f.item}: {f.detail}</div>)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A collection as the operator manages it (DES-010 N-6): who uses it, the daily check, its submissions, revocation. */
export function OperatorCollectionPage() {
  const { api } = useSession();
  const { collectionId = '' } = useParams();
  const path = { collectionId };
  const col = useLoad(async () => (await api.GET('/api/collections/{collectionId}', { params: { path } })).data, [api, collectionId]);
  const users = useLoad(async () => (await api.GET('/api/collections/{collectionId}/used-by', { params: { path } })).data, [api, collectionId]);
  const subs = useLoad(async () => (await api.GET('/api/collections/{collectionId}/submissions', { params: { path, query: { limit: 20 } } })).data, [api, collectionId]);
  const [severity, setSeverity] = useState<'high' | 'low'>('high');
  const c = col.data;
  return (
    <section>
      <p>{c && <Link to={`/publishers/${c.publisherId}`}>← 素材提供者</Link>}</p>
      <h1>素材集 <code>{collectionId}</code> {c?.latestApproved?.name}</h1>
      <Status error={col.error} loading={col.loading} />
      {c && (
        <dl className="facts">
          <dt>状態</dt>
          <dd>{c.listed ? <span className="tag active">公開中</span> : <span className={`tag ${c.status}`}>{c.status}</span>}</dd>
          <dt>公開中の版</dt>
          <dd>{c.latestApproved ? <>版 {c.latestApproved.version}（<Time value={c.latestApproved.approvedAt} />） <StageNote appStage={c.latestApproved.appStage} minAppVersions={c.latestApproved.minAppVersions} /></> : '—'}</dd>
          <dt>毎日の確認</dt>
          <dd>
            {c.externalCheck ? <><Time value={c.externalCheck.checkedAt} />{(c.externalCheck.failures ?? []).map((f) => <div key={f.resourceId} className="small"><code>{f.resourceId}</code> {f.status}</div>)}</> : '—'}
          </dd>
          {c.revocations?.map((r) => (
            <Fragment key={r.revokedAt}>
              <dt>取り下げ</dt>
              <dd><Time value={r.revokedAt} />: {r.reason}（{r.severity}）</dd>
            </Fragment>
          ))}
        </dl>
      )}
      <h2>使っているチャンネル</h2>
      <Status error={users.error} loading={users.loading} />
      {users.data?.items.length === 0 && <Empty>使っているチャンネルはありません。</Empty>}
      <ul className="plain">
        {users.data?.items.map((u) => (
          <li key={u.channelId}><Link to={`/channels/${u.channelId}`}><code>{u.channelId}</code></Link> {u.channelName} 版 {u.channelVersion}（{u.publisherName || '—'}） {u.resources.join('、')}</li>
        ))}
      </ul>
      <h2>申請</h2>
      <ul className="plain">
        {subs.data?.items.map((s) => (
          <li key={s.submissionId}>
            <Link to={`/review/collections/${collectionId}/${s.submissionId}`}><Time value={s.createdAt} /></Link> 版 {s.version ?? '—'} <span className={`tag ${s.state}`}>{STATE[s.state] ?? s.state}</span>
          </li>
        ))}
      </ul>
      {c?.status === 'active' && c.latestApproved && (
        <ReasonForm
          label="取り下げる"
          danger
          submit={async (reason) => {
            await api.POST('/api/admin/collections/{collectionId}/revoke', { params: { path, header: ifMatch(c.rev) }, body: { reason, severity } });
            col.reload();
          }}
        >
          <p className="muted">リストから外し、取り下げとして 7 日載せます。使っているチャンネルでは、その素材が出なくなり、それぞれのチャンネル提供者に知らせます。理由は散策者にも見せます。</p>
          <label>
            重さ
            <select value={severity} onChange={(e) => setSeverity(e.target.value as 'high' | 'low')}>
              <option value="high">high（すぐ止める必要がある）</option>
              <option value="low">low</option>
            </select>
          </label>
        </ReasonForm>
      )}
    </section>
  );
}
