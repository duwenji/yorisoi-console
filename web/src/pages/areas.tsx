import { useState, type FormEvent } from 'react';
import type { Schemas } from '@yorisoi-console/api-types';
import { describe, ifMatch } from '../api';
import { useSession } from '../main';
import { Empty, ReasonForm, Status, Time, useLoad } from './common';

// The operator's page of the closed areas (REQ-STUDIO・REQ-NOTES F-15): where neither studios nor notes may be
// put, as both are fetched by area (platform ADR-MATERIALS D-44).

export function OperatorAreas() {
  return (
    <section>
      <h1>置けない区画</h1>
      <p className="muted">学校・病院・私有地の周りなど、スタジオも一言も置けないようにする区画です。一言は置けないと出て、スタジオは作る時点で区画を選べません。</p>
      <ClosedAreas />
    </section>
  );
}

function ClosedAreas() {
  const { api } = useSession();
  const list = useLoad(async () => (await api.GET('/api/admin/local/areas')).data, [api]);
  const [cell, setCell] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const close = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.POST('/api/admin/local/areas', { body: { cell, reason } });
      setCell('');
      setReason('');
      list.reload();
    } catch (err) {
      setError(describe(err));
    }
  };
  const open = async (c: string) => {
    setError(undefined);
    try {
      await api.DELETE('/api/admin/local/areas/{cell}', { params: { path: { cell: c } } });
      list.reload();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <>
      <h2>置けない区画</h2>
      <p className="muted small">学校・病院・私有地の周りなど。一言は置けず、スタジオもその区画を選べなくなります（アプリには 5 分以内に効きます）。区画は geohash の 5〜7 文字（5 文字は約 5 km 四方、6 文字は約 1.2 km × 0.6 km、7 文字は約 150 m 四方）。</p>
      <Status error={list.error} loading={list.loading} />
      {list.data?.items.length === 0 && <Empty>ありません。</Empty>}
      <ul className="plain">
        {list.data?.items.map((a) => (
          <li key={a.cell}><code>{a.cell}</code> {a.reason} <span className="muted small"><Time value={a.createdAt} /></span> <button className="link" onClick={() => void open(a.cell)}>外す</button></li>
        ))}
      </ul>
      <form className="action" onSubmit={(e) => void close(e)}>
        <label>
          区画（geohash 5〜7 文字）
          <input required pattern="[0-9b-hjkmnp-z]{5,7}" value={cell} onChange={(e) => setCell(e.target.value.trim().toLowerCase())} />
        </label>
        <label>
          理由
          <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button>置けないようにする</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </>
  );
}
