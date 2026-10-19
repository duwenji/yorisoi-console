import { createHash, createHmac } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * The operator's AI relay (platform API-AI-RELAY): a session for a genuine app, today's count per
 * install, and one call to the model per narration, paid by the operator up to the daily limit.
 * Prompts and replies pass through and are never stored or logged (ADR-AI-RELAY R-13).
 */

export type RelayCode =
  | 'invalid_request'
  | 'nonce_invalid'
  | 'token_invalid'
  | 'integrity_failed'
  | 'input_too_long'
  | 'model_refused'
  | 'incomplete_output'
  | 'daily_limit_reached'
  | 'too_many_requests'
  | 'upstream_error'
  | 'relay_paused';

const STATUS: Record<RelayCode, number> = {
  invalid_request: 400,
  nonce_invalid: 400,
  token_invalid: 401,
  integrity_failed: 403,
  input_too_long: 413,
  model_refused: 422,
  incomplete_output: 422,
  daily_limit_reached: 429,
  too_many_requests: 429,
  upstream_error: 502,
  relay_paused: 503,
};

export interface Quota {
  limit: number;
  remaining: number;
  resetsAt: string;
}

export class RelayError extends Error {
  constructor(
    readonly code: RelayCode,
    detail: string,
    readonly quota?: Quota,
  ) {
    super(detail);
  }

  get status() {
    return STATUS[this.code];
  }
}

/** What the operator sets in Parameter Store (ADR-AI-RELAY R-14), already checked. */
export interface Settings {
  dailyLimit: number;
  monthlyBudgetUsd: number;
}

export interface ModelReply {
  text: string;
  stop: 'end' | 'refusal' | 'max_tokens';
  inputTokens: number;
  outputTokens: number;
}

export interface RelayPorts {
  db: DynamoDBDocumentClient;
  table: string;
  now: () => Date;
  /** `bytes` random bytes as base64url. */
  random: (bytes: number) => string;
  /** The key that turns install ids into the hashes kept (API-AI-RELAY AR-2). */
  installKey: string;
  /** Package names allowed to open a session. */
  packages: string[];
  settings: () => Promise<Settings>;
  /**
   * Checks a Play Integrity token against the package and request hash; returns why it fails, or
   * undefined when it passes. Absent on the development relay, which doesn't check (AR-4).
   */
  verifyIntegrity?: (token: string, expect: { packageName: string; requestHash: string; now: Date }) => Promise<string | undefined>;
  /** One call to the model; throws when the model's service fails. */
  generate: (system: string, user: string) => Promise<ModelReply>;
  /** USD per million tokens, for the month's spend (R-10). */
  price: { inputPerMTok: number; outputPerMTok: number };
  /** A CloudWatch metric (embedded metric format); never carries prompts or ids. */
  metric: (name: string, value: number) => void;
}

/** The limits of API-AI-RELAY「長さの上限」. */
export const MAX_SYSTEM_CHARS = 8000;
export const MAX_USER_CHARS = 6000;
export const MAX_OUTPUT_TOKENS = 1024;
export const SESSIONS_PER_DAY = 5;
const NONCE_SECONDS = 300;
const TOKEN_SECONDS = 24 * 3600;
const QUOTA_DAYS = 7;

const JST_MS = 9 * 3600 * 1000;
/** The day in Japan, `YYYY-MM-DD`; counts go back to zero at midnight there. */
export const dayOf = (now: Date) => new Date(now.getTime() + JST_MS).toISOString().slice(0, 10);
const monthOf = (now: Date) => dayOf(now).slice(0, 7);
/** The next midnight in Japan. */
export function resetsAt(now: Date): string {
  const [y, m, d] = dayOf(now).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1) - JST_MS).toISOString();
}

const epoch = (date: Date) => Math.floor(date.getTime() / 1000);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64url');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isConditionFailure(e: unknown) {
  return e instanceof ConditionalCheckFailedException || (e as { name?: string })?.name === 'ConditionalCheckFailedException';
}

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RelayError('invalid_request', 'The body must be a JSON object');
  return body as Record<string, unknown>;
}

const quotaKey = (install: string, now: Date) => ({ PK: `QUOTA#${install}`, SK: `DAY#${dayOf(now)}` });

async function quotaOf(ports: RelayPorts, install: string, limit: number): Promise<Quota> {
  const now = ports.now();
  const item = (await ports.db.send(new GetCommand({ TableName: ports.table, Key: quotaKey(install, now) }))).Item;
  const used = Number(item?.count ?? 0);
  return { limit, remaining: Math.max(0, limit - used), resetsAt: resetsAt(now) };
}

/** POST /v1/session/challenge */
export async function challenge(ports: RelayPorts) {
  const now = ports.now();
  const nonce = ports.random(32);
  const expires = new Date(now.getTime() + NONCE_SECONDS * 1000);
  await ports.db.send(
    new PutCommand({ TableName: ports.table, Item: { PK: `NONCE#${nonce}`, SK: 'NONCE', expiresAt: expires.toISOString(), ttl: epoch(expires) } }),
  );
  return { nonce, expiresAt: expires.toISOString() };
}

/** POST /v1/session */
export async function session(ports: RelayPorts, body: unknown) {
  const b = object(body);
  const { installId, nonce, integrityToken } = b;
  const app = b.app as { package?: unknown; versionCode?: unknown } | undefined;
  if (typeof installId !== 'string' || !UUID.test(installId)) throw new RelayError('invalid_request', 'installId must be a UUID (v4)');
  if (typeof nonce !== 'string' || nonce.length === 0) throw new RelayError('invalid_request', 'nonce is required');
  if (integrityToken !== undefined && typeof integrityToken !== 'string') throw new RelayError('invalid_request', 'integrityToken must be a string');
  if (typeof app?.package !== 'string' || !Number.isInteger(app.versionCode)) throw new RelayError('invalid_request', 'app.package and app.versionCode are required');
  if (!ports.packages.includes(app.package)) throw new RelayError('integrity_failed', 'This app is not allowed');

  const now = ports.now();
  // A nonce is used once and only within its 5 minutes.
  try {
    await ports.db.send(
      new DeleteCommand({
        TableName: ports.table,
        Key: { PK: `NONCE#${nonce}`, SK: 'NONCE' },
        ConditionExpression: 'attribute_exists(PK) AND expiresAt > :now',
        ExpressionAttributeValues: { ':now': now.toISOString() },
      }),
    );
  } catch (e) {
    if (isConditionFailure(e)) throw new RelayError('nonce_invalid', 'The nonce is unknown, used or expired');
    throw e;
  }

  if (ports.verifyIntegrity) {
    if (!integrityToken) throw new RelayError('integrity_failed', 'integrityToken is required');
    const reason = await ports.verifyIntegrity(integrityToken, { packageName: app.package, requestHash: sha256(`${installId}.${nonce}`), now });
    if (reason) {
      ports.metric('IntegrityFailed', 1);
      throw new RelayError('integrity_failed', 'The app could not be verified');
    }
  }

  const install = createHmac('sha256', ports.installKey).update(installId, 'utf8').digest('base64url');
  const expiresDay = new Date(now.getTime() + 2 * 24 * 3600 * 1000);
  try {
    await ports.db.send(
      new UpdateCommand({
        TableName: ports.table,
        Key: { PK: `SESSIONS#${install}`, SK: `DAY#${dayOf(now)}` },
        UpdateExpression: 'ADD #n :one SET #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
        ExpressionAttributeNames: { '#n': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':max': SESSIONS_PER_DAY, ':ttl': epoch(expiresDay) },
      }),
    );
  } catch (e) {
    if (isConditionFailure(e)) throw new RelayError('too_many_requests', 'Too many sessions today');
    throw e;
  }

  const token = ports.random(32);
  const expires = new Date(now.getTime() + TOKEN_SECONDS * 1000);
  await ports.db.send(
    new PutCommand({ TableName: ports.table, Item: { PK: `TOKEN#${sha256(token)}`, SK: 'TOKEN', install, expiresAt: expires.toISOString(), ttl: epoch(expires) } }),
  );
  const { dailyLimit } = await ports.settings();
  return { token, expiresAt: expires.toISOString(), quota: await quotaOf(ports, install, dailyLimit) };
}

/** The install a bearer token stands for. */
async function installOf(ports: RelayPorts, authorization: string | undefined): Promise<string> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  if (!token) throw new RelayError('token_invalid', 'A bearer token is required');
  const item = (await ports.db.send(new GetCommand({ TableName: ports.table, Key: { PK: `TOKEN#${sha256(token)}`, SK: 'TOKEN' } }))).Item;
  if (!item || String(item.expiresAt) <= ports.now().toISOString()) throw new RelayError('token_invalid', 'The token is unknown or expired');
  return String(item.install);
}

/** GET /v1/quota */
export async function quota(ports: RelayPorts, authorization: string | undefined): Promise<Quota> {
  const install = await installOf(ports, authorization);
  return quotaOf(ports, install, (await ports.settings()).dailyLimit);
}

/** POST /v1/generate */
export async function generate(ports: RelayPorts, authorization: string | undefined, body: unknown) {
  const install = await installOf(ports, authorization);
  const { kind, system, user } = object(body);
  if (kind !== 'guide' && kind !== 'chat') throw new RelayError('invalid_request', 'kind must be guide or chat');
  if (typeof system !== 'string' || typeof user !== 'string') throw new RelayError('invalid_request', 'system and user are required');
  if (system.length > MAX_SYSTEM_CHARS || user.length > MAX_USER_CHARS) {
    ports.metric('InputTooLong', 1);
    throw new RelayError('input_too_long', `system is up to ${MAX_SYSTEM_CHARS} characters and user up to ${MAX_USER_CHARS}`);
  }

  const now = ports.now();
  const { dailyLimit, monthlyBudgetUsd } = await ports.settings();
  const spendKey = { PK: 'SPEND', SK: `MONTH#${monthOf(now)}` };
  const spent = Number((await ports.db.send(new GetCommand({ TableName: ports.table, Key: spendKey }))).Item?.microUsd ?? 0) / 1e6;
  if (spent >= monthlyBudgetUsd) {
    ports.metric('RelayPaused', 1);
    throw new RelayError('relay_paused', 'The relay is paused for this month');
  }

  // Take one of today's calls before calling, so parallel calls can't pass the limit; give it back
  // when the model's service fails (API-AI-RELAY「回数の数え方」).
  const key = quotaKey(install, now);
  const keepUntil = epoch(new Date(now.getTime() + QUOTA_DAYS * 24 * 3600 * 1000));
  let used: number;
  try {
    const out = await ports.db.send(
      new UpdateCommand({
        TableName: ports.table,
        Key: key,
        UpdateExpression: 'ADD #n :one SET #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :limit',
        ExpressionAttributeNames: { '#n': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':limit': dailyLimit, ':ttl': keepUntil },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    used = Number(out.Attributes?.count ?? 1);
  } catch (e) {
    if (isConditionFailure(e)) throw new RelayError('daily_limit_reached', 'Today’s calls are used up', await quotaOf(ports, install, dailyLimit));
    throw e;
  }

  const started = Date.now();
  let reply: ModelReply;
  try {
    reply = await ports.generate(system, user);
  } catch (e) {
    await ports.db.send(
      new UpdateCommand({ TableName: ports.table, Key: key, UpdateExpression: 'ADD #n :minus', ExpressionAttributeNames: { '#n': 'count' }, ExpressionAttributeValues: { ':minus': -1 } }),
    );
    ports.metric('UpstreamError', 1);
    // The service's own message (access, quota, throttling); it never repeats the prompt.
    console.error(JSON.stringify({ event: 'upstream_error', kind, error: (e as Error)?.name, status: (e as { status?: number })?.status, message: String((e as Error)?.message).slice(0, 300) }));
    throw new RelayError('upstream_error', 'The AI service failed');
  }

  const microUsd = Math.ceil(reply.inputTokens * ports.price.inputPerMTok + reply.outputTokens * ports.price.outputPerMTok);
  await ports.db.send(
    new UpdateCommand({
      TableName: ports.table,
      Key: key,
      UpdateExpression: 'ADD inputTokens :i, outputTokens :o',
      ExpressionAttributeValues: { ':i': reply.inputTokens, ':o': reply.outputTokens },
    }),
  );
  const month = await ports.db.send(
    new UpdateCommand({ TableName: ports.table, Key: spendKey, UpdateExpression: 'ADD microUsd :c', ExpressionAttributeValues: { ':c': microUsd }, ReturnValues: 'UPDATED_NEW' }),
  );
  ports.metric('SpendRatio', Number(month.Attributes?.microUsd ?? 0) / 1e6 / monthlyBudgetUsd);
  ports.metric('Calls', 1);
  // Counts and sizes only: never the prompt, the reply or the install (ADR-AI-RELAY R-13).
  console.log(JSON.stringify({ event: 'generate', kind, stop: reply.stop, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, ms: Date.now() - started }));

  const left: Quota = { limit: dailyLimit, remaining: Math.max(0, dailyLimit - used), resetsAt: resetsAt(now) };
  if (reply.stop === 'refusal') throw new RelayError('model_refused', 'The AI declined', left);
  if (reply.stop === 'max_tokens') throw new RelayError('incomplete_output', 'The reply was cut off', left);
  return { text: reply.text, quota: left, usage: { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens } };
}
