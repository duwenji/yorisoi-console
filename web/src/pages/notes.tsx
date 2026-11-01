import { useState, type FormEvent } from 'react';
import type { Schemas } from '@yorisoi-console/api-types';
import { describe, ifMatch } from '../api';
import { useSession } from '../main';
import { Empty, ReasonForm, reasons, Status, Time, useLoad } from './common';

// The operator's page of the notes (DES-013 K-17, platform policies/notes-terms.md 3): reported notes and
// the devices banned from putting them. The operator never sees which device put a note: a ban is made and listed by the note.

const TERMS_URL = 'https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/notes-terms.md';

export function OperatorNotes() {
  return (
    <section>
      <h1>一言</h1>
      <p className="muted">
        一言はアプリ利用者の投稿で、運営は事前に確かめません。通報されたものを見て戻すか消し、置いた端末を締め出します（<a href={TERMS_URL} target="_blank" rel="noreferrer">一言の利用規約</a> 3）。
      </p>
      <ReportedNotes />
      <Bans />
    </section>
  );
}

function ReportedNotes() {
  const { api } = useSession();
  const list = useLoad(async () => (await api.GET('/api/admin/notes/reported')).data, [api]);
  const [ban, setBan] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const decide = async (noteId: string, decision: 'restore' | 'remove', reason?: string) => {
    setError(undefined);
    const days = ban[noteId] ?? '';
    try {
      await api.POST('/api/admin/notes/{noteId}/{decision}', {
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
  const list = useLoad(async () => (await api.GET('/api/admin/notes/bans')).data, [api]);
  const [error, setError] = useState<string>();
  const lift = async (noteId: string) => {
    if (!window.confirm('締め出しを解きますか？')) return;
    setError(undefined);
    try {
      await api.DELETE('/api/admin/notes/bans/{noteId}', { params: { path: { noteId } } });
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
