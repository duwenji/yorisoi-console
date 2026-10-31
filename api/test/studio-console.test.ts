import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, generateEd25519, signEd25519, utf8 } from '@yorisoi-console/protocol';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPS, type Deps, type Notice } from '../src/console/deps.js';
import type { Caller } from '../src/console/http.js';
import { route } from '../src/console/router.js';
import { CursorCodec } from '../src/console/util.js';
import { goLive, startCheck, type PlacementPorts } from '../src/studio/placement.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';

// DES-013 K-14〜K-17: the provider's approval and placements in the console, with the check run in
// process as the studio stack would.

const alice: Caller = { sub: 'sub-alice', roles: ['publisher'] };
const bob: Caller = { sub: 'sub-bob', roles: ['publisher'] };
const operator: Caller = { sub: 'op-1', roles: ['operator'] };
const CHECKS = { identity: true, name: true, content: true, history: true };

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let deps: Deps;
let check: PlacementPorts;
let clock: number;
let notices: Notice[];
let invoked: unknown[];
let studioTable: string;

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

beforeEach(async () => {
  const { db, table } = await freshTable(local.endpoint);
  const studio = await freshTable(local.endpoint);
  const relay = await freshTable(local.endpoint);
  studioTable = studio.table;
  clock = Date.parse('2026-10-31T03:00:00.000Z');
  notices = [];
  invoked = [];
  check = {
    db,
    table: studio.table,
    relayTable: relay.table,
    now: () => new Date(clock),
    settings: async () => ({ termsVersion: 1, termsUrl: '', termsUpdatedAt: '', paused: false, monthlyBudgetUsd: 5, model: { id: 'm', profile: 'm', price: { inputPerMTok: 1, outputPerMTok: 1 } } }),
    check: async (_m, _s, user) => ({ text: user.includes('投資') ? '{"ok": false, "items": ["2.2.5"]}' : '{"ok": true}', inputTokens: 10, outputTokens: 2 }),
    intake: { head: async () => undefined, read: async () => new Uint8Array(), copy: async () => {}, text: async () => undefined },
    serveAudio: async () => {},
    transcribe: async () => {},
    jobPrefix: 'studio-dev-',
    metric: () => {},
  };
  deps = {
    db,
    table,
    now: () => new Date((clock += 1)),
    cursors: new CursorCodec(randomBytes(32)),
    rootPublicKey: '',
    kmsPublicKey: async () => ({ keySpec: undefined, publicKey: new Uint8Array() }),
    requestPublish: async () => {},
    presignUpload: async (key) => ({ url: 'https://intake.example/', fields: { key } }),
    archiveUpload: async () => {},
    deleteUser: async () => {},
    publishTrial: async () => '',
    packageUrl: () => '',
    signDocument: async () => ({ payload: '', keyId: 'k', sig: '' }),
    readUpload: async () => new Uint8Array(),
    presignDownload: async () => '',
    readRecord: async () => undefined,
    writeRecord: async () => {},
    publishApproved: async () => ({ packageUrl: '', iconUrl: '' }),
    notify: async (n) => void notices.push(n),
    publishCollection: async () => '',
    apps: { sanpoguide: { ...DEFAULT_APPS.sanpoguide! } },
    studio: {
      table: studio.table,
      presignAudio: async (key, maxBytes) => ({ url: 'https://studio-intake.example/', fields: { key, max: String(maxBytes) } }),
      invokeCheck: async (event) => {
        invoked.push(event);
        if ('check' in event) await startCheck(check, event.check);
        else await goLive(check, event.publish, 'appealed');
      },
    },
  };
});

async function call(caller: Caller, method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) {
  const res = await route(deps, {
    method, path, query: {}, body: options.body, caller, requestId: 'req',
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

/** An active account with a key. */
async function account(caller: Caller, name: string) {
  await call(caller, 'POST', '/api/publisher', { body: { displayName: name, contact: `${caller.sub}@example.com` } });
  const key = generateEd25519();
  const challenge = await call(caller, 'POST', '/api/publisher/keys/challenge');
  await call(caller, 'POST', '/api/publisher/keys', {
    body: { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(key.privateKey, utf8.encode(challenge.body.message))) },
  });
  return (await call(caller, 'GET', '/api/publisher')).body.publisherId as string;
}

const APPLICATION = { displayName: '谷中銀座商店会', description: '台東区の商店会。公式サイトの連絡先から運営にメールします', plans: '週末の催しを商店街の周りで、月に 2〜3 件', agreedVersion: 1 };
const PLACEMENT = { text: '今日 15 時から、夕やけだんだんで豆まきをします', cells: ['xn77h2', 'xn77h3'], startsAt: '2026-10-31T00:00:00.000Z', endsAt: '2026-11-02T00:00:00.000Z', hours: { from: '10:00', to: '18:00' } };

/** Alice applied and the operator approved her. */
async function approved() {
  const publisherId = await account(alice, '谷中銀座商店会');
  await call(alice, 'POST', '/api/studio/application', { body: APPLICATION });
  const { body } = await call(operator, 'GET', `/api/admin/publishers/${publisherId}/studio`);
  await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/approve`, { ifMatch: body.rev, body: { checks: CHECKS } });
  return publisherId;
}

const cellCopy = async (cell: string, id: string) => (await deps.db.send(new GetCommand({ TableName: studioTable, Key: { PK: `CELL#${cell}`, SK: `P#${id}` } }))).Item;

describe('the provider’s approval', () => {
  it('is applied for, queued, and approved only with the four checks (掲載の決まり 1.3・1.4)', async () => {
    const publisherId = await account(alice, '谷中銀座商店会');
    expect((await call(alice, 'GET', '/api/studio')).body).toEqual({ publisherId, status: 'none', rev: 0 });
    expect((await call(alice, 'POST', '/api/studio/application', { body: { ...APPLICATION, agreedVersion: 0 } })).body.code).toBe('invalid_request');
    const applied = await call(alice, 'POST', '/api/studio/application', { body: APPLICATION });
    expect(applied.body).toMatchObject({ status: 'requested', displayName: '谷中銀座商店会', rev: 1 });
    expect((await call(alice, 'POST', '/api/studio/application', { body: APPLICATION })).body.code).toBe('invalid_state');

    const queue = await call(operator, 'GET', '/api/admin/studio/applications');
    expect(queue.body.items.map((i: { publisherId: string }) => i.publisherId)).toEqual([publisherId]);
    expect((await call(alice, 'GET', '/api/admin/studio/applications')).body.code).toBe('forbidden');

    const half = await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/approve`, { ifMatch: 1, body: { checks: { ...CHECKS, history: false } } });
    expect(half.body.code).toBe('invalid_request');
    const ok = await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/approve`, { ifMatch: 1, body: { checks: CHECKS } });
    expect(ok.body).toMatchObject({ status: 'approved', checks: CHECKS, rev: 2 });
    expect((await call(operator, 'GET', '/api/admin/studio/applications')).body.items).toEqual([]);
    expect(notices.map((n) => n.event)).toEqual(['studio.approved']);
  });

  it('can be declined with a reason and applied for again', async () => {
    const publisherId = await account(alice, 'x');
    await call(alice, 'POST', '/api/studio/application', { body: APPLICATION });
    expect((await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/decline`, { ifMatch: 1, body: {} })).body.code).toBe('invalid_request');
    const declined = await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/decline`, { ifMatch: 1, body: { reason: '1.3.1 本人確認ができませんでした' } });
    expect(declined.body).toMatchObject({ status: 'declined', reason: '1.3.1 本人確認ができませんでした' });
    expect((await call(alice, 'POST', '/api/studio/application', { body: APPLICATION })).body.status).toBe('requested');
  });
});

describe('placements', () => {
  it('need the approval', async () => {
    await account(alice, 'x');
    expect((await call(alice, 'POST', '/api/studio/placements', { body: PLACEMENT })).body.code).toBe('studio_not_approved');
  });

  it('go up at once when the check passes, in each cell, and can be stopped (F-18〜F-20)', async () => {
    await approved();
    const created = await call(alice, 'POST', '/api/studio/placements', { body: PLACEMENT });
    expect(created.status).toBe(201);
    const id = created.body.placement.placementId as string;
    expect(created.body.placement).toMatchObject({ providerName: '谷中銀座商店会', state: 'checking' });
    expect(created.body.upload).toBeUndefined();
    expect(invoked).toEqual([{ check: id }]);

    const [listed] = (await call(alice, 'GET', '/api/studio/placements')).body.items;
    expect(listed).toMatchObject({ placementId: id, state: 'live', hours: { from: '10:00', to: '18:00' } });
    expect(await cellCopy('xn77h3', id)).toBeDefined();

    expect((await call(bob, 'POST', `/api/studio/placements/${id}/stop`, { ifMatch: listed.rev })).status).toBe(404);
    const stopped = await call(alice, 'POST', `/api/studio/placements/${id}/stop`, { ifMatch: listed.rev });
    expect(stopped.body.state).toBe('stopped');
    expect(await cellCopy('xn77h2', id)).toBeUndefined();
  });

  it('with audio wait for the upload, then start the check', async () => {
    await approved();
    const created = await call(alice, 'POST', '/api/studio/placements', { body: { ...PLACEMENT, audio: { bytes: 200_000 } } });
    const id = created.body.placement.placementId as string;
    expect(created.body).toMatchObject({ placement: { state: 'uploading' }, upload: { fields: { key: `uploads/${id}.m4a` }, maxBytes: 524288 } });
    expect(invoked).toEqual([]);
    const submitted = await call(alice, 'POST', `/api/studio/placements/${id}/submit`, { ifMatch: 1 });
    expect(invoked).toEqual([{ check: id }]);
    // Nothing reached the (fake) intake: the check returns it.
    expect(submitted.body).toMatchObject({ state: 'returned', check: { items: ['audio_missing'] } });
  });

  it('come back when the check flags them; an appeal goes to the operator, who can put it up or not', async () => {
    const publisherId = await approved();
    const flagged = await call(alice, 'POST', '/api/studio/placements', { body: { ...PLACEMENT, text: '投資の勉強会を開きます' } });
    const id = flagged.body.placement.placementId as string;
    let p = (await call(alice, 'GET', '/api/studio/placements')).body.items[0];
    expect(p).toMatchObject({ state: 'returned', check: { items: ['2.2.5'] } });

    expect((await call(alice, 'POST', `/api/studio/placements/${id}/appeal`, { ifMatch: p.rev, body: {} })).body.code).toBe('invalid_request');
    const appealed = await call(alice, 'POST', `/api/studio/placements/${id}/appeal`, { ifMatch: p.rev, body: { message: '子ども向けのお金の教室で、勧誘ではありません' } });
    expect(appealed.body).toMatchObject({ state: 'appealed', appeal: { message: '子ども向けのお金の教室で、勧誘ではありません' } });

    const appeals = await call(operator, 'GET', '/api/admin/studio/appeals');
    expect(appeals.body.items.map((i: { placementId: string }) => i.placementId)).toEqual([id]);
    p = appeals.body.items[0];
    expect((await call(operator, 'POST', `/api/admin/studio/placements/${id}/reject`, { ifMatch: p.rev, body: {} })).body.code).toBe('invalid_request');
    const published = await call(operator, 'POST', `/api/admin/studio/placements/${id}/publish`, { ifMatch: p.rev, body: { message: '内容を確かめました' } });
    expect(published.body).toMatchObject({ state: 'live', decision: { message: '内容を確かめました' } });
    expect(invoked).toContainEqual({ publish: id });
    expect((await call(operator, 'GET', '/api/admin/studio/appeals')).body.items).toEqual([]);
    expect(notices.at(-1)).toMatchObject({ event: 'placement.published', publisherId, placementId: id });
  });

  it('check their times, cells and hours', async () => {
    await approved();
    const bad = async (body: object) => (await call(alice, 'POST', '/api/studio/placements', { body: { ...PLACEMENT, ...body } })).body.code;
    expect(await bad({ cells: [] })).toBe('invalid_request');
    expect(await bad({ cells: ['xn77h2', 'xn77h2'] })).toBe('invalid_request');
    expect(await bad({ cells: ['xn77h'] })).toBe('invalid_request');
    expect(await bad({ endsAt: '2026-10-31T12:00:00.000Z' })).toBe('invalid_request');
    expect(await bad({ endsAt: '2026-12-15T00:00:00.000Z' })).toBe('invalid_request');
    expect(await bad({ startsAt: '2026-12-15T00:00:00.000Z', endsAt: '2026-12-16T00:00:00.000Z' })).toBe('invalid_request');
    expect(await bad({ hours: { from: '18:00', to: '10:00' } })).toBe('invalid_request');
    expect(await bad({ audio: { bytes: 600_000 } })).toBe('invalid_request');
  });
});

describe('suspending and revoking', () => {
  it('takes live placements down, blocks new ones, and resumes', async () => {
    const publisherId = await approved();
    const id = (await call(alice, 'POST', '/api/studio/placements', { body: PLACEMENT })).body.placement.placementId as string;
    const rev = (await call(operator, 'GET', `/api/admin/publishers/${publisherId}/studio`)).body.rev;
    const tooShort = await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/suspend`, { ifMatch: rev, body: { reason: '4.3', until: '2026-11-05T00:00:00.000Z' } });
    expect(tooShort.body.code).toBe('invalid_request');
    const suspended = await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/suspend`, { ifMatch: rev, body: { reason: '4.3 軽い違反を直さない', until: '2026-12-31T00:00:00.000Z' } });
    expect(suspended.body).toMatchObject({ status: 'suspended', suspendedUntil: '2026-12-31T00:00:00.000Z' });
    expect((await call(alice, 'GET', '/api/studio/placements')).body.items[0].state).toBe('suspended');
    expect(await cellCopy('xn77h2', id)).toBeUndefined();
    expect((await call(alice, 'POST', '/api/studio/placements', { body: PLACEMENT })).body.code).toBe('studio_not_approved');

    const resumed = await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/resume`, { ifMatch: suspended.body.rev });
    expect(resumed.body.status).toBe('approved');
    expect(resumed.body.reason).toBeUndefined();
    expect((await call(alice, 'POST', '/api/studio/placements', { body: PLACEMENT })).status).toBe(201);
  });

  it('a suspension that has run out counts as approved', async () => {
    const publisherId = await approved();
    const rev = (await call(operator, 'GET', `/api/admin/publishers/${publisherId}/studio`)).body.rev;
    await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/suspend`, { ifMatch: rev, body: { reason: 'r', until: '2026-12-01T03:00:00.000Z' } });
    clock = Date.parse('2026-12-02T00:00:00.000Z');
    expect((await call(alice, 'GET', '/api/studio')).body.status).toBe('approved');
    expect((await call(alice, 'POST', '/api/studio/placements', { body: { ...PLACEMENT, startsAt: '2026-12-02T00:00:00.000Z', endsAt: '2026-12-03T00:00:00.000Z' } })).status).toBe(201);
  });

  it('revoking removes placements and keeps the provider out for a year', async () => {
    const publisherId = await approved();
    await call(alice, 'POST', '/api/studio/placements', { body: PLACEMENT });
    const rev = (await call(operator, 'GET', `/api/admin/publishers/${publisherId}/studio`)).body.rev;
    const revoked = await call(operator, 'POST', `/api/admin/publishers/${publisherId}/studio/revoke`, { ifMatch: rev, body: { reason: '2.2.12 なりすまし' } });
    expect(revoked.body).toMatchObject({ status: 'revoked', reapplyAfter: expect.stringMatching(/^2027-10-31/) });
    expect((await call(alice, 'GET', '/api/studio/placements')).body.items[0].state).toBe('removed');
    expect((await call(alice, 'POST', '/api/studio/application', { body: APPLICATION })).body.code).toBe('invalid_state');
    clock = Date.parse('2027-11-01T00:00:00.000Z');
    expect((await call(alice, 'POST', '/api/studio/application', { body: APPLICATION })).body.status).toBe('requested');
    expect(notices.map((n) => n.event)).toContain('studio.revoked');
  });

  it('is written to the audit log', async () => {
    const publisherId = await approved();
    const audit = await deps.db.send(
      new QueryCommand({ TableName: deps.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :t', ExpressionAttributeValues: { ':t': `TARGET#PUB#${publisherId}` } }),
    );
    expect((audit.Items ?? []).map((a) => a.action)).toEqual(expect.arrayContaining(['studio.apply', 'studio.approve']));
  });
});

describe('without the studio', () => {
  it('answers 404', async () => {
    await account(alice, 'x');
    delete deps.studio;
    expect((await call(alice, 'GET', '/api/studio/placements')).status).toBe(404);
  });
});
