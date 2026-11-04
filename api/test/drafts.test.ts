import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, generateEd25519, signDocument, signEd25519, utf8 } from '@yorisoi-console/protocol';
import { makeTestProvider } from '@yorisoi-console/protocol/testing';
import { zipSync } from 'fflate';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPS, type Deps } from '../src/console/deps.js';
import { DRAFT_CHECKS_PER_DAY } from '../src/console/drafts.js';
import type { Caller } from '../src/console/http.js';
import { route } from '../src/console/router.js';
import { CursorCodec } from '../src/console/util.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';
import { memoryDrafts } from './drafts-fake.js';

// DES-014: drafts of channels and collections, their machine review, and the owner's own packages.

const start = new Date('2026-11-04T03:00:00.000Z');
const alice: Caller = { sub: 'sub-alice', roles: ['publisher'] };
const bob: Caller = { sub: 'sub-bob', roles: ['publisher'] };
const operator: Caller = { sub: 'op-1', roles: ['operator'] };

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let deps: Deps;
let clock: number;
let drafts: ReturnType<typeof memoryDrafts>;
let deletedUsers: string[];

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

beforeEach(async () => {
  const { table, db } = await freshTable(local.endpoint);
  const provider = await makeTestProvider({ now: start });
  clock = start.getTime();
  drafts = memoryDrafts();
  deletedUsers = [];
  deps = {
    db,
    table,
    now: () => new Date(clock++),
    cursors: new CursorCodec(randomBytes(32)),
    rootPublicKey: b64url.encode(provider.rootKey),
    kmsPublicKey: async () => ({ keySpec: undefined, publicKey: new Uint8Array() }),
    requestPublish: async () => {},
    presignUpload: async (key) => ({ url: 'https://intake.example/', fields: { key } }),
    archiveUpload: async () => {},
    deleteUser: async (sub) => void deletedUsers.push(sub),
    publishTrial: async (_k, sha) => `https://provider.example/trial/${sha}.zip`,
    packageUrl: (sha) => `https://provider.example/pkg/${sha}.zip`,
    signDocument: (content) => signDocument(content, provider.signing),
    readUpload: async () => new Uint8Array(),
    presignDownload: async (key) => `https://intake.example/${key}?signed`,
    readRecord: async () => undefined,
    writeRecord: async () => {},
    notify: async () => {},
    publishCollection: async (_key, sha) => `https://provider.example/col/${sha}.zip`,
    publishApproved: async ({ packageSha256, iconSha256 }) => ({ packageUrl: `https://provider.example/pkg/${packageSha256}.zip`, iconUrl: `https://provider.example/icons/${iconSha256}.png` }),
    drafts,
    apps: DEFAULT_APPS,
  };
});

interface Call {
  body?: unknown;
  zip?: Uint8Array;
  ifMatch?: number;
  ifNoneMatch?: boolean;
}

async function call(caller: Caller, method: string, path: string, options: Call = {}) {
  const res = await route(deps, {
    method, path, query: {}, body: options.body, caller, requestId: 'req',
    ...(options.zip ? { rawBody: options.zip } : {}),
    headers: {
      ...(options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {}),
      ...(options.ifNoneMatch ? { 'if-none-match': '*' } : {}),
    },
  });
  const isJson = res.headers['content-type']?.includes('json') && res.body;
  return { status: res.statusCode, headers: res.headers, body: isJson ? JSON.parse(res.body) : undefined, raw: res };
}

/** A publisher with a key and the channel kamakura-history; with the producer role and the collection kamakura-audio-guide if [producer]. */
async function owner(who: Caller = alice, producer = false) {
  const reg = await call(who, 'POST', '/api/publisher', { body: { displayName: '鎌倉歴史散歩の会', contact: 'kamakura@example.com' } });
  const key = generateEd25519();
  const challenge = await call(who, 'POST', '/api/publisher/keys/challenge');
  await call(who, 'POST', '/api/publisher/keys', {
    body: { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(key.privateKey, utf8.encode(challenge.body.message))) },
  });
  expect((await call(who, 'POST', '/api/channels', { body: { channelId: who === alice ? 'kamakura-history' : 'bob-channel' } })).status).toBe(201);
  if (producer) {
    const me = await call(who, 'GET', '/api/publisher');
    await call(who, 'POST', '/api/publisher/roles/producer', { ifMatch: me.body.rev });
    expect((await call(who, 'POST', '/api/collections', { body: { collectionId: 'kamakura-audio-guide' } })).status).toBe(201);
  }
  return reg.body.publisherId as string;
}

const draftZip = (name = '鎌倉歴史散歩') => zipSync({ 'package/channel.json': utf8.encode(JSON.stringify({ format: 1, name })), 'draft.json': utf8.encode('{}') });
const CH = '/api/channels/kamakura-history';
const COL = '/api/collections/kamakura-audio-guide';

describe('saving and reading a draft (R-3〜R-5, R-12)', () => {
  it('saves the ZIP first with If-None-Match, then with If-Match, and gives it back', async () => {
    await owner();
    expect((await call(alice, 'GET', `${CH}/draft`)).body.code).toBe('not_found');
    expect((await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip() })).status).toBe(428);

    const first = await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true });
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe('"1"');
    expect(first.body).toMatchObject({ rev: 1, check: null });
    expect(Date.parse(first.body.expiresAt) - Date.parse(first.body.updatedAt)).toBe(180 * 24 * 3600_000);
    expect((await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true })).status).toBe(412);

    const second = await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip('二版'), ifMatch: 1 });
    expect(second.body).toMatchObject({ rev: 2, createdAt: first.body.createdAt });
    // Only the saved one is kept.
    expect(drafts.objects.size).toBe(1);

    const got = await call(alice, 'GET', `${CH}/draft`);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('application/zip');
    expect(got.headers.etag).toBe('"2"');
    expect(got.raw.isBase64Encoded).toBe(true);
    expect(new Uint8Array(Buffer.from(got.raw.body, 'base64'))).toEqual(draftZip('二版'));

    // The owner sees its summary with the channel; an operator doesn't (R-6).
    expect((await call(alice, 'GET', CH)).body.draft).toMatchObject({ rev: 2 });
    expect((await call(operator, 'GET', CH)).body.draft).toBeUndefined();
  });

  it('turns away a stale save and leaves the newer draft and only its file (RV-03, DV-22)', async () => {
    await owner();
    await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true });
    await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip('タブ 1'), ifMatch: 1 });
    const stale = await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip('タブ 2'), ifMatch: 1 });
    expect(stale.body.code).toBe('precondition_failed');
    expect(drafts.objects.size).toBe(1);
    const got = await call(alice, 'GET', `${CH}/draft`);
    expect(new Uint8Array(Buffer.from(got.raw.body, 'base64'))).toEqual(draftZip('タブ 1'));
  });

  it('removes the new file when the item was written meanwhile', async () => {
    await owner();
    await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true });
    // Another save lands between this one's read and its write.
    const put = drafts.put;
    drafts.put = async (key, bytes) => {
      await put(key, bytes);
      await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: 'DRAFT' }, UpdateExpression: 'SET rev = :r', ExpressionAttributeValues: { ':r': 7 } }));
    };
    expect((await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip('後'), ifMatch: 1 })).body.code).toBe('precondition_failed');
    const item = (await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: 'DRAFT' } }))).Item!;
    expect([...drafts.objects.keys()]).toEqual([item.key]);
  });

  it('takes only a ZIP of up to 3MB', async () => {
    await owner();
    expect((await call(alice, 'PUT', `${CH}/draft`, { body: { not: 'a zip' }, ifNoneMatch: true })).body.code).toBe('invalid_request');
    expect((await call(alice, 'PUT', `${CH}/draft`, { zip: utf8.encode('hello'), ifNoneMatch: true })).body.code).toBe('invalid_request');
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    big.set([0x50, 0x4b, 3, 4]);
    expect((await call(alice, 'PUT', `${CH}/draft`, { zip: big, ifNoneMatch: true })).body.code).toBe('payload_too_large');
  });

  it('is deleted with If-Match', async () => {
    await owner();
    await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true });
    expect((await call(alice, 'DELETE', `${CH}/draft`, { ifMatch: 2 })).status).toBe(412);
    expect((await call(alice, 'DELETE', `${CH}/draft`, { ifMatch: 1 })).status).toBe(204);
    expect(drafts.objects.size).toBe(0);
    expect((await call(alice, 'GET', CH)).body.draft).toBeNull();
  });
});

describe('who may use a draft (R-6, R-7, RV-04, RV-05)', () => {
  it('is the owner only: others and operators get 404', async () => {
    await owner();
    await owner(bob);
    await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true });
    for (const who of [bob, operator]) {
      expect((await call(who, 'GET', `${CH}/draft`)).status).toBe(404);
      expect((await call(who, 'PUT', `${CH}/draft`, { zip: draftZip(), ifMatch: 1 })).status).toBe(404);
      expect((await call(who, 'POST', `${CH}/draft/check`, { ifMatch: 1 })).status).toBe(404);
    }
  });

  it('can be read and deleted but not saved while suspended or after the channel is revoked', async () => {
    const publisherId = await owner();
    await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true });
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' }, UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'suspended' } }));
    expect((await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifMatch: 1 })).body.code).toBe('publisher_not_active');
    expect((await call(alice, 'POST', `${CH}/draft/check`, { ifMatch: 1 })).body.code).toBe('publisher_not_active');
    expect((await call(alice, 'GET', `${CH}/draft`)).status).toBe(200);

    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' }, UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'active' } }));
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: 'CH' }, UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'revoked' } }));
    expect((await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifMatch: 1 })).body.code).toBe('invalid_state');
    expect((await call(alice, 'DELETE', `${CH}/draft`, { ifMatch: 1 })).status).toBe(204);
  });

  it('goes when the account leaves', async () => {
    const publisherId = await owner(alice, true);
    await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true });
    await call(alice, 'PUT', `${COL}/draft`, { zip: draftZip(), ifNoneMatch: true });
    const me = await call(alice, 'GET', '/api/publisher');
    expect((await call(alice, 'DELETE', '/api/publisher', { body: { confirm: publisherId }, ifMatch: me.body.rev })).status).toBe(204);
    for (const pk of ['CH#kamakura-history', 'COL#kamakura-audio-guide']) {
      expect((await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: pk, SK: 'DRAFT' } }))).Item).toBeUndefined();
    }
    expect(drafts.objects.size).toBe(0);
  });

  it('of a collection needs the producer role', async () => {
    await owner(alice, true);
    const put = await call(alice, 'PUT', `${COL}/draft`, { zip: draftZip(), ifNoneMatch: true });
    expect(put.body).toMatchObject({ rev: 1 });
    expect([...drafts.objects.keys()][0]).toMatch(/^drafts\/col\/kamakura-audio-guide\/[0-9A-Z]{26}\.zip$/);
    expect((await call(alice, 'GET', COL)).body.draft).toMatchObject({ rev: 1 });
    expect((await call(operator, 'GET', COL)).body.draft).toBeUndefined();
  });
});

describe('the machine review of a draft (R-16〜R-19, RV-10)', () => {
  it('starts on the saved revision and runs one at a time', async () => {
    await owner();
    await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true });
    expect((await call(alice, 'POST', `${CH}/draft/check`)).status).toBe(428);
    expect((await call(alice, 'POST', `${CH}/draft/check`, { ifMatch: 2 })).status).toBe(412);

    const started = await call(alice, 'POST', `${CH}/draft/check`, { ifMatch: 1 });
    expect(started.status).toBe(202);
    expect(started.body.check).toMatchObject({ state: 'running', rev: 1 });
    expect(drafts.checks).toEqual([{ kind: 'channel', id: 'kamakura-history' }]);
    expect((await call(alice, 'POST', `${CH}/draft/check`, { ifMatch: 1 })).body.code).toBe('invalid_state');

    // A run lost for 15 minutes no longer holds it.
    clock += 15 * 60_000 + 1;
    expect((await call(alice, 'POST', `${CH}/draft/check`, { ifMatch: 1 })).status).toBe(202);

    // Saving again keeps the last check, for the screen to show as of an older revision.
    expect((await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip('後'), ifMatch: 1 })).body.check).toMatchObject({ state: 'running', rev: 1 });
  });

  it('counts 50 a day, apart from submissions', async () => {
    const publisherId = await owner(alice, true);
    await call(alice, 'PUT', `${CH}/draft`, { zip: draftZip(), ifNoneMatch: true });
    await call(alice, 'PUT', `${COL}/draft`, { zip: draftZip(), ifNoneMatch: true });
    await deps.db.send(new PutCommand({ TableName: deps.table, Item: { PK: `PUB#${publisherId}`, SK: 'QUOTA#2026-11-04', draftChecks: DRAFT_CHECKS_PER_DAY - 1 } }));
    expect((await call(alice, 'POST', `${COL}/draft/check`, { ifMatch: 1 })).status).toBe(202);
    expect(drafts.checks).toEqual([{ kind: 'collection', id: 'kamakura-audio-guide' }]);
    expect((await call(alice, 'POST', `${CH}/draft/check`, { ifMatch: 1 })).body.code).toBe('quota_exceeded');
    const quota = (await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'QUOTA#2026-11-04' } }))).Item!;
    expect(quota).toMatchObject({ draftChecks: DRAFT_CHECKS_PER_DAY });
    expect(quota.uploads).toBeUndefined();
    // Submitting still has its own count.
    expect((await call(alice, 'POST', `${CH}/submissions`, { body: {} })).status).toBe(201);
  });
});

describe('the owner’s own packages, to start a draft from (API-001 C-30)', () => {
  async function submission(state: string, extra: Record<string, unknown> = {}) {
    const submissionId = '01JBXYZ0000000000000000000';
    await deps.db.send(new PutCommand({
      TableName: deps.table,
      Item: {
        PK: 'CH#kamakura-history', SK: `SUB#${submissionId}`, type: 'submission', submissionId, state, sha256: 'ab'.repeat(32), iconSha256: 'cd'.repeat(32),
        intakeKey: `intake/kamakura-history/${submissionId}.zip`, iconIntakeKey: `intake/kamakura-history/${submissionId}.png`, rev: 1, ...extra,
      },
    }));
    return `${CH}/submissions/${submissionId}/package`;
  }

  it('comes from the intake bucket while it is kept', async () => {
    await owner();
    const path = await submission('returned');
    drafts.existing.add('archive/kamakura-history/01JBXYZ0000000000000000000.zip');
    const res = await call(alice, 'GET', path);
    expect(res.body).toMatchObject({
      packageUrl: 'https://intake.example/archive/kamakura-history/01JBXYZ0000000000000000000.zip?signed',
      iconUrl: 'https://intake.example/archive/kamakura-history/01JBXYZ0000000000000000000.png?signed',
    });
    expect((await call(operator, 'GET', path)).status).toBe(404);
  });

  it('comes from the public bucket for an approved version after 90 days, and is gone for the others', async () => {
    await owner();
    expect((await call(alice, 'GET', await submission('superseded'))).body).toMatchObject({
      packageUrl: `https://public.example/pkg/${'ab'.repeat(32)}.zip?signed`, iconUrl: `https://public.example/icons/${'cd'.repeat(32)}.png?signed`,
    });
    expect((await call(alice, 'GET', await submission('returned'))).body.code).toBe('not_found');
    expect((await call(alice, 'GET', await submission('uploading'))).body.code).toBe('not_found');
  });
});
