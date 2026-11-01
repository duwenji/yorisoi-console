import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, generateEd25519, sha256Hex, signDocument, signEd25519, utf8, verifyChannelList, verifyDiscovery } from '@yorisoi-console/protocol';
import { zipSync } from 'fflate';
import { makeTestProvider, type TestProvider } from '@yorisoi-console/protocol/testing';
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

// DES-008: the producer role, collections, their submissions and their review (API-001).

const alice: Caller = { sub: 'sub-alice', roles: ['publisher'] };
const bob: Caller = { sub: 'sub-bob', roles: ['publisher'] };
const operator: Caller = { sub: 'op-1', roles: ['operator'] };
const start = new Date('2026-10-11T03:00:00.000Z');

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let deps: Deps;
let clock: number;
let published: Trigger[];
let notices: Notice[];
let archived: string[];
let copied: string[];
/** Runs while an approval copies the package: between reading the records of use and writing. */
let duringCopy: () => Promise<void>;
/** The same for a channel's approval (DES-008 K-5 the other way round). */
let duringChannelCopy: () => Promise<void>;
let uploads: Map<string, Uint8Array>;
let provider: TestProvider;
let raw: Awaited<ReturnType<typeof freshTable>>['raw'];

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

beforeEach(async () => {
  const fresh = await freshTable(local.endpoint);
  provider = await makeTestProvider({ now: start });
  raw = fresh.raw;
  clock = start.getTime();
  published = [];
  notices = [];
  archived = [];
  copied = [];
  duringCopy = async () => {};
  duringChannelCopy = async () => {};
  uploads = new Map();
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
    readRecord: async () => undefined,
    writeRecord: async () => {},
    notify: async (n) => void notices.push(n),
    publishApproved: async ({ packageSha256, iconSha256 }) => {
      await duringChannelCopy();
      return { packageUrl: `https://provider.example/pkg/${packageSha256}.zip`, iconUrl: `https://provider.example/icons/${iconSha256}.png` };
    },
    publishCollection: async (key, sha) => {
      copied.push(key);
      await duringCopy();
      return `https://provider.example/col/${sha}.zip`;
    },
    apps: { sanpoguide: { ...DEFAULT_APPS.sanpoguide!, stageVersions: { 0: 1, 1: 9999, 2: 9999, 3: 9999 } } },
  };
});

async function call(caller: Caller, method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) {
  const res = await route(deps, {
    method, path, query: {}, body: options.body, caller, requestId: 'req',
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

/** An account with a key; with the producer role if [producer]. */
async function account(caller: Caller, name: string, producer = true) {
  await call(caller, 'POST', '/api/publisher', { body: { displayName: name, contact: `${caller.sub}@example.com` } });
  const key = generateEd25519();
  const challenge = await call(caller, 'POST', '/api/publisher/keys/challenge');
  await call(caller, 'POST', '/api/publisher/keys', {
    body: { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(key.privateKey, utf8.encode(challenge.body.message))) },
  });
  if (producer) {
    const me = await call(caller, 'GET', '/api/publisher');
    await call(caller, 'POST', '/api/publisher/roles/producer', { ifMatch: me.body.rev });
  }
  return (await call(caller, 'GET', '/api/publisher')).body;
}

const LISTING = {
  appStage: 2, name: '鎌倉音声ガイド', summary: '寺社の音声ガイド', media: ['audio', 'text'], resourcesSize: 2_481_000, tags: ['history'], regions: ['xn7'],
  grants: { publishers: '*' }, resourceTypes: { intro: 'text', narration: 'audio' },
  externalResources: [{ resourceId: 'narration', url: 'https://cdn.example.com/n.ogg', size: 2_480_000 }],
};

/** A collection submission the machine review passed, as DES-007 leaves it. */
async function awaitingReview(version = 1, listing: object = LISTING) {
  const created = await call(alice, 'POST', '/api/collections/kamakura-audio-guide/submissions', { body: { note: '観光協会の音声' } });
  expect(created.status).toBe(201);
  const sid = created.body.submission.submissionId as string;
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.table, Key: { PK: 'COL#kamakura-audio-guide', SK: `SUB#${sid}` },
      UpdateExpression: 'SET #s = :s, version = :v, sha256 = :h, #size = :z, validation = :val, listing = :l, submittedAt = :t, GSI2PK = :q, GSI2SK = :o, rev = :r REMOVE #ttl',
      ExpressionAttributeNames: { '#s': 'state', '#size': 'size', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':s': 'awaiting_review', ':v': version, ':h': 'ab'.repeat(32), ':z': 1000, ':val': { ok: true, errors: [], appStage: 2 }, ':l': listing,
        ':t': new Date(clock).toISOString(), ':q': 'QUEUE#REVIEW', ':o': `${new Date(clock).toISOString()}#col:kamakura-audio-guide`, ':r': 2,
      },
    }),
  );
  return sid;
}

const admin = (sid: string) => `/api/admin/collections/kamakura-audio-guide/submissions/${sid}`;
const verification = { method: '登録済みの連絡先への電話', detail: '観光協会の代表番号で本人と確認' };

describe('the producer role', () => {
  it('is turned on by the account itself, and needed for collections', async () => {
    const plain = await account(alice, '鎌倉市観光協会', false);
    expect(plain.roles).toEqual(['publisher']);
    expect((await call(alice, 'POST', '/api/collections', { body: { collectionId: 'kamakura-audio-guide' } })).body.code).toBe('role_required');
    expect((await call(alice, 'POST', '/api/publisher/roles/producer')).status).toBe(428);
    const on = await call(alice, 'POST', '/api/publisher/roles/producer', { ifMatch: plain.rev });
    expect(on.body).toMatchObject({ roles: ['publisher', 'producer'], producerVerified: false, usage: { collections: 0 }, limits: { collections: 5 } });
    expect((await call(alice, 'POST', '/api/collections', { body: { collectionId: 'kamakura-audio-guide' } })).status).toBe(201);
  });
});

describe('collections', () => {
  it('have their own ids beside channels, and an upper limit', async () => {
    const me = await account(alice, '鎌倉市観光協会');
    await account(bob, '別の制作元');
    await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura' } });
    // The same id as a channel is fine (another namespace); the same collection id twice is not.
    expect((await call(alice, 'POST', '/api/collections', { body: { collectionId: 'kamakura' } })).status).toBe(201);
    expect((await call(bob, 'POST', '/api/collections', { body: { collectionId: 'kamakura' } })).body.code).toBe('collection_id_taken');
    // Others' collections are 404 (API-001 権限).
    expect((await call(bob, 'GET', '/api/collections/kamakura')).status).toBe(404);
    expect((await call(operator, 'GET', '/api/collections/kamakura')).status).toBe(200);
    await call(operator, 'PUT', `/api/admin/publishers/${me.publisherId}/limits`, { body: { collections: 1, reason: '試験' }, ifMatch: (await call(operator, 'GET', `/api/admin/publishers/${me.publisherId}`)).body.rev });
    expect((await call(alice, 'POST', '/api/collections', { body: { collectionId: 'second' } })).body.code).toBe('limit_reached');
    expect((await call(alice, 'GET', '/api/collections')).body.items.map((c: { collectionId: string }) => c.collectionId)).toEqual(['kamakura']);
    expect((await call(operator, 'GET', `/api/admin/publishers/${me.publisherId}/collections`)).body.items).toHaveLength(1);
  });

  it('count their uploads with the channels’, one pending submission each', async () => {
    const me = await account(alice, '鎌倉市観光協会');
    await call(alice, 'POST', '/api/collections', { body: { collectionId: 'kamakura-audio-guide' } });
    const created = await call(alice, 'POST', '/api/collections/kamakura-audio-guide/submissions', { body: {} });
    expect(created.body.submission).toMatchObject({ kind: 'collection', state: 'uploading', collectionId: 'kamakura-audio-guide' });
    expect(created.body.uploads.package.fields.key).toBe(`intake-col/kamakura-audio-guide/${created.body.submission.submissionId}.zip`);
    expect(created.body.uploads.icon).toBeUndefined();
    expect((await call(alice, 'POST', '/api/collections/kamakura-audio-guide/submissions', { body: {} })).body.code).toBe('pending_submission_exists');
    expect((await call(alice, 'GET', '/api/publisher')).body.usage.uploadsToday).toBe(1);
    await call(operator, 'PUT', `/api/admin/publishers/${me.publisherId}/limits`, { body: { uploadsPerDay: 1, reason: '試験' }, ifMatch: (await call(operator, 'GET', `/api/admin/publishers/${me.publisherId}`)).body.rev });
    await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } });
    expect((await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} })).body.code).toBe('quota_exceeded');
  });
});

describe('reviewing collections', () => {
  beforeEach(async () => {
    await account(alice, '鎌倉市観光協会');
    await call(alice, 'POST', '/api/collections', { body: { collectionId: 'kamakura-audio-guide' } });
  });

  it('share the queue with channels, told apart by kind', async () => {
    const sid = await awaitingReview();
    const queue = await call(operator, 'GET', '/api/admin/review-queue');
    expect(queue.body.items).toEqual([expect.objectContaining({ kind: 'collection', collectionId: 'kamakura-audio-guide', submissionId: sid })]);
    expect((await call(operator, 'GET', `${admin(sid)}/package`)).body.packageUrl).toBe(`https://intake.example/intake-col/kamakura-audio-guide/${sid}.zip?signed`);
  });

  it('approve the first only with the identity checked, recording it and copying what the machine review found', async () => {
    const sid = await awaitingReview();
    await call(operator, 'POST', `${admin(sid)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${admin(sid)}/approve`, { body: {}, ifMatch: 3 })).body.code).toBe('producer_not_verified');
    const approved = await call(operator, 'POST', `${admin(sid)}/approve`, { body: { verification, message: '承認します' }, ifMatch: 3 });
    expect(approved.body).toMatchObject({ publication: 'pending', submission: { state: 'approved' } });
    expect(published).toEqual(['approve']);
    expect(copied).toEqual([`intake-col/kamakura-audio-guide/${sid}.zip`]);
    expect(notices.map((n) => [n.event, n.collectionId])).toEqual([['collection.approved', 'kamakura-audio-guide']]);

    const collection = await call(alice, 'GET', '/api/collections/kamakura-audio-guide');
    expect(collection.body).toMatchObject({
      listed: true, pendingSubmissionId: null,
      latestApproved: {
        version: 1, name: '鎌倉音声ガイド', media: ['audio', 'text'], tags: ['history'], regions: ['xn7'], grants: { publishers: '*' },
        package: { url: `https://provider.example/col/${'ab'.repeat(32)}.zip`, size: 1000, format: 1 }, appStage: 2, minAppVersions: { sanpoguide: 9999 },
      },
    });
    // The account knows it is checked; only operators see how.
    const own = await call(alice, 'GET', '/api/publisher');
    expect(own.body.producerVerified).toBe(true);
    expect(own.body.producerVerification).toBeUndefined();
    expect((await call(operator, 'GET', `/api/admin/publishers/${own.body.publisherId}`)).body.producerVerification).toMatchObject(verification);

    // The next version needs no check; renaming the account asks for it again (D-20).
    const second = await awaitingReview(2);
    await call(operator, 'POST', `${admin(second)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${admin(second)}/approve`, { body: {}, ifMatch: 3 })).body.submission.state).toBe('approved');
    const renamed = await call(alice, 'PATCH', '/api/publisher', { body: { displayName: '鎌倉観光協会' }, ifMatch: (await call(alice, 'GET', '/api/publisher')).body.rev });
    expect(renamed.body.producerVerified).toBe(false);
  });

  it('refuse a version that drops or retypes what a listed channel uses (D-8)', async () => {
    const first = await awaitingReview(1);
    await call(operator, 'POST', `${admin(first)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${admin(first)}/approve`, { body: { verification }, ifMatch: 3 });
    await deps.db.send(new PutCommand({
      TableName: deps.table,
      Item: { PK: 'COL#kamakura-audio-guide', SK: 'USEDBY#kamakura-history', type: 'used-by', collectionId: 'kamakura-audio-guide', channelId: 'kamakura-history', publisherId: 'x', channelVersion: 3, resources: { narration: 'audio' }, rev: 1 },
    }));
    const dropped = await awaitingReview(2, { ...LISTING, resourceTypes: { intro: 'text' } });
    await call(operator, 'POST', `${admin(dropped)}/start`, { ifMatch: 2 });
    const refused = await call(operator, 'POST', `${admin(dropped)}/approve`, { body: {}, ifMatch: 3 });
    expect(refused.body).toMatchObject({ code: 'resource_in_use', detail: 'kamakura-history uses narration' });
    await call(operator, 'POST', `${admin(dropped)}/reject`, { body: { findings: [{ item: '2.1', detail: '使われている素材を消している' }] }, ifMatch: 3 });

    const retyped = await awaitingReview(3, { ...LISTING, resourceTypes: { intro: 'text', narration: 'video' } });
    await call(operator, 'POST', `${admin(retyped)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${admin(retyped)}/approve`, { body: {}, ifMatch: 3 })).body.code).toBe('resource_in_use');
  });

  it('fail when a channel changes its record of use during the approval (DES-008 K-5)', async () => {
    await deps.db.send(new PutCommand({
      TableName: deps.table,
      Item: { PK: 'COL#kamakura-audio-guide', SK: 'USEDBY#kamakura-history', type: 'used-by', collectionId: 'kamakura-audio-guide', channelId: 'kamakura-history', publisherId: 'x', channelVersion: 3, resources: {}, rev: 1 },
    }));
    const sid = await awaitingReview();
    await call(operator, 'POST', `${admin(sid)}/start`, { ifMatch: 2 });
    duringCopy = async () => {
      await deps.db.send(new UpdateCommand({
        TableName: deps.table, Key: { PK: 'COL#kamakura-audio-guide', SK: 'USEDBY#kamakura-history' },
        UpdateExpression: 'SET resources = :r, rev = rev + :one', ExpressionAttributeValues: { ':r': { old: 'image' }, ':one': 1 },
      }));
    };
    expect((await call(operator, 'POST', `${admin(sid)}/approve`, { body: { verification }, ifMatch: 3 })).status).toBe(412);
    expect((await call(alice, 'GET', '/api/collections/kamakura-audio-guide')).body.listed).toBe(false);
  });

  it('return, withdraw and revoke like channels', async () => {
    const sid = await awaitingReview();
    await call(operator, 'POST', `${admin(sid)}/start`, { ifMatch: 2 });
    const returned = await call(operator, 'POST', `${admin(sid)}/return`, { body: { findings: [{ item: '2.3', detail: '出典がない' }] }, ifMatch: 3 });
    expect(returned.body.submission.state).toBe('returned');
    expect(archived).toEqual([`intake-col/kamakura-audio-guide/${sid}.zip`]);
    expect(notices.at(-1)).toMatchObject({ event: 'collection.returned', collectionId: 'kamakura-audio-guide' });
    expect((await call(operator, 'GET', `${admin(sid)}/reviews`)).body.items.map((r: { action: string }) => r.action)).toEqual(['start', 'return']);

    const again = await awaitingReview();
    expect((await call(alice, 'POST', `/api/collections/kamakura-audio-guide/submissions/${again}/withdraw`, { ifMatch: 2 })).body.state).toBe('withdrawn');

    const third = await awaitingReview();
    await call(operator, 'POST', `${admin(third)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${admin(third)}/approve`, { body: { verification }, ifMatch: 3 });
    const col = await call(operator, 'GET', '/api/collections/kamakura-audio-guide');
    const revoked = await call(operator, 'POST', '/api/admin/collections/kamakura-audio-guide/revoke', { body: { reason: '権利者からの申し立て', severity: 'high' }, ifMatch: col.body.rev });
    expect(revoked.body).toMatchObject({ status: 'revoked', listed: false, revocations: [{ reason: '権利者からの申し立て', severity: 'high' }] });
    expect(published).toEqual(['approve', 'revoke']);
    expect(notices.at(-1)).toMatchObject({ event: 'collection.revoked', message: '権利者からの申し立て' });
  });

  it('show the channels that use them, without names of revoked ones', async () => {
    await deps.db.send(new PutCommand({
      TableName: deps.table,
      Item: { PK: 'CH#kamakura-history', SK: 'CH', type: 'channel', channelId: 'kamakura-history', publisherId: 'PUBX', status: 'active', latestApproved: { name: '鎌倉歴史散歩' }, rev: 1 },
    }));
    await deps.db.send(new PutCommand({ TableName: deps.table, Item: { PK: 'PUB#PUBX', SK: 'PUB', type: 'publisher', roles: ['publisher'], publisherId: 'PUBX', displayName: '鎌倉歴史散歩の会', status: 'active', rev: 1 } }));
    await deps.db.send(new PutCommand({
      TableName: deps.table,
      Item: { PK: 'COL#kamakura-audio-guide', SK: 'USEDBY#kamakura-history', type: 'used-by', collectionId: 'kamakura-audio-guide', channelId: 'kamakura-history', publisherId: 'PUBX', channelVersion: 3, resources: { narration: 'audio' }, rev: 1 },
    }));
    const users = await call(alice, 'GET', '/api/collections/kamakura-audio-guide/used-by');
    expect(users.body.items).toEqual([{ channelId: 'kamakura-history', channelName: '鎌倉歴史散歩', channelVersion: 3, publisherName: '鎌倉歴史散歩の会', resources: ['narration'] }]);
  });
});

// ---- DES-008: channels that use collections ----

describe('channels using collections', () => {
  /** A collection approved by alice. */
  async function approvedCollection(listing: object = LISTING) {
    await account(alice, '鎌倉市観光協会');
    await call(alice, 'POST', '/api/collections', { body: { collectionId: 'kamakura-audio-guide' } });
    const sid = await awaitingReview(1, listing);
    await call(operator, 'POST', `${admin(sid)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${admin(sid)}/approve`, { body: { verification }, ifMatch: 3 })).status).toBe(200);
  }

  it('gives a version to the apps a collection is granted to (DES-011 N-5, N-6)', async () => {
    await approvedCollection({ ...LISTING, appStage: 0, grants: { publishers: '*', apps: ['sanpoguide'] } });
    const forSanpo = (await call(alice, 'GET', '/api/collections/kamakura-audio-guide')).body.latestApproved;
    expect(forSanpo).toMatchObject({ grants: { publishers: '*', apps: ['sanpoguide'] }, minAppVersions: { sanpoguide: 1 } });
  });

  it('gives the older SanpoGuide a version no app has when the collection isn’t granted to it (API-CHANNEL-LIST P-21)', async () => {
    await approvedCollection({ ...LISTING, appStage: 0, grants: { publishers: '*', apps: ['boat'] } });
    const elsewhere = (await call(alice, 'GET', '/api/collections/kamakura-audio-guide')).body.latestApproved;
    expect(elsewhere).toMatchObject({ minAppVersions: {} });
  });

  const CHANNEL_LISTING = {
    appStage: 2, collections: [{ as: 'kamakura', id: 'kamakura-audio-guide', minVersion: 1 }], ownPrefetchBytes: 0, ownMedia: [],
    uses: { 'kamakura-audio-guide': { narration: 'audio' } }, activities: ['walk'], genres: [], requires: [],
  };

  /** Bob's channel submission that the machine review passed, using the collection. */
  async function channelAwaiting(version: number, listing: object = CHANNEL_LISTING) {
    if ((await call(bob, 'GET', '/api/publisher')).status === 404) {
      await account(bob, '鎌倉歴史散歩の会', false);
      await call(bob, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } });
    }
    const created = await call(bob, 'POST', '/api/channels/kamakura-history/submissions', { body: {} });
    const sid = created.body.submission.submissionId as string;
    const zip = zipSync({ 'channel.json': utf8.encode(JSON.stringify({ format: 1, activities: ['walk'], id: 'kamakura-history', version, name: '鎌倉歴史散歩', summary: '寺社と武士の歴史', lang: 'ja' })) });
    uploads.set(`intake/kamakura-history/${sid}.zip`, zip);
    await deps.db.send(new UpdateCommand({
      TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: `SUB#${sid}` },
      UpdateExpression: 'SET #s = :s, version = :v, sha256 = :h, #size = :z, iconSha256 = :i, validation = :val, listing = :l, submittedAt = :t, GSI2PK = :q, GSI2SK = :o, rev = :r REMOVE #ttl',
      ExpressionAttributeNames: { '#s': 'state', '#size': 'size', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':s': 'awaiting_review', ':v': version, ':h': sha256Hex(zip), ':z': zip.length, ':i': 'cd'.repeat(32), ':val': { ok: true, errors: [] }, ':l': listing,
        ':t': new Date(clock).toISOString(), ':q': 'QUEUE#REVIEW', ':o': `${new Date(clock).toISOString()}#kamakura-history`, ':r': 2,
      },
    }));
    return sid;
  }

  const chan = (sid: string) => `/api/admin/channels/kamakura-history/submissions/${sid}`;
  async function approveChannel(sid: string) {
    await call(operator, 'POST', `${chan(sid)}/start`, { ifMatch: 2 });
    return call(operator, 'POST', `${chan(sid)}/approve`, { body: {}, ifMatch: 3 });
  }
  const usedBy = async () => (await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: 'COL#kamakura-audio-guide', SK: 'USEDBY#kamakura-history' } }))).Item;

  it('record what they use at approval, and need the app stage their material needs', async () => {
    await approvedCollection();
    expect((await approveChannel(await channelAwaiting(1))).status).toBe(200);
    expect(await usedBy()).toMatchObject({ channelId: 'kamakura-history', channelVersion: 1, resources: { narration: 'audio' }, rev: 1, GSI1PK: 'CH#kamakura-history' });
    const channel = await call(bob, 'GET', '/api/channels/kamakura-history');
    expect(channel.body.latestApproved).toMatchObject({ minAppVersions: { sanpoguide: 9999 }, appStage: 2, collections: [{ as: 'kamakura', id: 'kamakura-audio-guide', minVersion: 1 }] });
    expect((await call(alice, 'GET', '/api/collections/kamakura-audio-guide/used-by')).body.items).toEqual([
      { channelId: 'kamakura-history', channelName: '鎌倉歴史散歩', channelVersion: 1, publisherName: '鎌倉歴史散歩の会', resources: ['narration'] },
    ]);
    // A version that no longer uses it drops the record (DM-001 M-22).
    expect((await approveChannel(await channelAwaiting(2, { ...CHANNEL_LISTING, appStage: 0, collections: [], uses: {} }))).status).toBe(200);
    expect(await usedBy()).toBeUndefined();
    expect((await call(bob, 'GET', '/api/channels/kamakura-history')).body.latestApproved.minAppVersions).toEqual({ sanpoguide: 1 });
  });

  it('check the collections again at approval (DES-008 K-7)', async () => {
    await approvedCollection({ ...LISTING, grants: { publishers: ['sg1' + 'z'.repeat(32)] } });
    const refused = await approveChannel(await channelAwaiting(1));
    expect(refused.body).toMatchObject({ code: 'invalid_state' });
    expect(refused.body.detail).toContain('not granted');

    const col = await call(operator, 'GET', '/api/collections/kamakura-audio-guide');
    await call(operator, 'POST', '/api/admin/collections/kamakura-audio-guide/revoke', { body: { reason: '確認', severity: 'low' }, ifMatch: col.body.rev });
    expect((await call(operator, 'POST', `${chan((await call(bob, 'GET', '/api/channels/kamakura-history')).body.pendingSubmissionId)}/approve`, { body: {}, ifMatch: 3 })).body.detail).toContain('not listed');
  });

  it('refuse a channel approval when the collection changes meanwhile (K-5)', async () => {
    await approvedCollection();
    const sid = await channelAwaiting(1);
    duringChannelCopy = async () => {
      await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'COL#kamakura-audio-guide', SK: 'COL' }, UpdateExpression: 'SET rev = rev + :one', ExpressionAttributeValues: { ':one': 1 } }));
    };
    await call(operator, 'POST', `${chan(sid)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${chan(sid)}/approve`, { body: {}, ifMatch: 3 })).status).toBe(412);
    expect(await usedBy()).toBeUndefined();
  });

  it('let a revoked channel drop its records, and tell users what happens to the collection', async () => {
    await approvedCollection();
    await approveChannel(await channelAwaiting(1));
    notices = [];
    // A new version of the collection: bob hears of it.
    const v2 = await awaitingReview(2);
    await call(operator, 'POST', `${admin(v2)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${admin(v2)}/approve`, { body: {}, ifMatch: 3 });
    const bobId = (await call(bob, 'GET', '/api/publisher')).body.publisherId;
    expect(notices.filter((n) => n.publisherId === bobId).map((n) => [n.event, n.channelId, n.version])).toEqual([['collection.updated', 'kamakura-history', 2]]);
    // Grants narrowed so bob is left out.
    notices = [];
    const v3 = await awaitingReview(3, { ...LISTING, grants: { publishers: ['sg1' + 'z'.repeat(32)] } });
    await call(operator, 'POST', `${admin(v3)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${admin(v3)}/approve`, { body: {}, ifMatch: 3 });
    expect(notices.filter((n) => n.publisherId === bobId).map((n) => n.event)).toEqual(['collection.grants_narrowed']);
    // Revoked: bob hears that too.
    notices = [];
    const col = await call(operator, 'GET', '/api/collections/kamakura-audio-guide');
    await call(operator, 'POST', '/api/admin/collections/kamakura-audio-guide/revoke', { body: { reason: '権利の申し立て', severity: 'high' }, ifMatch: col.body.rev });
    expect(notices.map((n) => n.event)).toEqual(['collection.revoked', 'collection.revoked_used']);
    // The channel revoked: its record goes.
    const ch = await call(operator, 'GET', '/api/channels/kamakura-history');
    await call(operator, 'POST', '/api/admin/channels/kamakura-history/revoke', { body: { reason: '確認', severity: 'low' }, ifMatch: ch.body.rev });
    expect(await usedBy()).toBeUndefined();
  });

  it('revoke a departing producer’s collections and tell the channels that used them (C-22)', async () => {
    await approvedCollection();
    await approveChannel(await channelAwaiting(1));
    notices = [];
    published = [];
    const me = await call(alice, 'GET', '/api/publisher');
    expect((await call(alice, 'DELETE', '/api/publisher', { body: { confirm: me.body.publisherId }, ifMatch: me.body.rev })).status).toBe(204);
    const col = await call(operator, 'GET', '/api/collections/kamakura-audio-guide');
    expect(col.body).toMatchObject({ status: 'revoked', listed: false, revocations: [{ reason: '素材提供者が退会したため' }] });
    expect(published).toEqual(['revoke']);
    expect(notices.map((n) => [n.event, n.channelId])).toEqual([['collection.revoked_used', 'kamakura-history']]);
    const revoked = await deps.db.send(new QueryCommand({ TableName: deps.table, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :r', ExpressionAttributeValues: { ':r': 'REVOKED' } }));
    expect(revoked.Items?.map((r) => r.GSI2SK)).toEqual([expect.stringMatching(/#col:kamakura-audio-guide$/)]);
  });

  it('move a producer’s collections with its key, returning their pending submissions', async () => {
    await approvedCollection();
    const pending = await awaitingReview(2);
    const key = generateEd25519();
    const challenge = await call(alice, 'POST', '/api/publisher/keys/challenge');
    const asked = await call(alice, 'POST', '/api/publisher/key-transfers', {
      body: { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(key.privateKey, utf8.encode(challenge.body.message))), reason: 'lost', publicReason: '制作元の鍵の紛失' },
    });
    const t = asked.body;
    const before = (await call(alice, 'GET', '/api/publisher')).body.activeAccountId;
    expect((await call(operator, 'POST', `/api/admin/publishers/${t.publisherId}/key-transfers/${t.transferId}/approve`, { body: { verification }, ifMatch: t.rev })).status).toBe(200);
    const col = await call(alice, 'GET', '/api/collections/kamakura-audio-guide');
    expect(col.body).toMatchObject({ pendingSubmissionId: null, producerChange: { from: before, reason: '制作元の鍵の紛失' } });
    expect((await call(alice, 'GET', `/api/collections/kamakura-audio-guide/submissions/${pending}`)).body.state).toBe('returned');
  });
});

// ---- DES-009 4c: publishing collections ----

describe('publishing with collections', () => {
  /** Publishes from the table as the Lambda does, and reads the list back as an app would. */
  async function publishList() {
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'KEYSET', SK: 'HEAD' }, UpdateExpression: 'SET #d = :d, seq = :s', ExpressionAttributeNames: { '#d': 'document' }, ExpressionAttributeValues: { ':d': await signDocument(provider.keyset, provider.root), ':s': 1 } }));
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'SIGNKEY', SK: 'KEY#k-test' }, UpdateExpression: 'SET #s = :a, keyId = :k, kmsKeyArn = :arn', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':a': 'active', ':k': 'k-test', ':arn': 'local' } }));
    const storage = new MemoryStorage();
    const record = await publish({ store: new DynamoStore(deps.table, raw), storage, cdn: noCdn, signerFor: () => provider.signing, config: { rootPublicKey: provider.rootKey, name: 'Test' }, now: () => new Date(clock) }, 'manual');
    const json = (path: string) => JSON.parse(utf8.decode(storage.public.get(path)!));
    const discovery = verifyDiscovery(json(DISCOVERY_PATH), { expectedProvider: provider.provider });
    return { record, list: verifyChannelList(json(LIST_PATH), discovery.keyset, { now: new Date(clock) }).body };
  }

  async function approvedCollection() {
    await account(alice, '鎌倉市観光協会');
    await call(alice, 'POST', '/api/collections', { body: { collectionId: 'kamakura-audio-guide' } });
    const sid = await awaitingReview(1, LISTING);
    await call(operator, 'POST', `${admin(sid)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${admin(sid)}/approve`, { body: { verification }, ifMatch: 3 });
  }

  async function channelUsingIt() {
    await account(bob, '鎌倉歴史散歩の会', false);
    await call(bob, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } });
    const created = await call(bob, 'POST', '/api/channels/kamakura-history/submissions', { body: {} });
    const sid = created.body.submission.submissionId as string;
    const zip = zipSync({ 'channel.json': utf8.encode(JSON.stringify({ format: 1, activities: ['walk'], id: 'kamakura-history', version: 1, name: '鎌倉歴史散歩', summary: '寺社と武士の歴史', lang: 'ja' })) });
    uploads.set(`intake/kamakura-history/${sid}.zip`, zip);
    const listing = {
      appStage: 2, collections: [{ as: 'kamakura', id: 'kamakura-audio-guide', minVersion: 1 }], ownPrefetchBytes: 300, ownMedia: ['image'],
      uses: { 'kamakura-audio-guide': { narration: 'audio' } }, activities: ['walk'], genres: [], requires: [],
    };
    await deps.db.send(new UpdateCommand({
      TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: `SUB#${sid}` },
      UpdateExpression: 'SET #s = :s, version = :v, sha256 = :h, #size = :z, iconSha256 = :i, validation = :val, listing = :l, rev = :r REMOVE #ttl',
      ExpressionAttributeNames: { '#s': 'state', '#size': 'size', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':s': 'in_review', ':v': 1, ':h': sha256Hex(zip), ':z': zip.length, ':i': 'cd'.repeat(32), ':val': { ok: true, errors: [] }, ':l': listing, ':r': 3 },
    }));
    expect((await call(operator, 'POST', `/api/admin/channels/kamakura-history/submissions/${sid}/approve`, { body: {}, ifMatch: 3 })).status).toBe(200);
  }

  it('lists collections apart from channels, and adds them up into the channels that use them (M-1〜M-4)', async () => {
    await approvedCollection();
    await channelUsingIt();
    const { record, list } = await publishList();
    expect(list.channels.map((c) => c.id)).toEqual(['kamakura-history']);
    const channel = list.channels[0]!;
    expect(channel).toMatchObject({ media: ['audio', 'image', 'text'], resourcesSize: 300 + LISTING.resourcesSize, minAppVersions: { sanpoguide: 9999 } });
    // What approval keeps for itself stays out of the list.
    for (const field of ['appStage', 'collections', 'ownPrefetchBytes', 'ownMedia', 'submissionId']) expect(channel).not.toHaveProperty(field);
    expect(list.collections).toEqual([
      expect.objectContaining({
        id: 'kamakura-audio-guide', version: 1, producerName: '鎌倉市観光協会', media: ['audio', 'text'], resourcesSize: LISTING.resourcesSize,
        tags: ['history'], regions: ['xn7'], grants: { publishers: '*' }, minAppVersions: { sanpoguide: 9999 },
      }),
    ]);
    for (const field of ['resourceTypes', 'externalResources', 'appStage', 'submissionId']) expect(list.collections![0]).not.toHaveProperty(field);
    expect(record).toMatchObject({ channelCount: 1, collectionCount: 1, revokedCount: 0, revokedCollectionCount: 0 });
  });

  it('lists a revoked collection in revokedCollections, never in revoked (M-1)', async () => {
    await approvedCollection();
    const col = await call(operator, 'GET', '/api/collections/kamakura-audio-guide');
    await call(operator, 'POST', '/api/admin/collections/kamakura-audio-guide/revoke', { body: { reason: '権利の申し立て', severity: 'high' }, ifMatch: col.body.rev });
    const { list } = await publishList();
    expect(list.channels).toEqual([]);
    expect(list.revoked).toEqual([]);
    expect(list.collections).toEqual([]);
    expect(list.revokedCollections).toEqual([expect.objectContaining({ id: 'kamakura-audio-guide', reason: '権利の申し立て' })]);
  });
});
