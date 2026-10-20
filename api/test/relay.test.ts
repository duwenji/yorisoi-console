import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readSettings } from '../src/relay/aws.js';
import { route } from '../src/relay/handler.js';
import { checkVerdict, type IntegrityPayload } from '../src/relay/integrity.js';
import { resetsAt, type ModelChoice, type ModelReply, type RelayPorts, type Settings } from '../src/relay/relay.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';

const PKG = 'io.github.duwenji.yorisoi.sanpoguide';
const INSTALL = '0b6f3c1e-8a2d-4f0b-9a57-3c2e1d4b5a69';
const HAIKU_45: ModelChoice = { id: 'haiku-4-5', profile: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0', price: { inputPerMTok: 1.1, outputPerMTok: 5.5 } };
const DEEPSEEK: ModelChoice = { id: 'deepseek-v3-2', profile: 'deepseek.v3.2', price: { inputPerMTok: 0.74, outputPerMTok: 2.22 } };

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let ports: RelayPorts;
let now: Date;
let reply: ModelReply | Error;
let calls: { model: string; system: string; user: string }[];
let metrics: Record<string, number>;
let integrity: ((token: string) => string | undefined) | undefined;
let settings: Settings;
let counter: number;

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

beforeEach(async () => {
  const fresh = await freshTable(local.endpoint);
  now = new Date('2026-10-19T03:00:00.000Z'); // 12:00 in Japan
  reply = { text: 'こんにちは', stop: 'end', inputTokens: 2000, outputTokens: 300 };
  calls = [];
  metrics = {};
  integrity = undefined;
  settings = { dailyLimit: 3, monthlyBudgetUsd: 5, model: DEEPSEEK };
  counter = 0;
  ports = {
    db: fresh.db,
    table: fresh.table,
    now: () => now,
    random: () => `r${++counter}`,
    installKey: 'test-key',
    packages: [PKG],
    settings: async () => settings,
    get verifyIntegrity() {
      return integrity ? async (token: string) => integrity!(token) : undefined;
    },
    generate: async (model, system, user) => {
      calls.push({ model: model.profile, system, user });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    metric: (name, value) => {
      metrics[name] = (metrics[name] ?? 0) + value;
    },
  };
});

function event(method: string, resource: string, body?: unknown, token?: string): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    resource,
    path: resource,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? null : JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent;
}

async function call(method: string, resource: string, body?: unknown, token?: string) {
  const res = await route(event(method, resource, body, token), ports);
  return { status: res.statusCode, type: res.headers?.['content-type'], body: JSON.parse(res.body) };
}

async function open(installId = INSTALL) {
  const { body: c } = await call('POST', '/v1/session/challenge');
  const res = await call('POST', '/v1/session', { installId, nonce: c.nonce, integrityToken: 'it', app: { package: PKG, versionCode: 4 } });
  return res;
}

async function token() {
  const res = await open();
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const narrate = (t: string, over: object = {}) => call('POST', '/v1/generate', { kind: 'guide', system: 's', user: 'u', ...over }, t);

describe('sessions', () => {
  it('gives a token for 24 hours and today’s quota', async () => {
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBe('2026-10-20T03:00:00.000Z');
    expect(res.body.quota).toEqual({ limit: 3, remaining: 3, resetsAt: '2026-10-19T15:00:00.000Z' });
  });

  it('takes a nonce once and only within 5 minutes (V-02)', async () => {
    const { body: c } = await call('POST', '/v1/session/challenge');
    const body = { installId: INSTALL, nonce: c.nonce, app: { package: PKG, versionCode: 4 } };
    expect((await call('POST', '/v1/session', body)).status).toBe(200);
    expect((await call('POST', '/v1/session', body)).body.code).toBe('nonce_invalid');

    const { body: late } = await call('POST', '/v1/session/challenge');
    now = new Date(now.getTime() + 301_000);
    expect((await call('POST', '/v1/session', { ...body, nonce: late.nonce })).body.code).toBe('nonce_invalid');
  });

  it('refuses a failing or missing Integrity verdict when it checks (V-01)', async () => {
    integrity = (t) => (t === 'good' ? undefined : 'device');
    const { body: c1 } = await call('POST', '/v1/session/challenge');
    const bad = await call('POST', '/v1/session', { installId: INSTALL, nonce: c1.nonce, integrityToken: 'bad', app: { package: PKG, versionCode: 4 } });
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe('integrity_failed');
    expect(metrics.IntegrityFailed).toBe(1);

    const { body: c2 } = await call('POST', '/v1/session/challenge');
    const missing = await call('POST', '/v1/session', { installId: INSTALL, nonce: c2.nonce, app: { package: PKG, versionCode: 4 } });
    expect(missing.body.code).toBe('integrity_failed');

    const { body: c3 } = await call('POST', '/v1/session/challenge');
    const good = await call('POST', '/v1/session', { installId: INSTALL, nonce: c3.nonce, integrityToken: 'good', app: { package: PKG, versionCode: 4 } });
    expect(good.status).toBe(200);
  });

  it('refuses other apps and malformed ids', async () => {
    const { body: c } = await call('POST', '/v1/session/challenge');
    expect((await call('POST', '/v1/session', { installId: INSTALL, nonce: c.nonce, app: { package: 'com.example', versionCode: 1 } })).body.code).toBe('integrity_failed');
    expect((await call('POST', '/v1/session', { installId: 'abc', nonce: c.nonce, app: { package: PKG, versionCode: 1 } })).body.code).toBe('invalid_request');
  });

  it('opens at most 5 sessions a day per install', async () => {
    for (let i = 0; i < 5; i++) expect((await open()).status).toBe(200);
    const sixth = await open();
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('too_many_requests');
  });

  it('refuses an expired or unknown token (V-06)', async () => {
    const t = await token();
    expect((await call('GET', '/v1/quota', undefined, t)).status).toBe(200);
    expect((await call('GET', '/v1/quota', undefined, 'nope')).body.code).toBe('token_invalid');
    now = new Date(now.getTime() + 24 * 3600 * 1000);
    const res = await call('GET', '/v1/quota', undefined, t);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_invalid');
  });
});

describe('generating', () => {
  it('passes the prompt through and counts the call', async () => {
    const t = await token();
    const res = await narrate(t, { system: '固定の指示', user: 'スポット' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'こんにちは', quota: { limit: 3, remaining: 2, resetsAt: '2026-10-19T15:00:00.000Z' }, usage: { inputTokens: 2000, outputTokens: 300 } });
    expect(calls).toEqual([{ model: 'deepseek.v3.2', system: '固定の指示', user: 'スポット' }]);
  });

  it('stops at the limit and starts again after midnight in Japan (V-03, V-04)', async () => {
    const t = await token();
    for (let i = 0; i < 3; i++) expect((await narrate(t)).status).toBe(200);
    const over = await narrate(t);
    expect(over.status).toBe(429);
    expect(over.type).toBe('application/problem+json');
    expect(over.body).toMatchObject({ code: 'daily_limit_reached', quota: { limit: 3, remaining: 0, resetsAt: '2026-10-19T15:00:00.000Z' } });
    expect(calls).toHaveLength(3);

    now = new Date('2026-10-19T15:00:00.000Z');
    expect((await narrate(t)).body.quota.remaining).toBe(2);
  });

  it('follows a changed limit the same day (R-14)', async () => {
    const t = await token();
    await narrate(t);
    await narrate(t);
    settings = { ...settings, dailyLimit: 5 };
    expect((await call('GET', '/v1/quota', undefined, t)).body.remaining).toBe(3);
    settings = { ...settings, dailyLimit: 1 };
    expect((await call('GET', '/v1/quota', undefined, t)).body.remaining).toBe(0);
    expect((await narrate(t)).body.code).toBe('daily_limit_reached');
  });

  it('does not count what it refuses or what the service fails, but counts refusals and cut-offs (V-05)', async () => {
    const t = await token();
    const long = await narrate(t, { user: 'あ'.repeat(6001) });
    expect(long.status).toBe(413);
    expect(long.body.code).toBe('input_too_long');

    reply = Object.assign(new Error('throttled'), { status: 429 });
    const failed = await narrate(t);
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('upstream_error');
    expect((await call('GET', '/v1/quota', undefined, t)).body.remaining).toBe(3);

    reply = { text: '', stop: 'refusal', inputTokens: 100, outputTokens: 0 };
    expect((await narrate(t)).body).toMatchObject({ code: 'model_refused', quota: { remaining: 2 } });
    reply = { text: '…', stop: 'max_tokens', inputTokens: 100, outputTokens: 1024 };
    expect((await narrate(t)).body).toMatchObject({ code: 'incomplete_output', quota: { remaining: 1 } });
  });

  it('pauses when the month’s spend reaches the budget (V-07)', async () => {
    settings = { dailyLimit: 100, monthlyBudgetUsd: 0.005, model: DEEPSEEK };
    const t = await token();
    // 2,000 × 0.74 + 300 × 2.22 = 2,146 micro-USD a call: the third call passes the budget.
    expect((await narrate(t)).status).toBe(200);
    expect((await narrate(t)).status).toBe(200);
    expect((await narrate(t)).status).toBe(200);
    const paused = await narrate(t);
    expect(paused.status).toBe(503);
    expect(paused.body.code).toBe('relay_paused');
    expect(metrics.RelayPaused).toBe(1);
    expect(metrics.SpendRatio).toBeGreaterThan(1);
  });

  it('calls the model the operator chose and counts its price (R-5)', async () => {
    settings = { dailyLimit: 100, monthlyBudgetUsd: 0.01, model: HAIKU_45 };
    const t = await token();
    // 2,000 × 1.1 + 300 × 5.5 = 3,850 micro-USD a call: the budget of 10,000 lasts three calls.
    for (let i = 0; i < 3; i++) expect((await narrate(t)).status).toBe(200);
    expect((await narrate(t)).body.code).toBe('relay_paused');
    expect(calls.map((c) => c.model)).toEqual(Array(3).fill('jp.anthropic.claude-haiku-4-5-20251001-v1:0'));
  });

  it('keeps no prompt, reply or install id in the table (V-08)', async () => {
    const t = await token();
    await narrate(t, { system: 'SYSTEM-SECRET', user: 'USER-SECRET' });
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
    const items = JSON.stringify((await ports.db.send(new ScanCommand({ TableName: ports.table }))).Items);
    for (const secret of ['SYSTEM-SECRET', 'USER-SECRET', 'こんにちは', INSTALL, t]) expect(items).not.toContain(secret);
  });

  it('checks the kind and the body', async () => {
    const t = await token();
    expect((await narrate(t, { kind: 'other' })).body.code).toBe('invalid_request');
    const res = await route({ ...event('POST', '/v1/generate', undefined, t), body: '{' }, ports);
    expect(JSON.parse(res.body).code).toBe('invalid_request');
  });
});

describe('settings (R-5, R-14, V-12)', () => {
  const defaults = { monthlyBudgetUsd: 5, models: [DEEPSEEK, HAIKU_45], model: 'deepseek-v3-2' };
  let seen: Record<string, number>;
  const metric = (name: string, value: number) => (seen[name] = value);
  beforeEach(() => (seen = {}));

  it('uses 5 to 100 as set, and 30 with a report otherwise', () => {
    expect(readSettings({ dailyLimit: '50', monthlyBudgetUsd: '20', model: 'deepseek-v3-2' }, defaults, metric)).toEqual({ dailyLimit: 50, monthlyBudgetUsd: 20, model: DEEPSEEK });
    expect(seen.InvalidSetting).toBe(0);
    for (const bad of ['4', '101', '30.5', 'many', undefined]) {
      expect(readSettings({ dailyLimit: bad, monthlyBudgetUsd: '20', model: 'deepseek-v3-2' }, defaults, metric).dailyLimit).toBe(30);
      expect(seen.InvalidSetting).toBe(1);
    }
    expect(readSettings({ dailyLimit: '30', monthlyBudgetUsd: '-1', model: 'deepseek-v3-2' }, defaults, metric).monthlyBudgetUsd).toBe(5);
  });

  it('switches only to a listed model, and keeps the default with a report otherwise', () => {
    expect(readSettings({ dailyLimit: '30', monthlyBudgetUsd: '5', model: 'haiku-4-5' }, defaults, metric).model).toBe(HAIKU_45);
    for (const bad of ['nova-2-lite', 'haiku-5-5', 'deepseek.v3.2', '', undefined]) {
      expect(readSettings({ dailyLimit: '30', monthlyBudgetUsd: '5', model: bad }, defaults, metric).model).toBe(DEEPSEEK);
      expect(seen.InvalidSetting).toBe(1);
    }
  });
});

describe('the Integrity verdict (AR-3)', () => {
  const hash = createHash('sha256').update(`${INSTALL}.n`).digest('base64url');
  const expect_ = { packageName: PKG, requestHash: hash, now: new Date('2026-10-19T03:00:00.000Z') };
  const good: IntegrityPayload = {
    requestDetails: { requestPackageName: PKG, requestHash: hash, timestampMillis: String(expect_.now.getTime() - 10_000) },
    appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: PKG },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'] },
  };

  it('passes a genuine app on a genuine device', () => {
    expect(checkVerdict(good, expect_)).toBeUndefined();
  });

  it('names what fails', () => {
    expect(checkVerdict({ ...good, requestDetails: { ...good.requestDetails, requestHash: 'x' } }, expect_)).toBe('request_hash');
    expect(checkVerdict({ ...good, requestDetails: { ...good.requestDetails, timestampMillis: '0' } }, expect_)).toBe('stale');
    expect(checkVerdict({ ...good, appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION', packageName: PKG } }, expect_)).toBe('app');
    expect(checkVerdict({ ...good, deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] } }, expect_)).toBe('device');
    expect(checkVerdict({}, expect_)).toBe('package');
  });
});

describe('days in Japan', () => {
  it('resets at the next midnight in Japan', () => {
    expect(resetsAt(new Date('2026-10-19T14:59:59.000Z'))).toBe('2026-10-19T15:00:00.000Z');
    expect(resetsAt(new Date('2026-10-19T15:00:00.000Z'))).toBe('2026-10-20T15:00:00.000Z');
  });
});
