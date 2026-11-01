import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Schemas } from '@yorisoi-console/api-types';
import { describe, ifMatch } from '../api';
import { useSession } from '../main';
import { Empty, ReasonForm, Status, Time, useLoad } from './common';

const STATE: Record<Schemas['KeyTransferState'], string> = { requested: '確認待ち', approved: '承認', rejected: '認めない', cancelled: '取り消し' };
const REASONS: Record<string, string> = { lost: 'なくした', leaked: '漏れたおそれ', other: 'その他' };

/** Key transfers waiting for the operator, and past ones (ARCH-001 A-15, DES-006). */
export function TransfersPage() {
  const { api } = useSession();
  const [state, setState] = useState<Schemas['KeyTransferState']>('requested');
  const list = useLoad(async () => (await api.GET('/api/admin/key-transfers', { params: { query: { state, limit: 50 } } })).data, [api, state]);
  return (
    <section>
      <h1>鍵の移し替え</h1>
      <p className="muted">
        承認の前に、鍵とは別の方法（登録済みの連絡先への問い合わせなど）でチャンネル提供者の本人であることを確かめ、その方法と結果を記録します。
        承認すると、そのチャンネル提供者のすべてのチャンネルが新しい鍵に移り、古い鍵で署名した審査待ちの申請は差し戻されます。
        漏れたおそれがあるときは、公開中の版を取り下げるかどうかも検討してください。
      </p>
      <label>
        状態{' '}
        <select value={state} onChange={(e) => setState(e.target.value as Schemas['KeyTransferState'])}>
          {Object.entries(STATE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <Status error={list.error} loading={list.loading} />
      {list.data?.items.length === 0 && <Empty>ありません。</Empty>}
      {list.data?.items.map((t) => <Transfer key={t.transferId} transfer={t} onDone={list.reload} />)}
    </section>
  );
}

function Transfer({ transfer: t, onDone }: { transfer: Schemas['KeyTransfer']; onDone: () => void }) {
  const { api } = useSession();
  const [method, setMethod] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const path = { publisherId: t.publisherId, transferId: t.transferId };
  const approve = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm('移し替えを承認してよろしいですか？')) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.POST('/api/admin/publishers/{publisherId}/key-transfers/{transferId}/approve', { params: { path, header: ifMatch(t.rev) }, body: { verification: { method, detail } } });
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="card">
      <dl className="facts">
        <dt>チャンネル提供者</dt>
        <dd><Link to={`/publishers/${t.publisherId}`}>{t.publisherId}</Link></dd>
        <dt>状態</dt>
        <dd><span className={`tag ${t.state}`}>{STATE[t.state]}</span> {t.decisionReason}</dd>
        <dt>申し出</dt>
        <dd><Time value={t.requestedAt} /></dd>
        <dt>理由</dt>
        <dd>{REASONS[t.reason]}。散策者に見せる理由: {t.publicReason}</dd>
        <dt>チャンネル提供者の説明</dt>
        <dd>{t.note ?? '—'}</dd>
        <dt>今の鍵 → 新しい鍵</dt>
        <dd><code>{t.fromAccountId}</code> → <code>{t.toAccountId}</code></dd>
        {t.verification && (
          <>
            <dt>本人確認</dt>
            <dd>{t.verification.method}: {t.verification.detail}</dd>
          </>
        )}
        {t.returnedSubmissions && t.returnedSubmissions.length > 0 && (
          <>
            <dt>差し戻した申請</dt>
            <dd>{t.returnedSubmissions.length} 件</dd>
          </>
        )}
      </dl>
      {t.state === 'requested' && (
        <>
          <form className="action" onSubmit={(e) => void approve(e)}>
            <h3>本人確認して承認する</h3>
            <label>
              確かめた方法（100 文字まで）
              <input required maxLength={100} placeholder="登録済みの連絡先への返信" value={method} onChange={(e) => setMethod(e.target.value)} />
            </label>
            <label>
              確かめた内容
              <textarea required maxLength={2000} value={detail} onChange={(e) => setDetail(e.target.value)} />
            </label>
            <button disabled={busy || !method.trim() || !detail.trim()}>{busy ? '処理中…' : '承認する'}</button>
            {error && <p className="error" role="alert">{error}</p>}
          </form>
          <ReasonForm
            label="認めない"
            danger
            submit={async (reason) => {
              await api.POST('/api/admin/publishers/{publisherId}/key-transfers/{transferId}/reject', { params: { path, header: ifMatch(t.rev) }, body: { reason } });
              onDone();
            }}
          >
            <p className="muted">理由はチャンネル提供者にメールで伝わります。新しい鍵の紐づけは外れます。</p>
          </ReasonForm>
        </>
      )}
    </article>
  );
}
