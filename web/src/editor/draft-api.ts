import type { Problem, Schemas } from '@yorisoi-console/api-types';
import { ApiProblem } from '../api';
import type { Auth } from '../auth';
import type { Kind } from './draft';

/**
 * The draft's ZIP to and from the console API (API-001 C-28). It goes as bytes, so it uses
 * `fetch` rather than the JSON client; errors are the same Problem Details.
 */
export interface StoredDraft {
  zip: Uint8Array;
  rev: number;
}

const base = (kind: Kind, id: string) => `/api/${kind === 'channel' ? 'channels' : 'collections'}/${encodeURIComponent(id)}/draft`;

async function send(auth: Auth, url: string, init: RequestInit): Promise<Response> {
  const user = await auth.user();
  const headers = new Headers(init.headers);
  if (user?.access_token) headers.set('Authorization', `Bearer ${user.access_token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) await auth.signIn();
  if (!res.ok && res.headers.get('content-type')?.includes('problem+json')) throw new ApiProblem((await res.json()) as Problem);
  if (!res.ok) throw new Error(`下書きを扱えませんでした（${res.status}）`);
  return res;
}

const revOf = (res: Response) => Number((res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, ''));

/** The saved draft, or undefined when there is none. */
export async function loadDraft(auth: Auth, kind: Kind, id: string): Promise<StoredDraft | undefined> {
  try {
    const res = await send(auth, base(kind, id), { method: 'GET' });
    return { zip: new Uint8Array(await res.arrayBuffer()), rev: revOf(res) };
  } catch (e) {
    if (e instanceof ApiProblem && e.problem.code === 'not_found') return undefined;
    throw e;
  }
}

/** Saves over [rev] (undefined for the first save, API-001 C-28) and returns the summary. */
export async function saveDraft(auth: Auth, kind: Kind, id: string, zip: Uint8Array, rev: number | undefined): Promise<Schemas['Draft']> {
  const res = await send(auth, base(kind, id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip', ...(rev === undefined ? { 'If-None-Match': '*' } : { 'If-Match': `"${rev}"` }) },
    body: new Blob([new Uint8Array(zip)], { type: 'application/zip' }),
  });
  return (await res.json()) as Schemas['Draft'];
}

export async function deleteDraft(auth: Auth, kind: Kind, id: string, rev: number): Promise<void> {
  await send(auth, base(kind, id), { method: 'DELETE', headers: { 'If-Match': `"${rev}"` } });
}

/** Bytes from a presigned URL (an owner's own submission, API-001 C-30). */
export async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ファイルを読めませんでした（${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}
