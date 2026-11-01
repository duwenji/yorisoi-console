import { useState, type FormEvent } from 'react';
import { describe } from '../api';
import { useSession } from '../main';
import { Empty, Status, Time, useLoad } from './common';

const DAY = 24 * 3600_000;

/**
 * Signing keys (in KMS) and keysets (signed by the root key offline, ARCH-001 A-8, A-9). The steps:
 * register a KMS key here, copy the keyset input to the offline machine, sign it with
 * `sanpo-root-key sign-keyset`, and paste the signed keyset back.
 */
export function KeysPage() {
  const { api } = useSession();
  const keys = useLoad(async () => (await api.GET('/api/admin/signing-keys')).data, [api]);
  const keysets = useLoad(async () => (await api.GET('/api/admin/keysets', { params: { query: { limit: 20 } } })).data, [api]);

  const [keyId, setKeyId] = useState('');
  const [arn, setArn] = useState('');
  const [keyMessage, setKeyMessage] = useState<string>();
  const registerKey = async (e: FormEvent) => {
    e.preventDefault();
    setKeyMessage(undefined);
    try {
      await api.POST('/api/admin/signing-keys', { body: { keyId, kmsKeyArn: arn } });
      setKeyId('');
      setArn('');
      keys.reload();
    } catch (err) {
      setKeyMessage(describe(err));
    }
  };

  const latestSeq = keysets.data?.items[0]?.seq ?? 0;
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState(180);
  const input = {
    seq: latestSeq + 1,
    keys: (keys.data?.items ?? [])
      .filter((k) => selected.includes(k.keyId))
      .map((k) => ({
        keyId: k.keyId,
        publicKey: k.publicKey,
        notBefore: new Date(Date.now() - DAY).toISOString(),
        notAfter: new Date(Date.now() + days * DAY).toISOString(),
      })),
    revokedKeys: keysets.data?.items[0]?.revokedKeyIds ?? [],
  };

  const [signed, setSigned] = useState('');
  const [setMessage, setSetMessage] = useState<string>();
  const registerKeyset = async (e: FormEvent) => {
    e.preventDefault();
    setSetMessage(undefined);
    let document: unknown;
    try {
      document = JSON.parse(signed);
    } catch {
      setSetMessage('JSON として読めません。sign-keyset が書き出したファイルの中身をそのまま貼り付けてください。');
      return;
    }
    try {
      await api.POST('/api/admin/keysets', { body: { document: document as never } });
      setSigned('');
      setSetMessage('登録しました。リストを作り直しています。');
      keys.reload();
      keysets.reload();
    } catch (err) {
      setSetMessage(describe(err));
    }
  };

  return (
    <section>
      <h1>署名鍵・鍵セット</h1>

      <h2>署名鍵（KMS）</h2>
      <Status error={keys.error} loading={keys.loading} />
      {keys.data?.items.length === 0 && <Empty>署名鍵がありません。</Empty>}
      {keys.data && keys.data.items.length > 0 && (
        <table>
          <thead>
            <tr><th>鍵 ID</th><th>状態</th><th>有効期間</th><th>KMS</th><th>鍵セットに入れる</th></tr>
          </thead>
          <tbody>
            {keys.data.items.map((k) => (
              <tr key={k.keyId}>
                <td><code>{k.keyId}</code></td>
                <td><span className={`tag ${k.status}`}>{k.status}</span></td>
                <td><Time value={k.notBefore} /> 〜 <Time value={k.notAfter} /></td>
                <td><code className="small">{k.kmsKeyArn}</code></td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${k.keyId} を鍵セットに入れる`}
                    disabled={k.status === 'revoked'}
                    checked={selected.includes(k.keyId)}
                    onChange={(e) => setSelected((s) => (e.target.checked ? [...s, k.keyId] : s.filter((x) => x !== k.keyId)))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="action" onSubmit={(e) => void registerKey(e)}>
        <h3>KMS の鍵を登録する</h3>
        <label>
          鍵 ID（k-年-月）
          <input required pattern="k-[0-9]{4}-[0-9]{2}" placeholder="k-2027-04" value={keyId} onChange={(e) => setKeyId(e.target.value)} />
        </label>
        <label>
          KMS の鍵の ARN（ECC_NIST_EDWARDS25519）
          <input required value={arn} onChange={(e) => setArn(e.target.value)} />
        </label>
        <button>登録する</button>
        {keyMessage && <p className="error" role="alert">{keyMessage}</p>}
      </form>

      <h2>新しい鍵セットを作る</h2>
      <ol className="steps">
        <li>上の表で、鍵セットに入れる署名鍵を選ぶ（入れ替えの間は、新旧の両方を入れる）</li>
        <li>
          有効期間（日、366 以下）: <input type="number" min={1} max={366} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </li>
        <li>
          下の JSON をオフラインの端末に写し、<code>sanpo-root-key sign-keyset --root-key root-key.pem --in keyset-input.json --out keyset.json</code> で署名する
        </li>
        <li>できた keyset.json の中身を、その下に貼り付けて登録する</li>
      </ol>
      <pre className="copy">{JSON.stringify(input, null, 2)}</pre>
      <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(input, null, 2))} disabled={input.keys.length === 0}>
        コピー
      </button>

      <form className="action" onSubmit={(e) => void registerKeyset(e)}>
        <h3>署名した鍵セットを登録する</h3>
        <label>
          keyset.json の中身
          <textarea required rows={6} value={signed} onChange={(e) => setSigned(e.target.value)} />
        </label>
        <button>登録する</button>
        {setMessage && <p role="status">{setMessage}</p>}
      </form>

      <h2>鍵セットの履歴</h2>
      <Status error={keysets.error} loading={keysets.loading} />
      {keysets.data?.items.length === 0 && <Empty>まだ鍵セットがありません。</Empty>}
      <ul className="plain">
        {keysets.data?.items.map((k) => (
          <li key={k.seq}>
            seq {k.seq}（<Time value={k.registeredAt} />）: {(k.keyIds ?? []).join('、') || '—'}
            {(k.revokedKeyIds ?? []).length > 0 && <> ／ 失効: {k.revokedKeyIds!.join('、')}</>}
          </li>
        ))}
      </ul>
    </section>
  );
}
