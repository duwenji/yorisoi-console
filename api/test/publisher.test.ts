import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, generateEd25519, localSigner, signDocument, utf8, verifyChannelList, verifyDiscovery } from '@yorisoi-console/protocol';
import { makeTestProvider, sampleChannel, type TestProvider } from '@yorisoi-console/protocol/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { DynamoStore, kmsSigner } from '../src/publish/aws.js';
import { DISCOVERY_PATH, LIST_PATH, MemoryStorage, MemoryStore, SeqConflictError, noCdn, publish, type PublishDeps } from '../src/publish/index.js';

const now = new Date('2026-10-03T03:00:00.000Z');
const days = (n: number) => new Date(now.getTime() + n * 24 * 3600_000);

let p: TestProvider;
let store: MemoryStore;
let storage: MemoryStorage;
let deps: PublishDeps;

beforeEach(async () => {
  p = await makeTestProvider({ now });
  store = new MemoryStore();
  store.keyset = p.discovery.keyset;
  store.keys.set('k-test', { keyId: 'k-test', kmsKeyArn: 'arn:test', status: 'active' });
  store.channels = [{ entry: sampleChannel() }];
  storage = new MemoryStorage();
  deps = { store, storage, cdn: noCdn, signerFor: () => p.signing, config: { rootPublicKey: p.rootKey, name: 'Test provider' }, now: () => now };
});

function published() {
  const json = (path: string) => JSON.parse(utf8.decode(storage.public.get(path)!));
  const provider = verifyDiscovery(json(DISCOVERY_PATH), { expectedProvider: p.provider });
  return verifyChannelList(json(LIST_PATH), provider.keyset, { now });
}

describe('publish', () => {
  it('puts out a discovery document and a list that an app accepts', async () => {
    const record = await publish(deps, 'manual');
    const list = published();
    expect(list.body.seq).toBe(1);
    expect(list.body.channels.map((c) => c.id)).toEqual(['kamakura-history']);
    expect(list.body.expiresAt).toBe(days(14).toISOString());
    expect(record).toMatchObject({ seq: 1, keyId: 'k-test', trigger: 'manual', channelCount: 1, archiveKey: 'published/1.json' });
    expect(storage.archive.get('published/1.json')).toEqual(storage.public.get(LIST_PATH));
  });

  it('takes the next seq on every run', async () => {
    await publish(deps, 'approve');
    await publish(deps, 'daily');
    expect(published().body.seq).toBe(2);
    expect(store.history.map((h) => h.trigger)).toEqual(['approve', 'daily']);
  });

  it('writes nothing when another run took the seq first', async () => {
    await publish(deps, 'manual');
    storage.public.clear();
    // This run read the head before the other run recorded seq 1.
    store.headSeq = async () => null;
    await expect(publish(deps, 'manual')).rejects.toBeInstanceOf(SeqConflictError);
    expect(storage.public.size).toBe(0);
    expect(store.history).toHaveLength(1);
  });

  it('uses only an active key of the keyset', async () => {
    store.keys.set('k-test', { keyId: 'k-test', kmsKeyArn: 'arn:test', status: 'registered' });
    await expect(publish(deps, 'manual')).rejects.toThrow('no active signing key');
    expect(storage.public.size).toBe(0);
  });

  it('refuses a keyset the pinned root key did not sign', async () => {
    const other = await makeTestProvider({ now });
    store.keyset = other.discovery.keyset;
    await expect(publish(deps, 'manual')).rejects.toThrow();
    expect(storage.public.size).toBe(0);
  });

  it('refuses to publish when the KMS key is not the key in the keyset', async () => {
    const wrong = localSigner('k-test', generateEd25519().privateKey);
    await expect(publish({ ...deps, signerFor: () => wrong }, 'manual')).rejects.toThrow('bad_signature');
    expect(storage.public.size).toBe(0);
    expect(store.history).toHaveLength(0);
  });

  it('lists revocations for 7 days, then stops (DM-001 M-9)', async () => {
    store.revoked = [
      { id: 'recent', reason: '基準に反するため', revokedAt: days(-2).toISOString(), listed: true },
      { id: 'old', reason: '基準に反するため', revokedAt: days(-8).toISOString(), listed: true },
    ];
    await publish(deps, 'revoke');
    expect(published().body.revoked.map((r) => r.id)).toEqual(['recent']);
    expect(store.revoked.find((r) => r.id === 'old')?.listed).toBe(false);
  });

  it('shows a publisher change until its end date (API-CHANNEL-LIST P-9)', async () => {
    const change = { from: 'sg1' + 'b'.repeat(32), at: days(-1).toISOString(), reason: '配信元の鍵の紛失' };
    store.channels = [{ entry: sampleChannel(), publisherChange: { ...change, until: days(89).toISOString() } }];
    await publish(deps, 'transfer');
    expect(published().body.channels[0]?.publisherChange).toEqual(change);
    store.channels = [{ entry: sampleChannel(), publisherChange: { ...change, until: days(-1).toISOString() } }];
    await publish(deps, 'daily');
    expect(published().body.channels[0]?.publisherChange).toBeUndefined();
  });

  it('chains a new keyset only when the root key signed it', async () => {
    const next = { ...p.keyset, seq: 2 };
    store.keyset = await signDocument(next, p.root);
    await publish(deps, 'keyset');
    expect(published().signingKey.keyId).toBe('k-test');
    expect(b64url.decode(JSON.parse(utf8.decode(storage.public.get(DISCOVERY_PATH)!)).rootKey)).toEqual(p.rootKey);
  });
});

describe('AWS adapters', () => {
  it('signs with KMS as pure Ed25519 over the raw message', async () => {
    const kms = mockClient(KMSClient);
    kms.on(SignCommand).resolves({ Signature: new Uint8Array([1, 2, 3]) });
    const signer = kmsSigner({ keyId: 'k-2026-10', kmsKeyArn: 'arn:aws:kms:ap-northeast-1:1:key/x', status: 'active' }, new KMSClient({ region: 'ap-northeast-1' }));
    expect(await signer.sign(new Uint8Array([9]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(kms.commandCalls(SignCommand)[0]?.args[0].input).toMatchObject({
      KeyId: 'arn:aws:kms:ap-northeast-1:1:key/x',
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    });
    await expect(signer.sign(new Uint8Array(4097))).rejects.toThrow('4096');
    kms.restore();
  });

  it('records a publication only on top of the seq it read (DM-001 M-11)', async () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    ddb.on(TransactWriteCommand).resolves({});
    const dynamo = new DynamoStore('table', new DynamoDBClient({ region: 'ap-northeast-1' }));
    const record = {
      seq: 129, issuedAt: '', expiresAt: '', sha256: '', size: 1, keyId: 'k', archiveKey: 'published/129.json',
      trigger: 'daily' as const, channelCount: 0, revokedCount: 0, collectionCount: 0, revokedCollectionCount: 0,
    };
    await dynamo.recordPublication(128, record);
    const items = ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items[0]?.Put).toMatchObject({ ConditionExpression: 'seq = :prev', ExpressionAttributeValues: { ':prev': 128 } });
    expect(items[1]?.Put?.Item).toMatchObject({ PK: 'PUBLICATION', SK: 'SEQ#0000000129' });

    ddb.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: 'cancelled', $metadata: {} }));
    await expect(dynamo.recordPublication(128, record)).rejects.toBeInstanceOf(SeqConflictError);
    ddb.restore();
  });
});
