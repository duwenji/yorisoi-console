import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, generateEd25519, sha256Hex, signDocument, signEd25519, utf8, verifyChannelList, verifyDiscovery } from '@yorisoi-console/protocol';
import { makeTestProvider, type TestProvider } from '@yorisoi-console/protocol/testing';
import { zipSync } from 'fflate';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPS, type Deps, type Notice } from '../src/console/deps.js';
import type { Caller } from '../src/console/http.js';
import { route } from '../src/console/router.js';
import { CursorCodec } from '../src/console/util.js';
import { DynamoStore } from '../src/publish/aws.js';
import { DISCOVERY_PATH, LIST_PATH, MemoryStorage, noCdn, publish } from '../src/publish/index.js';
import type { Trigger } from '../src/publish/ports.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';
import { memoryDrafts } from './drafts-fake.js';

const alice: Caller = { sub: 'sub-alice', roles: ['publisher'] };
const operator: Caller = { sub: 'op-1', roles: ['operator'] };
const start = new Date('2026-10-04T03:00:00.000Z');

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let deps: Deps;
let raw: DynamoDBClient;
let clock: number;
let provider: TestProvider;
let published: Trigger[];
let notices: Notice[];
let uploads: Map<string, Uint8Array>;
let records: Map<string, string>;
let archived: string[];

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

beforeEach(async () => {
  const fresh = await freshTable(local.endpoint);
  raw = fresh.raw;
  clock = start.getTime();
  provider = await makeTestProvider({ now: start });
  published = [];
  notices = [];
  uploads = new Map();
  records = new Map();
  archived = [];
  deps = {
    db: fresh.db,
    table: fresh.table,
    now: () => new Date(clock++),
    cursors: new CursorCodec(randomBytes(32)),
    rootPublicKey: b64url.encode(provider.rootKey),
    kmsPublicKey: async () => ({ keySpec: undefined, publicKey: new Uint8Array() }),
    requestPublish: async (t) => void published.push(t),
    presignUpload: async (key) => ({ url: 'https://intake.example/', fields: { key } }),
    archiveUpload: async (key) => void archived.push(key),
    deleteUser: async () => {},
    publishTrial: async (_k, sha) => `https://provider.example/trial/${sha}.zip`,
    packageUrl: (sha) => `https://provider.example/pkg/${sha}.zip`,
    signDocument: (c) => signDocument(c, provider.signing),
    readUpload: async (key) => uploads.get(key) ?? new Uint8Array(),
    presignDownload: async (key) => `https://intake.example/${key}?signed`,
    readRecord: async (key) => records.get(key),
    writeRecord: async (key, body) => void records.set(key, body),
    notify: async (n) => void notices.push(n),
    publishCollection: async (_key: string, sha: string) => `https://provider.example/col/${sha}.zip`,
    drafts: memoryDrafts(),
    apps: { sanpoguide: { ...DEFAULT_APPS.sanpoguide!, stageVersions: { 0: 1, 1: 9999, 2: 9999, 3: 9999 } } },
    publishApproved: async ({ packageSha256, iconSha256 }) => ({
      packageUrl: `https://provider.example/pkg/${packageSha256}.zip`,
      iconUrl: `https://provider.example/icons/${iconSha256}.png`,
    }),
  };
});

async function call(caller: Caller, method: string, path: string, options: { body?: unknown; ifMatch?: number; query?: Record<string, string> } = {}) {
  const res = await route(deps, {
    method, path, query: options.query ?? {}, body: options.body, caller, requestId: 'req',
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
  });
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

/** A publisher with a channel and a submission the machine review passed, as stages 3a and 3b leave it. */
const WALK_LISTING = { appStage: 0, collections: [], ownPrefetchBytes: 0, ownMedia: [], uses: {}, activities: ['walk'], genres: [], requires: [] };

async function awaitingReview(version = 1, listing: Record<string, unknown> = WALK_LISTING) {
  const reg = await call(alice, 'POST', '/api/publisher', { body: { displayName: '鎌倉歴史散歩の会', contact: 'k@example.com' } }).catch(() => undefined);
  if (reg?.status === 201) {
    const key = generateEd25519();
    const challenge = await call(alice, 'POST', '/api/publisher/keys/challenge');
    await call(alice, 'POST', '/api/publisher/keys', {
      body: { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(key.privateKey, utf8.encode(challenge.body.message))) },
    });
    await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } });
  }
  const created = await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: { description: '鎌倉の寺社', tags: ['history'] } });
  const sid = created.body.submission.submissionId as string;
  const zip = zipSync({ 'channel.json': utf8.encode(JSON.stringify({ format: 1, activities: ['walk'], id: 'kamakura-history', version, name: '鎌倉歴史散歩', summary: '寺社と武士の歴史', lang: 'ja' })) });
  uploads.set(`intake/kamakura-history/${sid}.zip`, zip);
  records.set(`samples/${sid}/prompts.json`, JSON.stringify({ generatedBy: 'core-format 2.0.0, prompts 4.0.0', scenarios: [{ id: 'start-morning-sunny', label: '開始', system: 's', user: 'u' }] }));
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: `SUB#${sid}` },
      UpdateExpression: `SET #s = :s, version = :v, sha256 = :h, #size = :z, iconSha256 = :i, validation = :val, samplesKey = :k, submittedAt = :t, GSI2PK = :q, GSI2SK = :o, rev = :r, listing = :l REMOVE #ttl`,
      ExpressionAttributeNames: { '#s': 'state', '#size': 'size', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':s': 'awaiting_review', ':v': version, ':h': sha256Hex(zip), ':z': zip.length, ':i': 'cd'.repeat(32), ':val': { ok: true, errors: [] },
        ':k': `samples/${sid}/prompts.json`, ':t': new Date(clock).toISOString(), ':q': 'QUEUE#REVIEW', ':o': `${new Date(clock).toISOString()}#kamakura-history`, ':r': 2,
        ':l': listing,
      },
    }),
  );
  return sid;
}

const base = (sid: string) => `/api/admin/channels/kamakura-history/submissions/${sid}`;

describe('the review queue', () => {
  it('lists submissions waiting for or in review to operators only', async () => {
    const sid = await awaitingReview();
    expect((await call(alice, 'GET', '/api/admin/review-queue')).body.code).toBe('forbidden');
    const queue = await call(operator, 'GET', '/api/admin/review-queue');
    expect(queue.body.items.map((s: { submissionId: string; state: string }) => [s.submissionId, s.state])).toEqual([[sid, 'awaiting_review']]);
    const pkg = await call(operator, 'GET', `${base(sid)}/package`);
    expect(pkg.body.packageUrl).toBe(`https://intake.example/intake/kamakura-history/${sid}.zip?signed`);
    expect((await call(operator, 'GET', `${base(sid)}/sample-prompts`)).body.scenarios[0].id).toBe('start-morning-sunny');
  });

  it('takes and puts back a review with If-Match', async () => {
    const sid = await awaitingReview();
    expect((await call(operator, 'POST', `${base(sid)}/start`)).status).toBe(428);
    const started = await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    expect(started.body).toMatchObject({ state: 'in_review', rev: 3 });
    expect((await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 3 })).body.code).toBe('invalid_state');
    expect((await call(operator, 'POST', `${base(sid)}/release`, { ifMatch: 3 })).body.state).toBe('awaiting_review');
    // Still in the queue throughout.
    expect((await call(operator, 'GET', '/api/admin/review-queue')).body.items).toHaveLength(1);
  });
});

describe('samples', () => {
  it('keeps the AI’s replies, not the key, and shows them with the decision', async () => {
    const sid = await awaitingReview();
    const saved = await call(operator, 'POST', `${base(sid)}/samples`, { body: { service: 'openai', model: 'gpt-x', items: [{ scenarioId: 'start-morning-sunny', output: 'おはようございます。' }] } });
    expect(saved.status).toBe(201);
    expect(JSON.parse(records.get(`reviews/${sid}/${saved.body.samplesId}.json`)!)).toMatchObject({ service: 'openai', items: [{ output: 'おはようございます。' }] });
    expect((await call(operator, 'POST', `${base(sid)}/samples`, { body: { service: 'openai', model: 'm', items: [] } })).body.code).toBe('invalid_request');

    await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(sid)}/approve`, { body: { samplesIds: [saved.body.samplesId] }, ifMatch: 3 });
    const reviews = await call(operator, 'GET', `${base(sid)}/reviews`);
    expect(reviews.body.items.map((r: { action: string }) => r.action)).toEqual(['start', 'approve']);
    expect(reviews.body.items[1].samples[0].items[0].output).toBe('おはようございます。');
  });
});

describe('deciding', () => {
  it('approves: lists the channel, supersedes the previous version and publishes', async () => {
    const first = await awaitingReview(1);
    await call(operator, 'POST', `${base(first)}/start`, { ifMatch: 2 });
    const approved = await call(operator, 'POST', `${base(first)}/approve`, { body: { message: '問題ありません' }, ifMatch: 3 });
    expect(approved.body).toMatchObject({ publication: 'pending', submission: { state: 'approved', decision: { action: 'approve', message: '問題ありません' } } });
    expect(published).toEqual(['approve']);
    expect(archived).toContain(`intake/kamakura-history/${first}.zip`);
    const channel = await call(alice, 'GET', '/api/channels/kamakura-history');
    expect(channel.body).toMatchObject({
      listed: true, pendingSubmissionId: null,
      latestApproved: { version: 1, name: '鎌倉歴史散歩', summary: '寺社と武士の歴史', lang: ['ja'], description: '鎌倉の寺社', tags: ['history'], minAppVersions: { sanpoguide: 1 } },
    });
    // A walking channel, for SanpoGuide (N-3, N-5).
    expect(channel.body.latestApproved).toMatchObject({ activities: ['walk'], genres: [], requires: [], minAppVersions: { sanpoguide: 1 }, package: { format: 1 } });
    expect((await call(operator, 'GET', '/api/admin/review-queue')).body.items).toEqual([]);

    const second = await awaitingReview(2);
    await call(operator, 'POST', `${base(second)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(second)}/approve`, { body: {}, ifMatch: 3 });
    const subs = await call(alice, 'GET', '/api/channels/kamakura-history/submissions');
    expect(subs.body.items.map((s: { state: string }) => s.state)).toEqual(['approved', 'superseded']);
  });

  it('refuses to approve an older version, or a package that changed after the machine review', async () => {
    const first = await awaitingReview(2);
    await call(operator, 'POST', `${base(first)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(first)}/approve`, { body: {}, ifMatch: 3 });
    const older = await awaitingReview(1);
    await call(operator, 'POST', `${base(older)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${base(older)}/approve`, { body: {}, ifMatch: 3 })).body.code).toBe('version_not_newer');

    // The refused one still holds the channel; return it before the next submission.
    await call(operator, 'POST', `${base(older)}/return`, { body: { findings: [{ item: '1', detail: '版を上げてください' }] }, ifMatch: 3 });

    const changed = await awaitingReview(3);
    uploads.set(`intake/kamakura-history/${changed}.zip`, utf8.encode('swapped'));
    await call(operator, 'POST', `${base(changed)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${base(changed)}/approve`, { body: {}, ifMatch: 3 })).body.code).toBe('invalid_state');
  });

  it('returns and rejects with the review policy’s item numbers, freeing the channel', async () => {
    const sid = await awaitingReview();
    await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${base(sid)}/return`, { body: { findings: [] }, ifMatch: 3 })).body.code).toBe('invalid_request');
    expect((await call(operator, 'POST', `${base(sid)}/return`, { body: { findings: [{ item: 'two', detail: 'x' }] }, ifMatch: 3 })).body.code).toBe('invalid_request');
    const returned = await call(operator, 'POST', `${base(sid)}/return`, { body: { findings: [{ item: '2.2', detail: '立入禁止の場所に誘っている' }], message: '直して出し直してください' }, ifMatch: 3 });
    expect(returned.body.submission).toMatchObject({ state: 'returned', decision: { action: 'return', findings: [{ item: '2.2' }] } });
    // The publisher sees why, and can submit again.
    const mine = await call(alice, 'GET', `/api/channels/kamakura-history/submissions/${sid}`);
    expect(mine.body.decision.findings[0].detail).toBe('立入禁止の場所に誘っている');
    expect((await call(alice, 'GET', '/api/channels/kamakura-history')).body.pendingSubmissionId).toBeNull();

    const next = await awaitingReview();
    await call(operator, 'POST', `${base(next)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${base(next)}/reject`, { body: { findings: [{ item: '2.1', detail: '散策と関係のない話題が中心' }] }, ifMatch: 3 })).body.submission.state).toBe('rejected');
    expect(published).toEqual([]);
  });

  it('puts an approved channel into the list the publisher signs', async () => {
    const sid = await awaitingReview();
    await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(sid)}/approve`, { body: {}, ifMatch: 3 });
    const keyset = await signDocument(provider.keyset, provider.root);
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'KEYSET', SK: 'HEAD' }, UpdateExpression: 'SET #d = :d, seq = :s', ExpressionAttributeNames: { '#d': 'document' }, ExpressionAttributeValues: { ':d': keyset, ':s': 1 } }));
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'SIGNKEY', SK: 'KEY#k-test' }, UpdateExpression: 'SET #s = :a, keyId = :k, kmsKeyArn = :arn', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':a': 'active', ':k': 'k-test', ':arn': 'local' } }));

    const storage = new MemoryStorage();
    await publish({ store: new DynamoStore(deps.table, raw), storage, cdn: noCdn, signerFor: () => provider.signing, config: { rootPublicKey: provider.rootKey, name: 'Test' }, now: () => new Date(clock) }, 'approve');
    const discovery = verifyDiscovery(JSON.parse(utf8.decode(storage.public.get(DISCOVERY_PATH)!)));
    const list = verifyChannelList(JSON.parse(utf8.decode(storage.public.get(LIST_PATH)!)), discovery.keyset, { now: new Date(clock) }).body;
    expect(list.channels).toHaveLength(1);
    expect(list.channels[0]).toMatchObject({ id: 'kamakura-history', version: 1, publisherName: '鎌倉歴史散歩の会', name: '鎌倉歴史散歩' });
  });
});

describe('the ecosystem (DES-011)', () => {
  const listing = (activities: string[], requires: string[] = []) => ({
    appStage: 0, collections: [], ownPrefetchBytes: 0, ownMedia: [], uses: {}, activities, genres: ['history'], requires,
  });

  it('gives a version to each app the channel is for (N-5)', async () => {
    const sid = await awaitingReview(1, listing(['walk', 'cycle'], ['slot:guide']));
    await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(sid)}/approve`, { body: {}, ifMatch: 3 });
    const channel = await call(alice, 'GET', '/api/channels/kamakura-history');
    expect(channel.body.latestApproved).toMatchObject({
      activities: ['walk', 'cycle'], genres: ['history'], requires: ['slot:guide'], minAppVersions: { sanpoguide: 1 },
    });
  });

  it("gives no app a version when none can use the channel, and SanpoGuide one it doesn't have (P-21)", async () => {
    const sid = await awaitingReview(1, listing(['cycle']));
    await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(sid)}/approve`, { body: {}, ifMatch: 3 });
    const channel = await call(alice, 'GET', '/api/channels/kamakura-history');
    expect(channel.body.latestApproved).toMatchObject({ activities: ['cycle'], minAppVersions: {} });
    const needsSound = await awaitingReview(2, listing(['walk'], ['present:play']));
    await call(operator, 'POST', `${base(needsSound)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(needsSound)}/approve`, { body: {}, ifMatch: 3 });
    expect((await call(alice, 'GET', '/api/channels/kamakura-history')).body.latestApproved).toMatchObject({ minAppVersions: {} });
  });
});

describe('notices', () => {
  it('queues one email notice per decision, with the findings but no operator id', async () => {
    const first = await awaitingReview(1);
    await call(operator, 'POST', `${base(first)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(first)}/approve`, { body: { message: '問題ありません' }, ifMatch: 3 });
    const second = await awaitingReview(2);
    await call(operator, 'POST', `${base(second)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(second)}/return`, { body: { findings: [{ item: '2.2', detail: '立入禁止' }] }, ifMatch: 3 });
    const channel = await call(operator, 'GET', '/api/channels/kamakura-history');
    await call(operator, 'POST', '/api/admin/channels/kamakura-history/revoke', { body: { reason: '苦情', severity: 'low' }, ifMatch: channel.body.rev });
    expect(notices.map((n) => [n.event, n.version])).toEqual([['submission.approved', 1], ['submission.returned', 2], ['channel.revoked', undefined]]);
    expect(notices[1]).toMatchObject({ channelId: 'kamakura-history', findings: [{ item: '2.2', detail: '立入禁止' }] });
    expect(new Set(notices.map((n) => n.noticeId)).size).toBe(3);
    expect(JSON.stringify(notices)).not.toContain(operator.sub);
  });

  it('never fails the operation when the queue does', async () => {
    deps.notify = async () => {
      throw new Error('queue down');
    };
    const sid = await awaitingReview();
    await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${base(sid)}/approve`, { body: {}, ifMatch: 3 })).status).toBe(200);
  });
});

describe('key transfers', () => {
  async function proof(caller: Caller, key = generateEd25519()) {
    const challenge = await call(caller, 'POST', '/api/publisher/keys/challenge');
    return { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(key.privateKey, utf8.encode(challenge.body.message))) };
  }
  const ask = async (extra: object = {}) =>
    call(alice, 'POST', '/api/publisher/key-transfers', { body: { ...(await proof(alice)), reason: 'lost', publicReason: '配信元の鍵の紛失', note: '端末が壊れた', ...extra } });
  const approve = (t: { publisherId: string; transferId: string; rev: number }, body: unknown = { verification: { method: '登録済みの連絡先への返信', detail: '10/4 に返信を確認' } }) =>
    call(operator, 'POST', `/api/admin/publishers/${t.publisherId}/key-transfers/${t.transferId}/approve`, { body, ifMatch: t.rev });

  it('moves every channel to the new key, returns pending submissions, and lists the change from the next version', async () => {
    const v1 = await awaitingReview(1);
    await call(operator, 'POST', `${base(v1)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(v1)}/approve`, { body: {}, ifMatch: 3 });
    const v2 = await awaitingReview(2);
    const oldAccount = (await call(alice, 'GET', '/api/publisher')).body.activeAccountId as string;

    expect((await ask({ publicReason: '' })).body.code).toBe('invalid_request');
    const asked = await ask();
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ state: 'requested', fromAccountId: oldAccount, reason: 'lost', publicReason: '配信元の鍵の紛失' });
    expect((await ask()).body.code).toBe('transfer_pending');
    expect((await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} })).body.code).toBe('transfer_pending');
    expect((await call(alice, 'GET', '/api/publisher/keys')).body.items.map((k: { status: string }) => k.status).sort()).toEqual(['active', 'pending_transfer']);

    const queue = await call(operator, 'GET', '/api/admin/key-transfers');
    expect(queue.body.items.map((t: { transferId: string }) => t.transferId)).toEqual([asked.body.transferId]);
    expect((await call(alice, 'GET', '/api/admin/key-transfers')).body.code).toBe('forbidden');
    expect((await approve(asked.body, { verification: { method: '' } })).body.code).toBe('invalid_request');

    const approved = await approve(asked.body);
    expect(approved.body).toMatchObject({ state: 'approved', returnedSubmissions: [v2], verification: { method: '登録済みの連絡先への返信' } });
    expect(published).toContain('transfer');
    expect(notices.at(-1)).toMatchObject({ event: 'transfer.approved', returned: 1 });
    expect((await call(alice, 'GET', '/api/publisher')).body.activeAccountId).toBe(asked.body.toAccountId);
    const keys = (await call(alice, 'GET', '/api/publisher/keys')).body.items as { accountId: string; status: string }[];
    expect(keys.map((k) => [k.accountId === oldAccount, k.status]).sort()).toEqual([[false, 'active'], [true, 'unbound']]);
    expect((await call(alice, 'GET', `/api/channels/kamakura-history/submissions/${v2}`)).body).toMatchObject({ state: 'returned', decision: { action: 'return' } });
    expect((await call(operator, 'GET', '/api/admin/review-queue')).body.items).toEqual([]);
    expect((await call(operator, 'GET', '/api/admin/key-transfers')).body.items).toEqual([]);

    // The listed version is still the old key's: the list does not claim a change yet (V-16).
    const store = new DynamoStore(deps.table, raw);
    expect((await store.listedChannels(new Date(clock)))[0]).not.toHaveProperty('publisherChange');
    expect((await call(alice, 'GET', '/api/channels/kamakura-history')).body.publisherChange).toMatchObject({ from: oldAccount, reason: '配信元の鍵の紛失' });

    // The first version with the new key carries it, for 90 days.
    const v3 = await awaitingReview(3);
    expect((await call(alice, 'GET', `/api/channels/kamakura-history/submissions/${v3}`)).body.accountId).toBe(asked.body.toAccountId);
    await call(operator, 'POST', `${base(v3)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(v3)}/approve`, { body: {}, ifMatch: 3 });
    const [listed] = await store.listedChannels(new Date(clock));
    expect(listed?.entry).toMatchObject({ version: 3, publisher: asked.body.toAccountId, publisherChange: { from: oldAccount, reason: '配信元の鍵の紛失' } });
    const later = await store.listedChannels(new Date(clock + 91 * 86_400_000));
    expect(later[0]?.entry).not.toHaveProperty('publisherChange');
  });

  it('can be cancelled by the publisher or refused by an operator, unbinding the new key', async () => {
    await awaitingReview();
    const first = await ask();
    expect((await call(alice, 'POST', `/api/publisher/key-transfers/${first.body.transferId}/cancel`)).status).toBe(428);
    const cancelled = await call(alice, 'POST', `/api/publisher/key-transfers/${first.body.transferId}/cancel`, { ifMatch: 1 });
    expect(cancelled.body.state).toBe('cancelled');

    const second = await ask({ reason: 'leaked' });
    expect(second.status).toBe(201);
    const refused = await call(operator, 'POST', `/api/admin/publishers/${second.body.publisherId}/key-transfers/${second.body.transferId}/reject`, {
      body: { reason: '本人と確認できなかった' }, ifMatch: 1,
    });
    expect(refused.body).toMatchObject({ state: 'rejected', decisionReason: '本人と確認できなかった' });
    expect(notices.at(-1)).toMatchObject({ event: 'transfer.rejected', message: '本人と確認できなかった' });
    expect((await call(alice, 'GET', '/api/publisher/keys')).body.items.map((k: { status: string }) => k.status).sort()).toEqual(['active', 'unbound', 'unbound']);
    expect((await call(alice, 'GET', '/api/publisher/key-transfers')).body.items.map((t: { state: string }) => t.state)).toEqual(['rejected', 'cancelled']);
    expect((await call(operator, 'GET', '/api/admin/key-transfers', { query: { state: 'rejected' } })).body.items).toHaveLength(1);
    expect((await call(alice, 'GET', '/api/publisher')).body.activeAccountId).toBe(first.body.fromAccountId);
  });
});
