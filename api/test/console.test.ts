import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, generateEd25519, localSigner, publicKeyFromRaw, signDocument, utf8, verifyChannelList, verifyDiscovery, type Keyset } from '@yorisoi-console/protocol';
import { makeTestProvider, sampleChannel, type TestProvider } from '@yorisoi-console/protocol/testing';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPS, type Deps, type Notice } from '../src/console/deps.js';
import type { Caller, Response } from '../src/console/http.js';
import { callerFrom, route } from '../src/console/router.js';
import { CursorCodec, ulid } from '../src/console/util.js';
import { DynamoStore } from '../src/publish/aws.js';
import { DISCOVERY_PATH, LIST_PATH, MemoryStorage, noCdn, publish } from '../src/publish/index.js';
import type { Trigger } from '../src/publish/ports.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';
import { memoryDrafts } from './drafts-fake.js';

const now = new Date('2026-10-03T03:00:00.000Z');
const operator: Caller = { sub: 'op-1', roles: ['operator'] };
const publisherCaller: Caller = { sub: 'pub-1', roles: ['publisher'] };

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let deps: Deps;
let rawDb: DynamoDBClient;
let ticks = 0;
let published: Trigger[];
let notices: Notice[];
let p: TestProvider;
const kmsKeys = new Map<string, Uint8Array>();

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

beforeEach(async () => {
  const { table, db, raw } = await freshTable(local.endpoint);
  rawDb = raw;
  ticks = 0;
  p = await makeTestProvider({ now });
  published = [];
  notices = [];
  kmsKeys.clear();
  deps = {
    db,
    table,
    // Each read moves the clock on by 1ms, so audit entries of one test keep their order.
    now: () => new Date(now.getTime() + ticks++),
    cursors: new CursorCodec(randomBytes(32)),
    rootPublicKey: b64url.encode(p.rootKey),
    kmsPublicKey: async (arn) => {
      const raw = kmsKeys.get(arn) ?? new Uint8Array(32);
      const der = publicKeyFromRaw(raw).export({ format: 'der', type: 'spki' });
      return { keySpec: kmsKeys.has(arn) ? 'ECC_NIST_EDWARDS25519' : 'RSA_2048', publicKey: new Uint8Array(der) };
    },
    requestPublish: async (trigger) => {
      published.push(trigger);
    },
    presignUpload: async (key) => ({ url: 'https://intake.example/', fields: { key } }),
    archiveUpload: async () => {},
    deleteUser: async () => {},
    publishTrial: async (_k, sha) => `https://provider.example/trial/${sha}.zip`,
    packageUrl: (sha) => `https://provider.example/pkg/${sha}.zip`,
    signDocument: async () => ({ payload: '', keyId: 'k', sig: '' }),
    readUpload: async () => new Uint8Array(),
    presignDownload: async (key) => `https://intake.example/${key}?signed`,
    readRecord: async () => undefined,
    writeRecord: async () => {},
    notify: async (n) => void notices.push(n),
    publishCollection: async (_key: string, sha: string) => `https://provider.example/col/${sha}.zip`,
    drafts: memoryDrafts(),
    apps: { sanpoguide: { ...DEFAULT_APPS.sanpoguide!, stageVersions: { 0: 1, 1: 9999, 2: 9999, 3: 9999 } } },
    publishApproved: async ({ packageSha256, iconSha256 }) => ({ packageUrl: `https://provider.example/pkg/${packageSha256}.zip`, iconUrl: `https://provider.example/icons/${iconSha256}.png` }),
  };
});

async function call(method: string, path: string, options: { body?: unknown; ifMatch?: number | string; caller?: Caller; query?: Record<string, string> } = {}) {
  const res: Response = await route(deps, {
    method,
    path,
    query: options.query ?? {},
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
    body: options.body,
    caller: options.caller ?? operator,
    requestId: 'req-1',
  });
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

async function seedPublisher(status = 'active') {
  const publisherId = ulid(now.getTime());
  await deps.db.send(
    new PutCommand({
      TableName: deps.table,
      Item: {
        PK: `PUB#${publisherId}`, SK: 'PUB', type: 'publisher', roles: ['publisher'], publisherId, ownerSub: 'pub-1', displayName: '鎌倉歴史散歩の会',
        contact: 'kamakura@example.com', status, activeAccountId: 'sg1' + 'a'.repeat(32), channelCount: 1, rev: 1,
        createdAt: now.toISOString(), updatedAt: now.toISOString(), GSI2PK: 'PUBLISHERS', GSI2SK: now.toISOString(),
      },
    }),
  );
  return publisherId;
}

async function seedListedChannel(publisherId: string) {
  const { id, publisherName: _n, media: _m, resourcesSize: _r, ...entry } = sampleChannel();
  const submissionId = ulid(now.getTime());
  await deps.db.send(
    new PutCommand({
      TableName: deps.table,
      Item: {
        PK: `CH#${id}`, SK: 'CH', type: 'channel', channelId: id, publisherId, status: 'active', rev: 4,
        latestApproved: { ...entry, submissionId, appStage: 0, collections: [], ownPrefetchBytes: 0, ownMedia: [] }, createdAt: now.toISOString(), updatedAt: now.toISOString(),
        GSI1PK: `PUB#${publisherId}`, GSI1SK: `CH#${id}`, GSI2PK: 'LISTED', GSI2SK: `CH#${id}`,
      },
    }),
  );
  await deps.db.send(
    new PutCommand({ TableName: deps.table, Item: { PK: `CH#${id}`, SK: `SUB#${submissionId}`, type: 'submission', submissionId, state: 'approved', rev: 3 } }),
  );
  return id;
}

/** A signing key "in KMS", registered through the API, plus a keyset listing it signed by the root key. */
async function registerKey(keyId = 'k-2026-10') {
  const key = generateEd25519();
  const arn = `arn:aws:kms:ap-northeast-1:123456789012:key/${Buffer.from(keyId).toString('hex').padEnd(32, '0').slice(0, 32)}`;
  kmsKeys.set(arn, key.publicKey);
  const res = await call('POST', '/api/admin/signing-keys', { body: { keyId, kmsKeyArn: arn } });
  return { key, arn, res };
}

function keysetWith(entries: { keyId: string; publicKey: Uint8Array }[], seq: number, revokedKeys: string[] = []): Keyset {
  return {
    type: 'keyset', provider: p.provider, seq, issuedAt: now.toISOString(), revokedKeys,
    keys: entries.map((e) => ({ keyId: e.keyId, publicKey: b64url.encode(e.publicKey), notBefore: '2026-10-01T00:00:00.000Z', notAfter: '2027-03-01T00:00:00.000Z' })),
  };
}

describe('access', () => {
  it('lets only operators use the operator API', async () => {
    expect((await call('GET', '/api/admin/publishers', { caller: publisherCaller })).body.code).toBe('forbidden');
    expect((await call('GET', '/api/admin/publishers')).status).toBe(200);
  });

  it('answers 404 for unknown routes and malformed ids', async () => {
    expect((await call('GET', '/api/admin/nothing')).status).toBe(404);
    expect((await call('GET', '/api/admin/publishers/not-an-id')).status).toBe(404);
    expect((await call('GET', '/api/admin/publishers/' + ulid())).body.code).toBe('not_found');
  });

  it('reads roles from the cognito:groups claim in either form', () => {
    expect(callerFrom({ sub: 's', 'cognito:groups': '[operator publisher]' }).roles).toEqual(['operator', 'publisher']);
    expect(callerFrom({ sub: 's', 'cognito:groups': ['publisher', 'admins'] }).roles).toEqual(['publisher']);
    expect(callerFrom({ sub: 's' }).roles).toEqual([]);
  });

  it('answers with a problem document', async () => {
    const res = await call('GET', '/api/admin/publishers/' + ulid());
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'not_found', instance: 'req-1' });
  });
});

describe('publishers', () => {
  it('suspends and resumes with If-Match, and records why', async () => {
    const id = await seedPublisher();
    expect((await call('POST', `/api/admin/publishers/${id}/suspend`, { body: { reason: '規約違反の疑い' } })).status).toBe(428);
    expect((await call('POST', `/api/admin/publishers/${id}/suspend`, { body: { reason: 'x' }, ifMatch: 9 })).status).toBe(412);
    const suspended = await call('POST', `/api/admin/publishers/${id}/suspend`, { body: { reason: '規約違反の疑い' }, ifMatch: 1 });
    expect(suspended.body).toMatchObject({ status: 'suspended', statusReason: '規約違反の疑い', rev: 2 });
    expect(suspended.headers.etag).toBe('"2"');
    expect((await call('POST', `/api/admin/publishers/${id}/suspend`, { body: { reason: 'again' }, ifMatch: 2 })).body.code).toBe('invalid_state');
    expect((await call('POST', `/api/admin/publishers/${id}/resume`, { body: { reason: '確認できた' }, ifMatch: 2 })).body.status).toBe('active');

    const audit = await call('GET', '/api/admin/audit', { query: { target: `PUB#${id}` } });
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(['publisher.resume', 'publisher.suspend']);
  });

  it('changes and clears limits', async () => {
    const id = await seedPublisher();
    const raised = await call('PUT', `/api/admin/publishers/${id}/limits`, { body: { channels: 10, reason: '観光協会' }, ifMatch: 1 });
    expect(raised.body.limits).toEqual({ channels: 10, collections: 5, uploadsPerDay: 20, ticketsPerDay: 10 });
    const cleared = await call('PUT', `/api/admin/publishers/${id}/limits`, { body: { reason: '戻す' }, ifMatch: 2 });
    expect(cleared.body.limits).toEqual({ channels: 5, collections: 5, uploadsPerDay: 20, ticketsPerDay: 10 });
    expect((await call('PUT', `/api/admin/publishers/${id}/limits`, { body: { channels: -1, reason: 'x' }, ifMatch: 3 })).body.code).toBe('invalid_request');
  });

  it('lists newest first, with a cursor that cannot be forged', async () => {
    for (let i = 0; i < 3; i++) await seedPublisher(i === 1 ? 'suspended' : 'active');
    const first = await call('GET', '/api/admin/publishers', { query: { limit: '2' } });
    expect(first.body.items).toHaveLength(2);
    const second = await call('GET', '/api/admin/publishers', { query: { limit: '2', cursor: first.body.nextCursor } });
    expect(second.body.items).toHaveLength(1);
    expect((await call('GET', '/api/admin/publishers', { query: { cursor: 'AAAA' + first.body.nextCursor } })).body.code).toBe('invalid_request');
    const suspended = await call('GET', '/api/admin/publishers', { query: { status: 'suspended' } });
    expect(suspended.body.items.map((x: { status: string }) => x.status)).toEqual(['suspended']);
  });
});

describe('signing keys and keysets', () => {
  it('registers an Ed25519 KMS key once', async () => {
    const { res } = await registerKey();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ keyId: 'k-2026-10', status: 'registered' });
    expect((await call('POST', '/api/admin/signing-keys', { body: { keyId: 'k-2026-10', kmsKeyArn: res.body.kmsKeyArn } })).body.code).toBe('invalid_state');
    const rsa = await call('POST', '/api/admin/signing-keys', { body: { keyId: 'k-2026-11', kmsKeyArn: 'arn:aws:kms:ap-northeast-1:123456789012:key/0123abcd-0000-0000-0000-000000000000' } });
    expect(rsa.body.code).toBe('invalid_request');
  });

  it('registers a root-signed keyset, activates its keys and publishes', async () => {
    const { key } = await registerKey();
    const document = await signDocument(keysetWith([{ keyId: 'k-2026-10', publicKey: key.publicKey }], 1), p.root);
    const res = await call('POST', '/api/admin/keysets', { body: { document } });
    expect(res.status).toBe(201);
    expect(published).toEqual(['keyset']);
    const keys = await call('GET', '/api/admin/signing-keys');
    expect(keys.body.items[0]).toMatchObject({ status: 'active', notAfter: '2027-03-01T00:00:00.000Z' });
  });

  it('refuses keysets the root key did not sign, old seqs and unregistered keys', async () => {
    const { key } = await registerKey();
    const other = await makeTestProvider({ now });
    const forged = await signDocument(keysetWith([{ keyId: 'k-2026-10', publicKey: key.publicKey }], 1), { ...other.root, keyId: p.provider });
    expect((await call('POST', '/api/admin/keysets', { body: { document: forged } })).body.code).toBe('invalid_signature');

    const stranger = await signDocument(keysetWith([{ keyId: 'k-2026-10', publicKey: generateEd25519().publicKey }], 1), p.root);
    expect((await call('POST', '/api/admin/keysets', { body: { document: stranger } })).body.code).toBe('keyset_invalid');

    await call('POST', '/api/admin/keysets', { body: { document: await signDocument(keysetWith([{ keyId: 'k-2026-10', publicKey: key.publicKey }], 2), p.root) } });
    const old = await signDocument(keysetWith([{ keyId: 'k-2026-10', publicKey: key.publicKey }], 2), p.root);
    expect((await call('POST', '/api/admin/keysets', { body: { document: old } })).body.code).toBe('keyset_invalid');
  });

  it('retires a key the new keyset drops, and revokes one it revokes', async () => {
    const a = await registerKey('k-2026-10');
    const b = await registerKey('k-2027-04');
    await call('POST', '/api/admin/keysets', { body: { document: await signDocument(keysetWith([{ keyId: 'k-2026-10', publicKey: a.key.publicKey }], 1), p.root) } });
    await call('POST', '/api/admin/keysets', { body: { document: await signDocument(keysetWith([{ keyId: 'k-2027-04', publicKey: b.key.publicKey }], 2), p.root) } });
    let status = Object.fromEntries((await call('GET', '/api/admin/signing-keys')).body.items.map((k: { keyId: string; status: string }) => [k.keyId, k.status]));
    expect(status).toEqual({ 'k-2026-10': 'retiring', 'k-2027-04': 'active' });
    await call('POST', '/api/admin/keysets', {
      body: { document: await signDocument(keysetWith([{ keyId: 'k-2027-04', publicKey: b.key.publicKey }], 3, ['k-2026-10']), p.root) },
    });
    status = Object.fromEntries((await call('GET', '/api/admin/signing-keys')).body.items.map((k: { keyId: string; status: string }) => [k.keyId, k.status]));
    expect(status['k-2026-10']).toBe('revoked');
    expect((await call('GET', '/api/admin/keysets')).body.items.map((k: { seq: number }) => k.seq)).toEqual([3, 2, 1]);
  });
});

describe('revoking a channel', () => {
  it('takes it off the list, marks the approved version and asks for a publication', async () => {
    const id = await seedListedChannel(await seedPublisher());
    expect((await call('GET', `/api/channels/${id}`)).body).toMatchObject({ status: 'active', listed: true, rev: 4 });
    const res = await call('POST', `/api/admin/channels/${id}/revoke`, { body: { reason: '基準 2.2 に反するため', severity: 'high' }, ifMatch: 4 });
    expect(res.body).toMatchObject({ status: 'revoked', listed: false, revocations: [{ reason: '基準 2.2 に反するため', severity: 'high' }] });
    expect(published).toEqual(['revoke']);
    const sub = await deps.db.send(new QueryCommand({ TableName: deps.table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)', ExpressionAttributeValues: { ':pk': `CH#${id}`, ':s': 'SUB#' } }));
    expect(sub.Items?.[0]?.state).toBe('revoked');
    expect((await call('POST', `/api/admin/channels/${id}/revoke`, { body: { reason: 'x', severity: 'low' }, ifMatch: 5 })).body.code).toBe('invalid_state');
    expect((await call('GET', '/api/admin/audit', { query: { month: '2026-10' } })).body.items[0]).toMatchObject({ action: 'channel.revoke', actorSub: 'op-1' });
  });

  it('is what the publisher then puts out (console API and publisher agree on DM-001)', async () => {
    const id = await seedListedChannel(await seedPublisher());
    const { key } = await registerKey();
    await call('POST', '/api/admin/keysets', { body: { document: await signDocument(keysetWith([{ keyId: 'k-2026-10', publicKey: key.publicKey }], 1), p.root) } });

    const storage = new MemoryStorage();
    const publishOnce = async () => {
      await publish(
        {
          store: new DynamoStore(deps.table, rawDb),
          storage,
          cdn: noCdn,
          signerFor: () => localSigner('k-2026-10', key.privateKey),
          config: { rootPublicKey: p.rootKey, name: 'Test' },
          now: () => now,
        },
        'manual',
      );
      const provider = verifyDiscovery(JSON.parse(utf8.decode(storage.public.get(DISCOVERY_PATH)!)), { expectedProvider: p.provider });
      return verifyChannelList(JSON.parse(utf8.decode(storage.public.get(LIST_PATH)!)), provider.keyset, { now }).body;
    };

    const before = await publishOnce();
    expect(before.channels.map((c) => c.id)).toEqual([id]);
    expect(before.channels[0]?.publisherName).toBe('鎌倉歴史散歩の会');

    await call('POST', `/api/admin/channels/${id}/revoke`, { body: { reason: '基準に反するため', severity: 'high', versions: [3] }, ifMatch: 4 });
    const after = await publishOnce();
    expect(after.channels).toEqual([]);
    expect(after.revoked).toMatchObject([{ id, versions: [3], reason: '基準に反するため' }]);
    expect((await call('GET', '/api/admin/publications')).body.items.map((x: { seq: number }) => x.seq)).toEqual([2, 1]);
    const head = await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: 'PUBLICATION', SK: 'HEAD' } }));
    expect(head.Item?.seq).toBe(2);
  });
});
