import type { Problem, paths } from '@yorisoi-console/api-types';
import createClient, { type Middleware } from 'openapi-fetch';
import type { Auth } from './auth';

/** A failed call, with the API's Problem Details (API-001 C-2). */
export class ApiProblem extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

const MESSAGES: Partial<Record<Problem['code'], string>> = {
  precondition_failed: 'ほかの人が先に変更しました。読み込み直してから、もう一度操作してください。',
  forbidden: 'この操作をする権限がありません。',
  not_found: '見つかりませんでした。',
  invalid_state: '今の状態ではこの操作はできません。',
  role_required: '素材提供者として始めてから操作してください。',
  keyset_invalid: '鍵セットが正しくありません。',
  invalid_signature: '署名が正しくありません。ルート鍵で署名した鍵セットか確かめてください。',
  throttled: '操作が多すぎます。少し待ってからもう一度お試しください。',
  internal: 'サーバーで問題が起きました。',
};

/** What to show the operator for a failed call: our wording plus the server's detail. */
export function describe(e: unknown): string {
  if (e instanceof ApiProblem) {
    const lead = MESSAGES[e.problem.code] ?? '操作できませんでした。';
    const fields = (e.problem.errors ?? []).map((x) => `${x.path}: ${x.message}`).join('、');
    return `${lead}（${e.problem.code}${e.problem.detail ? `: ${e.problem.detail}` : ''}${fields ? ` ／ ${fields}` : ''}）`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function createApi(auth: Auth) {
  const bearer: Middleware = {
    async onRequest({ request }) {
      const user = await auth.user();
      if (user?.access_token) request.headers.set('Authorization', `Bearer ${user.access_token}`);
      return request;
    },
    async onResponse({ response }) {
      if (response.status === 401) await auth.signIn();
      if (!response.ok && response.headers.get('content-type')?.includes('problem+json')) {
        throw new ApiProblem((await response.clone().json()) as Problem);
      }
      return response;
    },
  };
  const client = createClient<paths>({ baseUrl: window.location.origin });
  client.use(bearer);
  return client;
}

export type Api = ReturnType<typeof createApi>;

/** The `If-Match` value for a resource read earlier (API-001 C-8). */
export const ifMatch = (rev: number) => ({ 'If-Match': `"${rev}"` });
