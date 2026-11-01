import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { describe } from '../../api';
import { useSession } from '../../main';
import { MIN_PASSPHRASE, b64url, createKey, ed25519Supported, openKeyFile, sign, type KeyFile, type PublisherKey } from '../../publisher-crypto';
import { Status, useLoad } from '../common';

const STATUS: Record<string, string> = { pending_key: '鍵の紐づけ待ち', active: '有効', suspended: '停止中', deleted: '退会済み' };

/** The publisher's start page: register, then bind a key, then see where things stand. */
export function PublisherHome() {
  const { api } = useSession();
  const pub = useLoad(async () => {
    const res = await api.GET('/api/publisher').catch(() => undefined);
    return res?.data ?? null;
  }, [api]);

  if (pub.loading) return <Status loading />;
  if (pub.data === null || pub.data === undefined) return <Register onDone={pub.reload} />;
  const p = pub.data;
  return (
    <section>
      <h1>{p.displayName}</h1>
      <dl className="facts">
        <dt>状態</dt>
        <dd>
          <span className={`tag ${p.status}`}>{STATUS[p.status]}</span>
          {p.statusReason && `（${p.statusReason}）`}
        </dd>
        <dt>アカウントID</dt>
        <dd>{p.activeAccountId ? <code>{p.activeAccountId}</code> : '—'}</dd>
        <dt>チャンネル</dt>
        <dd>
          {p.usage.channels} / {p.limits.channels}
        </dd>
        <dt>今日の申請</dt>
        <dd>
          {p.usage.uploadsToday} / {p.limits.uploadsPerDay}
        </dd>
      </dl>
      {p.status === 'pending_key' && <KeySetup onBound={pub.reload} />}
      {p.status === 'active' && (
        <p>
          <Link to="/channels">チャンネルへ</Link>。パッケージの <code>channel.json</code> の <code>publisher</code> には、上のアカウントIDを書きます。
        </p>
      )}
      {p.status === 'suspended' && <p className="warn">運営が停止しています。申請はできません。理由について運営に問い合わせてください。</p>}
    </section>
  );
}

function Register({ onDone }: { onDone: () => void }) {
  const { api } = useSession();
  const [displayName, setDisplayName] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.POST('/api/publisher', { body: { displayName, contact } });
      onDone();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <section>
      <h1>チャンネル提供者として登録する</h1>
      <p>SanpoGuide のアプリにチャンネルを届けるための登録です。登録すると、次に鍵を作ってこのアカウントに紐づけます。</p>
      <form className="action" onSubmit={(e) => void submit(e)}>
        <label>
          表示名（アプリの一覧に出ます。40 文字まで）
          <input required maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          連絡先（審査や本人確認に使います。公開しません）
          <input required maxLength={200} value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>
        <button>登録する</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </section>
  );
}

/** Binds a key: proves possession by signing the server's one-time challenge (ARCH-001 A-5). */
export async function bindKey(api: ReturnType<typeof useSession>['api'], key: PublisherKey) {
  const { data: challenge } = await api.POST('/api/publisher/keys/challenge');
  if (!challenge) throw new Error('一度きりの文字列を受け取れませんでした');
  const signature = await sign(key, new TextEncoder().encode(challenge.message));
  await api.POST('/api/publisher/keys', {
    body: { nonce: challenge.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signature) },
  });
}

export function download(file: KeyFile) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `sanpo-publisher-key-${file.accountId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function KeySetup({ onBound }: { onBound: () => void }) {
  const { api } = useSession();
  const [supported, setSupported] = useState<boolean>();
  const [mode, setMode] = useState<'new' | 'file'>('new');
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [made, setMade] = useState<{ key: PublisherKey; file: KeyFile }>();
  const [saved, setSaved] = useState(false);
  const [fileText, setFileText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => void ed25519Supported().then(setSupported), []);

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

  if (supported === false) {
    return <p className="error">このブラウザは Ed25519 の鍵を扱えません。Chrome・Edge・Firefox・Safari の最新版でお試しください。</p>;
  }
  return (
    <section>
      <h2>鍵を紐づける</h2>
      <p>
        パッケージには、あなたの鍵で署名します。鍵はこの画面の中で作り、<strong>秘密鍵はサーバーに送りません</strong>。秘密鍵は合言葉で暗号化したファイルとして、あなたが保存します。
        なくすと、運営の本人確認を経ないとチャンネルを更新できなくなります。
      </p>
      <div className="inline">
        <label>
          <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> 新しい鍵を作る
        </label>
        <label>
          <input type="radio" checked={mode === 'file'} onChange={() => setMode('file')} /> 保存してある鍵のファイルを使う
        </label>
      </div>

      {mode === 'new' && !made && (
        <form className="action" onSubmit={(e) => { e.preventDefault(); void run(async () => setMade(await createKey(pass1))); }}>
          <label>
            合言葉（{MIN_PASSPHRASE} 文字以上。鍵のファイルを開くときに要ります）
            <input type="password" required minLength={MIN_PASSPHRASE} value={pass1} onChange={(e) => setPass1(e.target.value)} />
          </label>
          <label>
            合言葉（確認）
            <input type="password" required value={pass2} onChange={(e) => setPass2(e.target.value)} />
          </label>
          <button disabled={busy || pass1.length < MIN_PASSPHRASE || pass1 !== pass2}>鍵を作る</button>
        </form>
      )}
      {mode === 'new' && made && (
        <div className="action">
          <p>
            鍵を作りました。アカウントID: <code>{made.key.accountId}</code>
          </p>
          <button type="button" onClick={() => { download(made.file); setSaved(false); }}>鍵のファイルを保存する</button>
          <label>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> 鍵のファイルを、なくさない場所に保存しました（写しも取りました）
          </label>
          <button disabled={busy || !saved} onClick={() => void run(async () => { await bindKey(api, made.key); onBound(); })}>この鍵を紐づける</button>
        </div>
      )}
      {mode === 'file' && (
        <form className="action" onSubmit={(e) => { e.preventDefault(); void run(async () => { await bindKey(api, await openKeyFile(fileText, pass1)); onBound(); }); }}>
          <label>
            鍵のファイル
            <input type="file" accept="application/json,.json" required onChange={(e) => void e.target.files?.[0]?.text().then(setFileText)} />
          </label>
          <label>
            合言葉
            <input type="password" required value={pass1} onChange={(e) => setPass1(e.target.value)} />
          </label>
          <button disabled={busy || !fileText}>紐づける</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
