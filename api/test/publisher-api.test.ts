import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { accountId, b64url, generateEd25519, signDocument, signEd25519, utf8, verifyEd25519 } from '@yorisoi-console/protocol';
import { makeTestProvider, type TestProvider } from '@yorisoi-console/protocol/testing';
import { randomBytes, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPS, type Deps, type Notice } from '../src/console/deps.js';
import type { Caller } from '../src/console/http.js';
import { route } from '../src/console/router.js';
import { CursorCodec } from '../src/console/util.js';
import type { Trigger } from '../src/publish/ports.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';

const start = new Date('2026-10-04T03:00:00.000Z');
const alice: Caller = { sub: 'sub-alice', roles: ['publisher'] };
const bob: Caller = { sub: 'sub-bob', roles: ['publisher'] };
const operator: Caller = { sub: 'op-1', roles: ['operator'] };

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let deps: Deps;
let clock: number;
let published: Trigger[];
let notices: Notice[];
let archived: string[];
let deleted: string[];
let presigned: { key: string; contentType: string; maxBytes: number }[];
let trials: string[];
let provider: TestProvider;

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

beforeEach(async () => {
  const { table, db } = await freshTable(local.endpoint);
  clock = start.getTime();
  published = [];
  notices = [];
  archived = [];
  deleted = [];
  presigned = [];
  trials = [];
  provider = await makeTestProvider({ now: start });
  deps = {
    db,
    table,
    now: () => new Date(clock++),
    cursors: new CursorCodec(randomBytes(32)),
    rootPublicKey: b64url.encode(provider.rootKey),
    kmsPublicKey: async () => ({ keySpec: undefined, publicKey: new Uint8Array() }),
    requestPublish: async (t) => void published.push(t),
    presignUpload: async (key, contentType, maxBytes) => {
      presigned.push({ key, contentType, maxBytes });
      return { url: 'https://intake.example/', fields: { key } };
    },
    archiveUpload: async (key) => void archived.push(key),
    deleteUser: async (sub) => void deleted.push(sub),
    publishTrial: async (key, sha) => {
      trials.push(key);
      return `https://provider.example/trial/${sha}.zip`;
    },
    packageUrl: (sha) => `https://provider.example/pkg/${sha}.zip`,
    signDocument: (content) => signDocument(content, provider.signing),
    readUpload: async () => new Uint8Array(),
    presignDownload: async (key) => `https://intake.example/${key}?signed`,
    readRecord: async () => undefined,
    writeRecord: async () => {},
    notify: async (n) => void notices.push(n),
    publishCollection: async (_key: string, sha: string) => `https://provider.example/col/${sha}.zip`,
    apps: { sanpoguide: { ...DEFAULT_APPS.sanpoguide!, stageVersions: { 0: 1, 1: 9999, 2: 9999, 3: 9999 } } },
    publishApproved: async ({ packageSha256, iconSha256 }) => ({ packageUrl: `https://provider.example/pkg/${packageSha256}.zip`, iconUrl: `https://provider.example/icons/${iconSha256}.png` }),
  };
});

async function call(caller: Caller, method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) {
  const res = await route(deps, {
    method, path, query: {}, body: options.body, caller, requestId: 'req',
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
  });
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

/** Registers [who] as a publisher and binds a fresh key, as the SPA does. */
async function activePublisher(who: Caller = alice) {
  const reg = await call(who, 'POST', '/api/publisher', { body: { displayName: '鎌倉歴史散歩の会', contact: 'kamakura@example.com' } });
  const key = generateEd25519();
  await bind(who, key.privateKey, key.publicKey);
  return { publisherId: reg.body.publisherId as string, key };
}

async function bind(who: Caller, privateKey: KeyObject, publicKey: Uint8Array) {
  const challenge = await call(who, 'POST', '/api/publisher/keys/challenge');
  return call(who, 'POST', '/api/publisher/keys', {
    body: { nonce: challenge.body.nonce, publicKey: b64url.encode(publicKey), signature: b64url.encode(signEd25519(privateKey, utf8.encode(challenge.body.message))) },
  });
}

describe('registering', () => {
  it('makes a publisher waiting for a key, once per user', async () => {
    expect((await call(operator, 'POST', '/api/publisher', { body: { displayName: 'x', contact: 'y' } })).body.code).toBe('forbidden');
    const res = await call(alice, 'POST', '/api/publisher', { body: { displayName: '鎌倉歴史散歩の会', contact: 'kamakura@example.com' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_key', activeAccountId: null, limits: { channels: 5 }, usage: { channels: 0 } });
    expect((await call(alice, 'POST', '/api/publisher', { body: { displayName: 'again', contact: 'x' } })).body.code).toBe('already_registered');
    expect((await call(alice, 'GET', '/api/me')).body.publisher).toMatchObject({ status: 'pending_key' });
    expect((await call(bob, 'GET', '/api/publisher')).body.code).toBe('not_found');
  });

  it('edits the name and contact with If-Match', async () => {
    await call(alice, 'POST', '/api/publisher', { body: { displayName: 'a', contact: 'b' } });
    expect((await call(alice, 'PATCH', '/api/publisher', { body: { displayName: '新しい名前' } })).status).toBe(428);
    const res = await call(alice, 'PATCH', '/api/publisher', { body: { displayName: '新しい名前' }, ifMatch: 1 });
    expect(res.body).toMatchObject({ displayName: '新しい名前', rev: 2 });
  });
});

describe('binding a key (ARCH-001 A-5)', () => {
  it('needs a signature over a fresh challenge by that key', async () => {
    await call(alice, 'POST', '/api/publisher', { body: { displayName: 'a', contact: 'b' } });
    const key = generateEd25519();
    const other = generateEd25519();
    const challenge = await call(alice, 'POST', '/api/publisher/keys/challenge');
    const wrong = await call(alice, 'POST', '/api/publisher/keys', {
      body: { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(other.privateKey, utf8.encode(challenge.body.message))) },
    });
    expect(wrong.body.code).toBe('invalid_signature');

    const good = { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(key.privateKey, utf8.encode(challenge.body.message))) };
    const res = await call(alice, 'POST', '/api/publisher/keys', { body: good });
    expect(res.body).toMatchObject({ accountId: accountId(key.publicKey), status: 'active' });
    expect((await call(alice, 'GET', '/api/publisher')).body).toMatchObject({ status: 'active', activeAccountId: accountId(key.publicKey) });
    // The challenge is spent, and a second key needs a transfer.
    expect((await call(alice, 'POST', '/api/publisher/keys', { body: good })).body.code).toBe('key_already_bound');
  });

  it('refuses an expired challenge', async () => {
    await call(alice, 'POST', '/api/publisher', { body: { displayName: 'a', contact: 'b' } });
    const key = generateEd25519();
    const challenge = await call(alice, 'POST', '/api/publisher/keys/challenge');
    clock += 11 * 60_000;
    const res = await call(alice, 'POST', '/api/publisher/keys', {
      body: { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(key.privateKey, utf8.encode(challenge.body.message))) },
    });
    expect(res.body.code).toBe('challenge_invalid');
  });

  it('never lets two publishers share an account id (DM-001 M-7)', async () => {
    const { key } = await activePublisher(alice);
    await call(bob, 'POST', '/api/publisher', { body: { displayName: 'b', contact: 'b' } });
    expect((await bind(bob, key.privateKey, key.publicKey)).body.code).toBe('account_id_taken');
  });
});

describe('channels', () => {
  it('needs an active publisher, a free id, and room under the limit', async () => {
    await call(alice, 'POST', '/api/publisher', { body: { displayName: 'a', contact: 'b' } });
    expect((await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } })).body.code).toBe('publisher_not_active');
    const key = generateEd25519();
    await bind(alice, key.privateKey, key.publicKey);

    expect((await call(alice, 'POST', '/api/channels', { body: { channelId: 'Bad_ID' } })).body.code).toBe('invalid_request');
    expect((await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } })).status).toBe(201);
    await activePublisher(bob);
    expect((await call(bob, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } })).body.code).toBe('channel_id_taken');
    for (let i = 2; i <= 5; i++) expect((await call(alice, 'POST', '/api/channels', { body: { channelId: `channel-${i}` } })).status).toBe(201);
    expect((await call(alice, 'POST', '/api/channels', { body: { channelId: 'channel-6' } })).body.code).toBe('limit_reached');
    expect((await call(alice, 'GET', '/api/channels')).body.items).toHaveLength(5);
  });

  it('shows a channel to its publisher and operators only', async () => {
    await activePublisher(alice);
    await activePublisher(bob);
    await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } });
    expect((await call(alice, 'GET', '/api/channels/kamakura-history')).status).toBe(200);
    expect((await call(operator, 'GET', '/api/channels/kamakura-history')).status).toBe(200);
    // Someone else's channel is not even shown to exist.
    expect((await call(bob, 'GET', '/api/channels/kamakura-history')).status).toBe(404);
    expect((await call(bob, 'GET', '/api/channels/kamakura-history/submissions')).status).toBe(404);
  });
});

describe('submissions', () => {
  async function channel() {
    const p = await activePublisher();
    await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } });
    return p;
  }

  it('hands out upload URLs with S3-enforced limits', async () => {
    await channel();
    const res = await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: { description: '説明', tags: ['history'], regions: ['xn7'] } });
    expect(res.status).toBe(201);
    expect(res.body.submission).toMatchObject({ state: 'uploading', channelId: 'kamakura-history' });
    expect(presigned).toEqual([
      { key: `intake/kamakura-history/${res.body.submission.submissionId}.zip`, contentType: 'application/zip', maxBytes: 2 * 1024 * 1024 },
      { key: `intake/kamakura-history/${res.body.submission.submissionId}.png`, contentType: 'image/png', maxBytes: 100 * 1024 },
    ]);
    expect((await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: { tags: ['NG TAG'] } })).body.code).toBe('invalid_request');
  });

  it('allows one pending submission per channel; an upload that never came frees it after an hour', async () => {
    await channel();
    const first = await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} });
    expect((await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} })).body.code).toBe('pending_submission_exists');
    clock += 61 * 60_000;
    const second = await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} });
    expect(second.status).toBe(201);
    const old = await call(alice, 'GET', `/api/channels/kamakura-history/submissions/${first.body.submission.submissionId}`);
    expect(old.body.state).toBe('expired');
  });

  it('counts uploads per day in Japan (DM-001 M-2)', async () => {
    const { publisherId } = await channel();
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' }, UpdateExpression: 'SET limits = :l', ExpressionAttributeValues: { ':l': { uploadsPerDay: 2 } } }));
    for (let i = 0; i < 2; i++) {
      expect((await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} })).status).toBe(201);
      clock += 61 * 60_000; // let the upload lapse so the channel is free again
    }
    expect((await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} })).body.code).toBe('quota_exceeded');
    // 03:00Z + ~3h is still the same day in Japan; the next day resets.
    clock = Date.parse('2026-10-04T15:30:00.000Z');
    expect((await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} })).status).toBe(201);
  });

  it('withdraws a submission in review and frees the channel', async () => {
    await channel();
    const created = await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} });
    const sid = created.body.submission.submissionId as string;
    // Uploading can't be withdrawn; it expires instead.
    expect((await call(alice, 'POST', `/api/channels/kamakura-history/submissions/${sid}/withdraw`, { ifMatch: 1 })).body.code).toBe('invalid_state');
    // As if the machine review (stage 3b) had passed it.
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: `SUB#${sid}` }, UpdateExpression: 'SET #s = :a, rev = :r', ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':a': 'awaiting_review', ':r': 2 } }));
    const res = await call(alice, 'POST', `/api/channels/kamakura-history/submissions/${sid}/withdraw`, { ifMatch: 2 });
    expect(res.body).toMatchObject({ state: 'withdrawn' });
    expect(archived).toEqual([`intake/kamakura-history/${sid}.zip`, `intake/kamakura-history/${sid}.png`]);
    expect((await call(alice, 'GET', '/api/channels/kamakura-history')).body.pendingSubmissionId).toBeNull();
    expect((await call(alice, 'GET', '/api/channels/kamakura-history/submissions')).body.items.map((x: { state: string }) => x.state)).toEqual(['withdrawn']);
  });

  it('refuses a suspended publisher', async () => {
    const { publisherId } = await channel();
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' }, UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'suspended' } }));
    expect((await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} })).body.code).toBe('publisher_not_active');
    expect((await call(alice, 'POST', '/api/publisher/keys/challenge')).body.code).toBe('publisher_not_active');
  });
});

describe('leaving (API-001 C-4)', () => {
  it('revokes listed channels, keeps ids reserved and deletes the user', async () => {
    const { publisherId, key } = await activePublisher();
    await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } });
    // As if approved and listed.
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: 'CH' }, UpdateExpression: 'SET GSI2PK = :l, GSI2SK = :k', ExpressionAttributeValues: { ':l': 'LISTED', ':k': 'CH#kamakura-history' } }));
    const pub = await call(alice, 'GET', '/api/publisher');
    expect((await call(alice, 'DELETE', '/api/publisher', { body: { confirm: 'wrong' }, ifMatch: pub.body.rev })).body.code).toBe('invalid_request');
    expect((await call(alice, 'DELETE', '/api/publisher', { body: { confirm: publisherId }, ifMatch: pub.body.rev })).status).toBe(204);

    expect(deleted).toEqual(['sub-alice']);
    expect(published).toEqual(['revoke']);
    const ch = await call(operator, 'GET', '/api/channels/kamakura-history');
    expect(ch.body).toMatchObject({ status: 'revoked', listed: false, revocations: [{ reason: 'チャンネル提供者が退会したため' }] });
    const left = await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' } }));
    expect(left.Item).toMatchObject({ status: 'deleted' });
    expect(left.Item?.contact).toBeUndefined();

    // The channel id and the account id can't be taken by anyone else.
    await deps.db.send(new PutCommand({ TableName: deps.table, Item: { PK: 'USER#sub-alice', SK: 'USER', publisherId: 'x' } })).catch(() => undefined);
    await activePublisher(bob).catch(() => undefined);
    expect((await call(bob, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } })).body.code).toBe('channel_id_taken');
    const carol: Caller = { sub: 'sub-carol', roles: ['publisher'] };
    await call(carol, 'POST', '/api/publisher', { body: { displayName: 'c', contact: 'c' } });
    expect((await bind(carol, key.privateKey, key.publicKey)).body.code).toBe('account_id_taken');
  });
});

describe('test tickets (API-CHANNEL-LIST 試用チケット)', () => {
  async function passedSubmission(state = 'awaiting_review') {
    await activePublisher();
    await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } });
    const created = await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: {} });
    const sid = created.body.submission.submissionId as string;
    // As the machine review leaves it.
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: `SUB#${sid}` },
        UpdateExpression: 'SET #s = :s, sha256 = :h, #size = :z, version = :v, validation = :val',
        ExpressionAttributeNames: { '#s': 'state', '#size': 'size' },
        ExpressionAttributeValues: { ':s': state, ':h': 'ab'.repeat(32), ':z': 1234, ':v': 3, ':val': { ok: true, errors: [] } },
      }),
    );
    return sid;
  }

  it('signs a ticket the app can check, for a package that passed the machine review', async () => {
    const sid = await passedSubmission();
    const res = await call(alice, 'POST', `/api/channels/kamakura-history/submissions/${sid}/test-tickets`);
    expect(res.status).toBe(201);
    const doc = res.body.document;
    expect(res.body.qr).toBe(JSON.stringify(doc));
    expect(doc.keyId).toBe('k-test');
    expect(verifyEd25519(provider.signing.publicKey, b64url.decode(doc.payload), b64url.decode(doc.sig))).toBe(true);
    const payload = JSON.parse(utf8.decode(b64url.decode(doc.payload)));
    expect(payload).toMatchObject({
      type: 'test-ticket', provider: provider.provider, channel: 'kamakura-history',
      package: { url: `https://provider.example/trial/${'ab'.repeat(32)}.zip`, sha256: 'ab'.repeat(32), size: 1234, format: 1 },
    });
    expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(7 * 24 * 3600_000);
    expect(trials).toEqual([`intake/kamakura-history/${sid}.zip`]);
    expect((await call(alice, 'GET', `/api/channels/kamakura-history/submissions/${sid}/test-tickets`)).body.items).toHaveLength(1);
  });

  it('takes a returned package from archive/, and none that failed or is still uploading', async () => {
    const sid = await passedSubmission('returned');
    await call(alice, 'POST', `/api/channels/kamakura-history/submissions/${sid}/test-tickets`);
    expect(trials).toEqual([`archive/kamakura-history/${sid}.zip`]);
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: `SUB#${sid}` }, UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':s': 'validation_failed' } }));
    expect((await call(alice, 'POST', `/api/channels/kamakura-history/submissions/${sid}/test-tickets`)).body.code).toBe('invalid_state');
  });

  it('allows 10 tickets a day, to the channel’s publisher only', async () => {
    const sid = await passedSubmission();
    for (let i = 0; i < 10; i++) expect((await call(alice, 'POST', `/api/channels/kamakura-history/submissions/${sid}/test-tickets`)).status).toBe(201);
    expect((await call(alice, 'POST', `/api/channels/kamakura-history/submissions/${sid}/test-tickets`)).body.code).toBe('quota_exceeded');
    expect((await call(operator, 'POST', `/api/channels/kamakura-history/submissions/${sid}/test-tickets`)).body.code).toBe('forbidden');
  });
});
