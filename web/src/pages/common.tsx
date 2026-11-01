import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { describe } from '../api';

/** Loads data once and on demand; shows errors in the operator's words. */
export function useLoad<T>(load: () => Promise<T | undefined>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setError(undefined);
    load().then(
      (d) => {
        setData(d);
        setLoading(false);
      },
      (e: unknown) => {
        setError(describe(e));
        setLoading(false);
      },
    );
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

const formatter = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' });

export function Time({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return <time dateTime={value} title={value}>{formatter.format(new Date(value))}</time>;
}

export function Status({ error, loading }: { error?: string | undefined; loading?: boolean }) {
  if (error) return <p className="error" role="alert">{error}</p>;
  if (loading) return <p className="muted">読み込んでいます…</p>;
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted empty">{children}</p>;
}

/**
 * A form that asks for a reason before a change (every operator action is recorded with one,
 * DM-001 AUDIT) and shows the outcome.
 */
export function ReasonForm({
  label,
  submit,
  danger,
  children,
}: {
  label: string;
  submit: (reason: string) => Promise<unknown>;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (danger && !window.confirm(`${label}してよろしいですか？`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await submit(reason);
      setReason('');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="action" onSubmit={(e) => void onSubmit(e)}>
      {children}
      <label>
        理由（操作の記録に残ります）
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className={danger ? 'danger' : ''} disabled={busy || reason.trim() === ''}>{busy ? '処理中…' : label}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

/** Why a studio or a note was reported (platform API-LOCAL-MATERIALS `reason`), as the operator reads it. */
const REPORT_REASON: Record<string, string> = {
  danger: '安全を損なう', harassment: '人を傷つける・つきまとい', ad: '宣伝・勧誘', rights: '権利の侵害', inappropriate: '聞かせるのに合わない', other: 'そのほか',
};
export const reasons = (list: string[]) => list.map((r) => REPORT_REASON[r] ?? r).join('・');
