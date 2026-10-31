import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { describe, ifMatch } from '../api';
import { useSession } from '../main';
import { PublisherStudioAdmin } from './studio';
import { Empty, ReasonForm, Status, Time, useLoad } from './common';

const STATUS: Record<string, string> = { pending_key: '鍵の紐づけ待ち', active: '有効', suspended: '停止中', deleted: '退会済み' };

export function PublishersPage() {
  const { api } = useSession();
  const [status, setStatus] = useState('');
  const list = useLoad(
    async () =>
      (await api.GET('/api/admin/publishers', { params: { query: { limit: 50, ...(status ? { status: status as never } : {}) } } })).data,
    [api, status],
  );
  return (
    <section>
      <h1>提供者（チャンネル・素材）</h1>
      <label>
        状態で絞り込む{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">すべて</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <Status error={list.error} loading={list.loading} />
      {list.data?.items.length === 0 && <Empty>提供者はまだいません。</Empty>}
      {list.data && list.data.items.length > 0 && (
        <table>
          <thead>
            <tr><th>表示名</th><th>状態</th><th>チャンネル</th><th>登録</th></tr>
          </thead>
          <tbody>
            {list.data.items.map((p) => (
              <tr key={p.publisherId}>
                <td><Link to={`/publishers/${p.publisherId}`}>{p.displayName}</Link></td>
                <td><span className={`tag ${p.status}`}>{STATUS[p.status]}</span></td>
                <td>{p.usage.channels} / {p.limits.channels}</td>
                <td><Time value={p.createdAt} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function PublisherPage() {
  const { api } = useSession();
  const { publisherId = '' } = useParams();
  const pub = useLoad(async () => (await api.GET('/api/admin/publishers/{publisherId}', { params: { path: { publisherId } } })).data, [api, publisherId]);
  const channels = useLoad(
    async () => (await api.GET('/api/admin/publishers/{publisherId}/channels', { params: { path: { publisherId } } })).data,
    [api, publisherId],
  );
  const collections = useLoad(
    async () => (await api.GET('/api/admin/publishers/{publisherId}/collections', { params: { path: { publisherId } } })).data,
    [api, publisherId],
  );
  const p = pub.data;

  const [limits, setLimits] = useState<{ channels?: number; collections?: number; uploadsPerDay?: number; ticketsPerDay?: number }>({});
  const [limitsError, setLimitsError] = useState<string>();
  const saveLimits = async (e: FormEvent, reason: string) => {
    e.preventDefault();
    if (!p) return;
    setLimitsError(undefined);
    try {
      await api.PUT('/api/admin/publishers/{publisherId}/limits', { params: { path: { publisherId }, header: ifMatch(p.rev) }, body: { ...limits, reason } });
      setLimits({});
      pub.reload();
    } catch (err) {
      setLimitsError(describe(err));
    }
  };
  const [limitsReason, setLimitsReason] = useState('');

  return (
    <section>
      <p><Link to="/publishers">← 提供者の一覧</Link></p>
      <Status error={pub.error} loading={pub.loading} />
      {p && (
        <>
          <h1>{p.displayName}</h1>
          <dl className="facts">
            <dt>状態</dt>
            <dd><span className={`tag ${p.status}`}>{STATUS[p.status]}</span>{p.statusReason && `（${p.statusReason}）`}</dd>
            <dt>連絡先</dt>
            <dd>{p.contact ?? '—'}</dd>
            <dt>アカウントID</dt>
            <dd><code>{p.activeAccountId ?? '—'}</code></dd>
            <dt>今日の申請・試用チケット</dt>
            <dd>{p.usage.uploadsToday} / {p.limits.uploadsPerDay}、{p.usage.ticketsToday} / {p.limits.ticketsPerDay}</dd>
            <dt>登録</dt>
            <dd><Time value={p.createdAt} /></dd>
          </dl>

          {p.status === 'suspended' ? (
            <ReasonForm
              label="停止を解く"
              submit={async (reason) => {
                await api.POST('/api/admin/publishers/{publisherId}/resume', { params: { path: { publisherId }, header: ifMatch(p.rev) }, body: { reason } });
                pub.reload();
              }}
            />
          ) : (
            p.status !== 'deleted' && (
              <ReasonForm
                label="停止する"
                danger
                submit={async (reason) => {
                  await api.POST('/api/admin/publishers/{publisherId}/suspend', { params: { path: { publisherId }, header: ifMatch(p.rev) }, body: { reason } });
                  pub.reload();
                }}
              >
                <p className="muted">停止中は申請・試用チケット・鍵の紐づけを受け付けません。公開中のチャンネルは残ります（止めるならチャンネルを取り下げる）。</p>
              </ReasonForm>
            )
          )}

          <form className="action" onSubmit={(e) => void saveLimits(e, limitsReason)}>
            <h3>上限を変える</h3>
            {(['channels', 'collections', 'uploadsPerDay', 'ticketsPerDay'] as const).map((k) => (
              <label key={k}>
                {{ channels: 'チャンネル数', collections: '素材集の数', uploadsPerDay: '1 日の申請（チャンネルと素材集の合計）', ticketsPerDay: '1 日の試用チケット' }[k]}（今 {p.limits[k]}）
                <input type="number" min={0} max={1000} value={limits[k] ?? ''} onChange={(e) => setLimits((l) => ({ ...l, [k]: e.target.value === '' ? undefined : Number(e.target.value) }))} />
              </label>
            ))}
            <label>
              理由（操作の記録に残ります）
              <input required maxLength={500} value={limitsReason} onChange={(e) => setLimitsReason(e.target.value)} />
            </label>
            <button>保存する（空欄は既定値に戻る）</button>
            {limitsError && <p className="error" role="alert">{limitsError}</p>}
          </form>

          <h2>チャンネル</h2>
          <Status error={channels.error} loading={channels.loading} />
          {channels.data?.items.length === 0 && <Empty>チャンネルはありません。</Empty>}
          <ul className="plain">
            {channels.data?.items.map((c) => (
              <li key={c.channelId}>
                <Link to={`/channels/${c.channelId}`}><code>{c.channelId}</code></Link> {c.latestApproved?.name}{' '}
                <span className={`tag ${c.status}`}>{c.status}</span> {c.listed && <span className="tag active">公開中</span>}
              </li>
            ))}
          </ul>
          <h2>素材集</h2>
          <p className="small">
            役割: {(p.roles ?? ['publisher']).map((r) => (r === 'producer' ? '素材提供者' : 'チャンネル提供者')).join('・')}。
            身元の確認: {p.producerVerified ? <>確認済み{p.producerVerification && `（${p.producerVerification.method}、${p.producerVerification.detail}）`}</> : '未確認'}
          </p>
          <Status error={collections.error} loading={collections.loading} />
          {collections.data?.items.length === 0 && <Empty>素材集はありません。</Empty>}
          <ul className="plain">
            {collections.data?.items.map((c) => (
              <li key={c.collectionId}>
                <Link to={`/collections/${c.collectionId}`}><code>{c.collectionId}</code></Link> {c.latestApproved?.name}{' '}
                <span className={`tag ${c.status}`}>{c.status}</span> {c.listed && <span className="tag active">公開中</span>}
                {(c.externalCheck?.failures ?? []).length > 0 && <span className="tag revoked">外部の素材に不具合</span>}
              </li>
            ))}
          </ul>
          <PublisherStudioAdmin publisherId={publisherId} />
          <p><Link to={`/audit?target=PUB%23${publisherId}`}>この提供者の操作の記録</Link></p>
        </>
      )}
    </section>
  );
}
