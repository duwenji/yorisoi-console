import type { ProblemCode } from '@yorisoi-console/api-types';

/** Who is calling, from the JWT the API Gateway authorizer already verified. */
export interface Caller {
  sub: string;
  roles: ('operator' | 'publisher')[];
}

export interface Request {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
  caller: Caller;
  requestId: string;
}

export interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const STATUS: Record<ProblemCode, number> = {
  invalid_request: 400,
  invalid_signature: 400,
  challenge_invalid: 400,
  keyset_invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  publisher_not_active: 403,
  role_required: 403,
  not_found: 404,
  already_registered: 409,
  channel_id_taken: 409,
  collection_id_taken: 409,
  producer_not_verified: 409,
  resource_in_use: 409,
  account_id_taken: 409,
  key_already_bound: 409,
  transfer_pending: 409,
  limit_reached: 409,
  pending_submission_exists: 409,
  invalid_state: 409,
  version_not_newer: 409,
  precondition_failed: 412,
  precondition_required: 428,
  payload_too_large: 413,
  quota_exceeded: 429,
  throttled: 429,
  studio_not_approved: 403,
  internal: 500,
};

/** An error the API reports as RFC 9457 Problem Details with a `code` (API-001 C-2). */
export class ApiError extends Error {
  constructor(
    readonly code: ProblemCode,
    detail: string,
    readonly errors: { path: string; message: string }[] = [],
  ) {
    super(detail);
  }

  get status() {
    return STATUS[this.code];
  }
}

export const fail = (code: ProblemCode, detail: string, errors: { path: string; message: string }[] = []): never => {
  throw new ApiError(code, detail, errors);
};

const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function json(statusCode: number, body: unknown, extra: Record<string, string> = {}): Response {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...SECURITY_HEADERS, ...extra },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

/** A resource with its `rev` as ETag (API-001 C-8). */
export function withEtag(statusCode: number, body: { rev: number }): Response {
  return json(statusCode, body, { etag: `"${body.rev}"` });
}

export const noContent = (): Response => ({ statusCode: 204, headers: SECURITY_HEADERS, body: '' });

export function problem(e: ApiError, requestId: string): Response {
  const title = e.code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return {
    statusCode: e.status,
    headers: { 'content-type': 'application/problem+json', ...SECURITY_HEADERS },
    body: JSON.stringify({
      type: 'about:blank',
      title,
      status: e.status,
      code: e.code,
      detail: e.message,
      instance: requestId,
      ...(e.errors.length > 0 ? { errors: e.errors } : {}),
    }),
  };
}

/** The `rev` the client last saw, from `If-Match` (428 without it). */
export function ifMatch(req: Request): number {
  const header = req.headers['if-match'];
  if (!header) return fail('precondition_required', 'If-Match is required');
  const rev = Number(header.replace(/^W\//, '').replace(/"/g, ''));
  return Number.isInteger(rev) && rev > 0 ? rev : fail('precondition_failed', `If-Match ${header} is not a revision`);
}

export function requireOperator(req: Request) {
  if (!req.caller.roles.includes('operator')) fail('forbidden', 'operators only');
}

// Small body checks; the OpenAPI document is the contract, these keep bad input out of the table.

export function object(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : fail('invalid_request', 'the body must be a JSON object');
}

export function text(o: Record<string, unknown>, key: string, opts: { min?: number; max: number; optional?: boolean; pattern?: RegExp }): string | undefined {
  const value = o[key];
  if (value === undefined && opts.optional) return undefined;
  if (typeof value !== 'string') return fail('invalid_request', `${key} is required`, [{ path: `/${key}`, message: 'must be a string' }]);
  const length = [...value].length;
  if (length < (opts.min ?? 1) || length > opts.max) {
    fail('invalid_request', `${key} has a bad length`, [{ path: `/${key}`, message: `${opts.min ?? 1}–${opts.max} characters` }]);
  }
  if (opts.pattern && !opts.pattern.test(value)) fail('invalid_request', `${key} is malformed`, [{ path: `/${key}`, message: 'bad format' }]);
  return value;
}

export function requiredText(o: Record<string, unknown>, key: string, opts: { min?: number; max: number; pattern?: RegExp }): string {
  return text(o, key, opts) as string;
}

export function limit(req: Request): number {
  const raw = req.query.limit;
  if (raw === undefined) return 20;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : fail('invalid_request', 'limit must be 1–100');
}
