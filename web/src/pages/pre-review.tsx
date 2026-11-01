import { unzipSync } from 'fflate';
import { useState } from 'react';
import { describe } from '../api';
import { AI_SERVICES, listModels, preReview, type AiService, type Concern, type ReviewFile } from '../ai';

/**
 * The texts of a package the AI reads in the first review (platform AI-ROLES H-12): a channel's
 * `channel.json` and prompt slots; a collection's texts with each resource's alt (its settings say
 * what each is about).
 */
export function reviewFiles(zip: Uint8Array): ReviewFile[] {
  const decoder = new TextDecoder();
  return Object.entries(unzipSync(zip))
    .filter(([name]) => name === 'channel.json' || name === 'collection.json' || (/\.(md|txt)$/.test(name) && !name.endsWith('/')))
    .map(([name, bytes]) => ({ name, text: decoder.decode(bytes) }));
}

/**
 * The AI's first review (platform AI-ROLES H-12, 審査基準 2): what a person should look at, from the
 * reviewer's or the publisher's own key, called from the browser. The key stays in this page's
 * memory and never reaches the console. It never decides: the package may try to steer it.
 */
export function PreReview({ kind, load, who }: { kind: 'channel' | 'collection'; load: () => Promise<ReviewFile[]>; who: 'operator' | 'provider' }) {
  const [service, setService] = useState<AiService>(AI_SERVICES[0]!);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const key = keys[service.id] ?? '';
  const [models, setModels] = useState<string[]>();
  const [model, setModel] = useState('');
  const [concerns, setConcerns] = useState<Concern[]>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setError(undefined);
    setConcerns(undefined);
    setRunning(true);
    try {
      setConcerns(await preReview(service, key, model, kind, await load()));
    } catch (e) {
      setError(describe(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="action">
      <h3>AI の一次審査</h3>
      <p className="muted">
        {who === 'operator'
          ? 'AI が審査基準に照らして、確かめたほうがよい箇所を挙げます。判断の材料で、承認・差し戻しは必ずあなたが決めます。パッケージの文章が AI を誘導することがあるため、「気になる点なし」でも中身の確認は省かないでください。'
          : '申請の前に、AI が審査基準に照らして気になる箇所を挙げます。運営の審査の代わりにはなりません（運営も同じ確認をしたうえで、人が判断します）。'}
        {' '}あなたの API キーで、ブラウザから直接 AI を呼びます。キーはこのページの中だけに置き、管理システムには送りません。
      </p>
      <div className="inline">
        {AI_SERVICES.map((sv) => (
          <label key={sv.id}>
            <input type="radio" checked={service.id === sv.id} onChange={() => { setService(sv); setModels(undefined); setModel(''); }} /> {sv.label}
          </label>
        ))}
      </div>
      <label>
        {service.label} の API キー
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKeys((k) => ({ ...k, [service.id]: e.target.value }))} />
      </label>
      <button type="button" disabled={!key} onClick={() => void listModels(service, key).then((m) => { setModels(m); setModel(m[0] ?? ''); }, (e: unknown) => setError(describe(e)))}>
        モデルを読み込む
      </button>
      {models && (
        <label>
          モデル{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
      <button type="button" disabled={!key || !model || running} onClick={() => void run()}>AI に確かめてもらう</button>
      {running && <p role="status">確かめています…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {concerns && concerns.length === 0 && <p>AI が挙げた気になる点はありません。</p>}
      {concerns && concerns.length > 0 && (
        <table>
          <thead><tr><th>項目</th><th>箇所</th><th>理由</th></tr></thead>
          <tbody>{concerns.map((c, i) => <tr key={i}><td>{c.item}</td><td>{c.quote}</td><td>{c.reason}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
