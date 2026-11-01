import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, utf8 } from '@yorisoi-console/protocol';
import { zipSync } from 'fflate';
import { ulid } from '../../api/src/console/util.js';
import { checkProvider } from '../../conformance/src/check.js';
import { createKey, sha256, sign, signPackage, type PublisherKey } from '../../web/src/publisher-crypto.js';

/**
 * Collections on the dev environment, end to end (DES-007〜DES-009, 4a〜4c):
 *  1. a producer's collection with an outside audio file passes the machine review (hash read over HTTPS),
 *  2. the operator approves it with the identity check, and it is listed under collections[],
 *  3. a publisher's channel that plays it passes the machine review (resolved against the listed collection),
 *  4. the operator approves the channel: the record of use is written, and the list adds up media and resourcesSize,
 *  5. the conformance checks pass (V-19〜V-25),
 *  6. the daily check finds the outside file, then reports it once it is gone.
 * Then everything this run made is removed and the list rebuilt.
 */
const region = 'ap-northeast-1';
const stack = 'YorisoiConsole-dev';
const cfn = new CloudFormationClient({ region });
const outputs = new Map(((await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
const resources = (await cfn.send(new DescribeStackResourcesCommand({ StackName: stack }))).StackResources ?? [];
const consoleFn = resources.find((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.startsWith('ConsoleConsoleApi'))!.PhysicalResourceId!;
const publicBucket = resources.find((r) => r.ResourceType === 'AWS::S3::Bucket' && r.LogicalResourceId?.startsWith('PublicBucket'))!.PhysicalResourceId!;
const table = outputs.get('TableName')!;
const intakeBucket = outputs.get('IntakeBucketName')!;
const providerUrl = outputs.get('ProviderUrl')!;
const publishFn = outputs.get('PublishFunctionName')!;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const lambda = new LambdaClient({ region });
const s3 = new S3Client({ region });
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

async function invoke(sub: string, groups: string, method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) {
  const event = {
    rawPath: path,
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    requestContext: { requestId: 'e2e-collections', http: { method }, authorizer: { jwt: { claims: { sub, 'cognito:groups': groups } } } },
  };
  const res = await lambda.send(new InvokeCommand({ FunctionName: consoleFn, Payload: utf8.encode(JSON.stringify(event)) }));
  const out = JSON.parse(utf8.decode(res.Payload!));
  const body = out.body ? JSON.parse(out.body) : undefined;
  if (out.statusCode >= 400) throw new Error(`${method} ${path}: ${out.statusCode} ${out.body}`);
  return body;
}

/** A collection package signed as a producer signs it (API-MATERIALS `collection-package`). */
async function signCollection(files: Record<string, Uint8Array>, key: PublisherKey, id: string, version: number): Promise<Uint8Array> {
  const hashes: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) hashes[name] = hex(await sha256(files[name]!));
  const payload = enc.encode(JSON.stringify({ type: 'collection-package', collection: id, version, producer: key.accountId, files: hashes }));
  const signature = enc.encode(JSON.stringify({ payload: b64url.encode(payload), publisherKey: b64url.encode(key.publicKey), sig: b64url.encode(await sign(key, payload)) }));
  return zipSync({ ...files, 'signature.json': signature });
}

async function waitFor<T>(what: string, read: () => Promise<T | undefined>, ms = 180_000): Promise<T> {
  for (let t = Date.now(); Date.now() - t < ms; await sleep(3000)) {
    const v = await read();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const get = async (PK: string, SK: string) => (await db.send(new GetCommand({ TableName: table, Key: { PK, SK }, ConsistentRead: true }))).Item;

async function listBody(): Promise<{ channels: Record<string, unknown>[]; collections?: Record<string, unknown>[]; revokedCollections?: unknown[] }> {
  const doc = await (await fetch(`${providerUrl}/v1/channels.json?${Date.now()}`)).json();
  return JSON.parse(utf8.decode(b64url.decode(doc.payload)));
}

const stamp = Date.now().toString(36);
const producer = (await createKey('e2e-producer-passphrase')).key;
const publisher = (await createKey('e2e-publisher-passphrase')).key;
const producerSub = `e2e-producer-${stamp}`;
const publisherSub = `e2e-publisher-${stamp}`;
const operatorSub = `e2e-operator-${stamp}`;
const producerId = ulid();
const publisherId = ulid();
const collectionId = `e2e-col-${stamp}`;
const channelId = `e2e-ch-${stamp}`;
const colSid = ulid();
const chSid = ulid();
const now = new Date().toISOString();

// The outside file: served by the dev provider's own CloudFront, so it is public HTTPS.
const audio = enc.encode(`OggS e2e narration ${stamp} `.repeat(200));
const audioKey = `e2e/${stamp}.ogg`;
const audioUrl = `${providerUrl}/${audioKey}`;

const collectionJson = {
  format: 1, id: collectionId, version: 1, producer: producer.accountId, name: '通しの確認の素材集', summary: '外部の音声つき', lang: 'ja',
  grants: { publishers: '*' },
  resources: [
    { id: 'intro', type: 'text', file: 'resources/text/intro.md', tags: ['history'], about: { type: 'spot', osm: 'way/123456', name: '鶴岡八幡宮', lat: 35.326, lon: 139.5565 } },
    {
      id: 'narration', type: 'audio', url: audioUrl, sha256: hex(await sha256(audio)), size: audio.length, durationSec: 30, mime: 'audio/ogg', transcript: 'intro',
      credit: { author: '通しの確認', license: 'permission' }, tags: ['history'],
    },
  ],
};
const collectionZip = await signCollection(
  { 'collection.json': enc.encode(JSON.stringify(collectionJson)), 'resources/text/intro.md': enc.encode('鶴岡八幡宮の話です。\n') },
  producer, collectionId, 1,
);
const channelJson = {
  format: 1, activities: ['walk'], id: channelId, version: 1, publisher: publisher.accountId, name: '素材集を使う', summary: '素材集の音声を流す', lang: 'ja', greeting: '確認です。',
  talk: { level: 'quiet', events: { spot: true, revisit: false, milestone: false, rest: false, start: true, finish: true } },
  spots: { prefer: ['shrine'], skip: [] }, guide: { length: 'short' }, mood: { tone: false, sound: 'auto' },
  collections: [{ as: 'kamakura', id: collectionId, minVersion: 1 }],
  cues: [{ id: 'hachimangu', trigger: { type: 'spot', osm: 'way/123456' }, present: [{ as: 'play', source: ['kamakura#narration'] }] }],
};
const channelZip = (await signPackage(zipSync({ 'channel.json': enc.encode(JSON.stringify(channelJson)) }), publisher, { channel: channelId })).zip;
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const seeded = [
  { PK: `USER#${producerSub}`, SK: 'USER', type: 'user', publisherId: producerId },
  { PK: `PUB#${producerId}`, SK: 'PUB', type: 'publisher', publisherId: producerId, displayName: '通しの確認の制作元', status: 'active', roles: ['publisher', 'producer'], activeAccountId: producer.accountId, channelCount: 0, collectionCount: 1, rev: 2, createdAt: now, updatedAt: now },
  { PK: `PUB#${producerId}`, SK: `KEY#${producer.accountId}`, type: 'publisher-key', accountId: producer.accountId, status: 'active', boundAt: now },
  { PK: `COL#${collectionId}`, SK: 'COL', type: 'collection', kind: 'collection', collectionId, publisherId: producerId, status: 'active', rev: 1, pendingSubmissionId: colSid, createdAt: now, updatedAt: now, GSI1PK: `PUB#${producerId}`, GSI1SK: `COL#${collectionId}` },
  { PK: `COL#${collectionId}`, SK: `SUB#${colSid}`, type: 'submission', kind: 'collection', submissionId: colSid, collectionId, publisherId: producerId, accountId: producer.accountId, state: 'uploading', intakeKey: `intake-col/${collectionId}/${colSid}.zip`, rev: 1, createdAt: now, updatedAt: now },
  { PK: `USER#${publisherSub}`, SK: 'USER', type: 'user', publisherId },
  { PK: `PUB#${publisherId}`, SK: 'PUB', type: 'publisher', roles: ['publisher'], publisherId, displayName: '通しの確認の配信元', status: 'active', activeAccountId: publisher.accountId, channelCount: 1, rev: 2, createdAt: now, updatedAt: now },
  { PK: `PUB#${publisherId}`, SK: `KEY#${publisher.accountId}`, type: 'publisher-key', accountId: publisher.accountId, status: 'active', boundAt: now },
  { PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId, status: 'active', rev: 1, pendingSubmissionId: chSid, createdAt: now, updatedAt: now, GSI1PK: `PUB#${publisherId}`, GSI1SK: `CH#${channelId}` },
  { PK: `CH#${channelId}`, SK: `SUB#${chSid}`, type: 'submission', submissionId: chSid, channelId, publisherId, accountId: publisher.accountId, state: 'uploading', intakeKey: `intake/${channelId}/${chSid}.zip`, iconIntakeKey: `intake/${channelId}/${chSid}.png`, rev: 1, createdAt: now, updatedAt: now },
];

const step = (label: string, ...rest: unknown[]) => console.log(`\n== ${label}`, ...rest);

try {
  for (const Item of seeded) await db.send(new PutCommand({ TableName: table, Item }));
  await s3.send(new PutObjectCommand({ Bucket: publicBucket, Key: audioKey, Body: audio, ContentType: 'audio/ogg', CacheControl: 'no-store' }));

  // 1. The collection's machine review, reading the outside file.
  step('1. collection machine review');
  let started = Date.now();
  await s3.send(new PutObjectCommand({ Bucket: intakeBucket, Key: `intake-col/${collectionId}/${colSid}.zip`, Body: collectionZip, ContentType: 'application/zip' }));
  const colSub = await waitFor('the collection review', async () => {
    const s = await get(`COL#${collectionId}`, `SUB#${colSid}`);
    return s && s.state !== 'uploading' ? s : undefined;
  });
  console.log(`state=${colSub.state} in ${((Date.now() - started) / 1000).toFixed(1)}s`, JSON.stringify(colSub.validation));
  if (colSub.state !== 'awaiting_review') throw new Error('the collection did not pass');
  console.log('listing:', JSON.stringify(colSub.listing));

  // 2. Approval with the identity check, then listed.
  step('2. collection approval');
  const colStarted = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/collections/${collectionId}/submissions/${colSid}/start`, { ifMatch: Number(colSub.rev) });
  const colApproved = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/collections/${collectionId}/submissions/${colSid}/approve`, {
    body: { verification: { method: '通しの確認', detail: '開発用の環境での確認' } }, ifMatch: colStarted.rev,
  });
  console.log('approved:', colApproved.submission.state);
  const listedCol = await waitFor('the collection on the list', async () => (await listBody()).collections?.find((c) => c.id === collectionId));
  console.log('collections[] entry:', JSON.stringify(listedCol));
  const colPkg = await fetch(String((listedCol.package as { url: string }).url));
  console.log('col/ package:', colPkg.status, (await colPkg.arrayBuffer()).byteLength, 'bytes');

  // 3. The channel that plays it: its machine review resolves the listed collection.
  step('3. channel machine review');
  started = Date.now();
  await s3.send(new PutObjectCommand({ Bucket: intakeBucket, Key: `intake/${channelId}/${chSid}.zip`, Body: channelZip, ContentType: 'application/zip' }));
  await s3.send(new PutObjectCommand({ Bucket: intakeBucket, Key: `intake/${channelId}/${chSid}.png`, Body: png, ContentType: 'image/png' }));
  const chSub = await waitFor('the channel review', async () => {
    const s = await get(`CH#${channelId}`, `SUB#${chSid}`);
    return s && s.state !== 'uploading' ? s : undefined;
  });
  console.log(`state=${chSub.state} in ${((Date.now() - started) / 1000).toFixed(1)}s`, JSON.stringify(chSub.validation));
  if (chSub.state !== 'awaiting_review') throw new Error('the channel did not pass');
  console.log('listing:', JSON.stringify(chSub.listing));

  // 4. Approval: the record of use, and the list's sums.
  step('4. channel approval');
  const chStarted = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${channelId}/submissions/${chSid}/start`, { ifMatch: Number(chSub.rev) });
  const chApproved = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${channelId}/submissions/${chSid}/approve`, { body: {}, ifMatch: chStarted.rev });
  console.log('approved:', chApproved.submission.state);
  console.log('record of use:', JSON.stringify(await get(`COL#${collectionId}`, `USEDBY#${channelId}`)));
  console.log('used-by (producer):', JSON.stringify(await invoke(producerSub, '[publisher]', 'GET', `/api/collections/${collectionId}/used-by`)));
  const listedCh = await waitFor('the channel on the list', async () => (await listBody()).channels.find((c) => c.id === channelId));
  console.log('channels[] entry:', JSON.stringify(listedCh));

  // 5. Conformance, now with a collection and a channel using it.
  step('5. conformance');
  const discovery = await (await fetch(`${providerUrl}/.well-known/sanpo-channels`)).json();
  for (const r of await checkProvider(providerUrl, { expectedProvider: discovery.provider })) console.log(`  ${r.status.toUpperCase().padEnd(4)} ${r.id} ${r.detail}`);

  // 6. The daily check: fine while the file is there, a failure once it is gone.
  step('6. daily outside-resource check');
  const daily = async () => {
    await lambda.send(new InvokeCommand({ FunctionName: publishFn, Payload: utf8.encode(JSON.stringify({ trigger: 'daily' })) }));
    return (await get(`COL#${collectionId}`, 'COL'))?.externalCheck;
  };
  console.log('with the file:', JSON.stringify(await daily()));
  await s3.send(new DeleteObjectCommand({ Bucket: publicBucket, Key: audioKey }));
  console.log('without the file:', JSON.stringify(await daily()));
} finally {
  step('cleanup');
  await s3.send(new DeleteObjectCommand({ Bucket: publicBucket, Key: audioKey })).catch(() => undefined);
  for (const pk of [`COL#${collectionId}`, `CH#${channelId}`, `PUB#${producerId}`, `PUB#${publisherId}`]) {
    const rest = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': pk } }));
    for (const item of rest.Items ?? []) await db.send(new DeleteCommand({ TableName: table, Key: { PK: item.PK, SK: item.SK } }));
  }
  for (const item of seeded) await db.send(new DeleteCommand({ TableName: table, Key: { PK: item.PK, SK: item.SK } }));
  await invoke(operatorSub, '[operator]', 'POST', '/api/admin/publications', { body: { reason: '通しの確認の後片付け' } }).catch((e) => console.error(e));
  console.log('cleaned up; the list is being rebuilt without', collectionId, 'and', channelId);
}
