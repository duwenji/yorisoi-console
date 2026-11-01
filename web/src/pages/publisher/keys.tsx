import { useState } from 'react';
import { describe, ifMatch } from '../../api';
import { useSession } from '../../main';
import { MIN_PASSPHRASE, b64url, createKey, sign, type KeyFile, type PublisherKey } from '../../publisher-crypto';
import { Empty, Status, Time, useLoad } from '../common';
import { download } from './home';

const KEY_STATUS: Record<string, string> = { active: '使用中', pending_transfer: '移し替え待ち', unbound: '外した' };
const TRANSFER_STATE: Record<string, string> = { requested: '運営の確認待ち', approved: '承認', rejected: '認められなかった', cancelled: '取り消した' };
const REASONS = { lost: 'なくした', leaked: '漏れたおそれがある', other: 'その他' } as const;

/** The publisher's keys, and moving to a new key when the old one is lost or leaked (ARCH-001 A-15, DES-006). */
export function PublisherKeys() {
  const { api } = useSession();
  const pub = useLoad(async () => (await api.GET('/api/publisher')).data, [api]);
  const keys = useLoad(async () => (await api.GET('/api/publisher/keys')).data, [api]);
  const transfers = useLoad(async () => (await api.GET('/api/publisher/key-transfers')).data, [api]);
  const reload = () => {
    pub.reload();
    keys.reload();
    transfers.reload();
  };
  const pending = transfers.data?.items.find((t) => t.state === 'requested');
  const [cancelError, setCancelError] = useState<string>();

  return (
    <section>
      <h1>鍵</h1>
      <Status error={keys.error ?? transfers.error} loading={keys.loading || transfers.loading} />
      <table>
        <thead>
          <tr><th>アカウントID</th><th>状態</th><th>紐づけ</th><th>外した</th></tr>
        </thead>
        <tbody>
          {keys.data?.items.map((k) => (
            <tr key={k.accountId}>
              <td><code>{k.accountId}</code></td>
              <td><span className={`tag ${k.status}`}>{KEY_STATUS[k.status]}</span></td>
              <td><Time value={k.boundAt} /></td>
              <td><Time value={k.unboundAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>鍵の移し替え</h2>
      <p>
        鍵をなくした、または漏れたおそれがあるときは、新しい鍵を作って移し替えを申し出ます。運営が、登録した連絡先など鍵とは別の方法であなたであることを確かめてから承認します。
        承認されると、すべてのチャンネルが新しい鍵に移り、古い鍵で署名した審査待ちの申請は差し戻されます。申し出ている間は、新しい申請はできません。
      </p>
      {transfers.data?.items.length === 0 && <Empty>移し替えの申し出はありません。</Empty>}
      {transfers.data && transfers.data.items.length > 0 && (
        <table>
          <thead>
            <tr><th>申し出</th><th>状態</th><th>新しいアカウントID</th><th>散策者に見せる理由</th><th></th></tr>
          </thead>
          <tbody>
            {transfers.data.items.map((t) => (
              <tr key={t.transferId}>
                <td><Time value={t.requestedAt} /></td>
                <td>
                  <span className={`tag ${t.state}`}>{TRANSFER_STATE[t.state]}</span>
                  {t.decisionReason && <div className="muted">{t.decisionReason}</div>}
                </td>
                <td><code>{t.toAccountId}</code></td>
                <td>{t.publicReason}</td>
                <td>
                  {t.state === 'requested' && (
                    <button
                      className="link"
                      onClick={() =>
                        void api
                          .POST('/api/publisher/key-transfers/{transferId}/cancel', { params: { path: { transferId: t.transferId }, header: ifMatch(t.rev) } })
                          .then(reload, (e: unknown) => setCancelError(describe(e)))
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
      {cancelError && <p className="error" role="alert">{cancelError}</p>}
      {pub.data?.status === 'active' && pub.data.activeAccountId && !pending && <RequestTransfer onDone={reload} />}
    </section>
  );
}

function RequestTransfer({ onDone }: { onDone: () => void }) {
  const { api } = useSession();
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [made, setMade] = useState<{ key: PublisherKey; file: KeyFile }>();
  const [saved, setSaved] = useState(false);
  const [reason, setReason] = useState<keyof typeof REASONS>('lost');
  const [publicReason, setPublicReason] = useState('チャンネル提供者の鍵の紛失');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = () =>
    run(async () => {
      const key = made!.key;
      const { data: challenge } = await api.POST('/api/publisher/keys/challenge');
      if (!challenge) throw new Error('一度きりの文字列を受け取れませんでした');
      const signature = await sign(key, new TextEncoder().encode(challenge.message));
      await api.POST('/api/publisher/key-transfers', {
        body: {
          nonce: challenge.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signature),
          reason, publicReason, ...(note ? { note } : {}),
        },
      });
      onDone();
    });

  return (
    <div className="action">
      <h3>移し替えを申し出る</h3>
      {!made ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => setMade(await createKey(pass1))); }}>
          <p>まず新しい鍵を作ります。秘密鍵はこの画面の中で作り、サーバーには送りません。</p>
          <label>
            新しい鍵の合言葉（{MIN_PASSPHRASE} 文字以上）
            <input type="password" required minLength={MIN_PASSPHRASE} value={pass1} onChange={(e) => setPass1(e.target.value)} />
          </label>
          <label>
            合言葉（確認）
            <input type="password" required value={pass2} onChange={(e) => setPass2(e.target.value)} />
          </label>
          <button disabled={busy || pass1.length < MIN_PASSPHRASE || pass1 !== pass2}>新しい鍵を作る</button>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <p>新しいアカウントID: <code>{made.key.accountId}</code></p>
          <button type="button" onClick={() => { download(made.file); setSaved(false); }}>新しい鍵のファイルを保存する</button>
          <label>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> 新しい鍵のファイルを、なくさない場所に保存しました
          </label>
          <label>
            理由
            <select value={reason} onChange={(e) => setReason(e.target.value as keyof typeof REASONS)}>
              {Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>
            散策者に見せる理由（アプリで一度表示されます。60 文字まで）
            <input required maxLength={60} value={publicReason} onChange={(e) => setPublicReason(e.target.value)} />
          </label>
          <label>
            運営への説明（本人確認の手がかり。公開しません）
            <textarea maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button disabled={busy || !saved || !publicReason.trim()}>移し替えを申し出る</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
