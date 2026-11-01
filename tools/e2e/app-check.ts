import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, utf8 } from '@yorisoi-console/protocol';
import { zipSync } from 'fflate';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '../../api/src/console/util.js';
import { createKey, sha256, sign, signPackage, type PublisherKey } from '../../web/src/publisher-crypto.js';

/**
 * Lists, on the dev environment, what SanpoGuide needs to show platform ADR-004 on the emulator: a
 * collection that lets the AI take its text as grounds (`grants.grounding`, API-MATERIALS I-13) about the
 * area of Tsurugaoka Hachimangu in Kamakura, and a walking channel that uses it. On the emulator,
 * set the location there (35.3258, 139.5564), add the dev list, choose the channel: the cost
 * dialog, the report link (to the list's `contact`) and, with an AI key, the credit line
 * 「…の資料をもとに作成」 under a spot's narration.
 *
 * `--cycle` lists a cycling channel instead, for CycleGuide (requirements F-32, AC-31・AC-32): the
 * same point cue, of which the app reads out only the AI's narration on the collection's grounds
 * (the card is never made), and a spot cue on 鎌倉聖ミカエル教会聖堂 that reads the channel's own text,
 * too long for riding, so it waits for a stop. Ride from Kamakura station towards the shrine.
 *
 * `--cleanup` removes them and rebuilds the list (with `--cycle` for the cycling one).
 */
const region = 'ap-northeast-1';
const stack = 'YorisoiConsole-dev';
const cycle = process.argv.includes('--cycle');
const stateFile = join(tmpdir(), cycle ? 'sanpo-e2e-app-check-cycle.json' : 'sanpo-e2e-app-check.json');
const cfn = new CloudFormationClient({ region });
const outputs = new Map(((await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
const resources = (await cfn.send(new DescribeStackResourcesCommand({ StackName: stack }))).StackResources ?? [];
const consoleFn = resources.find((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.startsWith('ConsoleConsoleApi'))!.PhysicalResourceId!;
const table = outputs.get('TableName')!;
const intakeBucket = outputs.get('IntakeBucketName')!;
const providerUrl = outputs.get('ProviderUrl')!;
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
    requestContext: { requestId: 'e2e-app-check', http: { method }, authorizer: { jwt: { claims: { sub, 'cognito:groups': groups } } } },
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

async function listBody(): Promise<{ channels: Record<string, unknown>[]; collections?: Record<string, unknown>[] }> {
  const doc = await (await fetch(`${providerUrl}/v1/channels.json?${Date.now()}`)).json();
  return JSON.parse(utf8.decode(b64url.decode(doc.payload)));
}

interface State { operatorSub: string; partitions: string[] }

async function cleanup(state: State) {
  for (const pk of state.partitions) {
    const rest = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': pk } }));
    for (const item of rest.Items ?? []) await db.send(new DeleteCommand({ TableName: table, Key: { PK: item.PK, SK: item.SK } }));
  }
  await invoke(state.operatorSub, '[operator]', 'POST', '/api/admin/publications', { body: { reason: 'アプリの確認の後片付け' } }).catch((e) => console.error(e));
  rmSync(stateFile, { force: true });
  console.log('cleaned up; the list is being rebuilt without them');
}

if (process.argv.includes('--cleanup')) {
  await cleanup(JSON.parse(readFileSync(stateFile, 'utf8')) as State);
  process.exit(0);
}

const stamp = Date.now().toString(36);
const producer = (await createKey('e2e-app-check-producer')).key;
const publisher = (await createKey('e2e-app-check-publisher')).key;
const producerSub = `e2e-producer-${stamp}`;
const publisherSub = `e2e-publisher-${stamp}`;
const operatorSub = `e2e-operator-${stamp}`;
const producerId = ulid();
const publisherId = ulid();
const collectionId = `e2e-grounds-${stamp}`;
const channelId = `e2e-grounded-${stamp}`;
const colSid = ulid();
const chSid = ulid();
const now = new Date().toISOString();

const collectionJson = {
  format: 1, id: collectionId, version: 1, producer: producer.accountId, name: '鶴岡八幡宮の付近の資料（確認用）', summary: 'AI の根拠の確認用', lang: 'ja',
  grants: { publishers: '*', grounding: true },
  resources: [
    {
      id: 'area', type: 'text', file: 'resources/text/area.md', tags: ['history'],
      about: { type: 'point', lat: 35.3258, lon: 139.5564, radiusM: 300 },
      credit: { author: '確認用の資料の会', license: 'permission' },
    },
  ],
};
const areaText = '鶴岡八幡宮は、源頼義が由比ヶ浜の近くに祀った社を、源頼朝が今の場所に移したのが始まりとされます。本宮へ上る大石段の脇には、大銀杏が倒れたあとに若木が育っています。\n';
const collectionZip = await signCollection(
  { 'collection.json': enc.encode(JSON.stringify(collectionJson)), 'resources/text/area.md': enc.encode(areaText) },
  producer, collectionId, 1,
);
const channelJson = {
  format: 1, activities: [cycle ? 'cycle' : 'walk'], id: channelId, version: 1, publisher: publisher.accountId, name: cycle ? '資料で話す（自転車・確認用）' : '資料で話す（確認用）', summary: '素材集の資料を根拠に解説する', lang: 'ja', greeting: '資料をもとにご案内します。',
  talk: { level: 'chatty', events: { spot: true, revisit: false, milestone: false, rest: false, start: true, finish: true } },
  spots: { prefer: ['shrine', 'temple'], skip: [] }, guide: { length: 'short' }, mood: { tone: false, sound: 'auto' },
  collections: [{ as: 'kamakura', id: collectionId, minVersion: 1 }],
  // Entering the area: the AI narrates on the collection's grounds, and the text itself is shown on a card.
  cues: [
    {
      id: 'area', trigger: { type: 'point', lat: 35.3258, lon: 139.5564, radiusM: 300 }, repeat: 'oncePerWalk',
      present: [{ as: 'speak', source: ['builtin:ai-guide', 'builtin:fallback-text'] }, { as: 'card', source: ['kamakura#area'] }],
    },
    ...(cycle ? [{
      id: 'michael', trigger: { type: 'spot', osm: 'way/191362910', name: '鎌倉聖ミカエル教会聖堂' }, repeat: 'oncePerWalk',
      present: [{ as: 'speak', source: ['self#michael'] }],
    }] : []),
  ],
  ...(cycle ? { resources: [{ id: 'michael', type: 'text', file: 'resources/text/michael.md' }] } : {}),
};
/** Longer than riding allows in pottering (75 characters): read out at the next stop. */
const michaelText = 'こちらはチャンネルの文です。鎌倉聖ミカエル教会聖堂は、鎌倉市の景観重要建築物等に選ばれている教会です。走行中には長すぎるので、止まったときに読まれるかを確かめるため、少し長めに書いています。\n';
const channelFiles: Record<string, Uint8Array> = { 'channel.json': enc.encode(JSON.stringify(channelJson)) };
if (cycle) channelFiles['resources/text/michael.md'] = enc.encode(michaelText);
const channelZip = (await signPackage(zipSync(channelFiles), publisher, { channel: channelId })).zip;
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const seeded = [
  { PK: `USER#${producerSub}`, SK: 'USER', type: 'user', publisherId: producerId },
  { PK: `PUB#${producerId}`, SK: 'PUB', type: 'publisher', publisherId: producerId, displayName: '確認用の資料の会', status: 'active', roles: ['publisher', 'producer'], activeAccountId: producer.accountId, channelCount: 0, collectionCount: 1, rev: 2, createdAt: now, updatedAt: now },
  { PK: `PUB#${producerId}`, SK: `KEY#${producer.accountId}`, type: 'publisher-key', accountId: producer.accountId, status: 'active', boundAt: now },
  { PK: `COL#${collectionId}`, SK: 'COL', type: 'collection', kind: 'collection', collectionId, publisherId: producerId, status: 'active', rev: 1, pendingSubmissionId: colSid, createdAt: now, updatedAt: now, GSI1PK: `PUB#${producerId}`, GSI1SK: `COL#${collectionId}` },
  { PK: `COL#${collectionId}`, SK: `SUB#${colSid}`, type: 'submission', kind: 'collection', submissionId: colSid, collectionId, publisherId: producerId, accountId: producer.accountId, state: 'uploading', intakeKey: `intake-col/${collectionId}/${colSid}.zip`, rev: 1, createdAt: now, updatedAt: now },
  { PK: `USER#${publisherSub}`, SK: 'USER', type: 'user', publisherId },
  { PK: `PUB#${publisherId}`, SK: 'PUB', type: 'publisher', roles: ['publisher'], publisherId, displayName: '確認用のチャンネル提供者', status: 'active', activeAccountId: publisher.accountId, channelCount: 1, rev: 2, createdAt: now, updatedAt: now },
  { PK: `PUB#${publisherId}`, SK: `KEY#${publisher.accountId}`, type: 'publisher-key', accountId: publisher.accountId, status: 'active', boundAt: now },
  { PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId, status: 'active', rev: 1, pendingSubmissionId: chSid, createdAt: now, updatedAt: now, GSI1PK: `PUB#${publisherId}`, GSI1SK: `CH#${channelId}` },
  { PK: `CH#${channelId}`, SK: `SUB#${chSid}`, type: 'submission', submissionId: chSid, channelId, publisherId, accountId: publisher.accountId, state: 'uploading', intakeKey: `intake/${channelId}/${chSid}.zip`, iconIntakeKey: `intake/${channelId}/${chSid}.png`, rev: 1, createdAt: now, updatedAt: now },
];
const state: State = {
  operatorSub,
  partitions: [`COL#${collectionId}`, `CH#${channelId}`, `PUB#${producerId}`, `PUB#${publisherId}`, `USER#${producerSub}`, `USER#${publisherSub}`],
};

let ok = false;
try {
  writeFileSync(stateFile, JSON.stringify(state));
  for (const Item of seeded) await db.send(new PutCommand({ TableName: table, Item }));

  // 1. The collection: machine review, approval, listed with grants.grounding.
  await s3.send(new PutObjectCommand({ Bucket: intakeBucket, Key: `intake-col/${collectionId}/${colSid}.zip`, Body: collectionZip, ContentType: 'application/zip' }));
  const colSub = await waitFor('the collection review', async () => {
    const s = await get(`COL#${collectionId}`, `SUB#${colSid}`);
    return s && s.state !== 'uploading' ? s : undefined;
  });
  if (colSub.state !== 'awaiting_review') throw new Error(`the collection did not pass: ${JSON.stringify(colSub.validation)}`);
  const colStarted = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/collections/${collectionId}/submissions/${colSid}/start`, { ifMatch: Number(colSub.rev) });
  await invoke(operatorSub, '[operator]', 'POST', `/api/admin/collections/${collectionId}/submissions/${colSid}/approve`, {
    body: { verification: { method: 'アプリの確認', detail: '開発用の環境での確認' } }, ifMatch: colStarted.rev,
  });
  const listedCol = await waitFor('the collection on the list', async () => (await listBody()).collections?.find((c) => c.id === collectionId));
  console.log('collection listed, grants:', JSON.stringify(listedCol.grants));

  // 2. The channel that uses it, approved with placeholder samples (no AI is called here).
  await s3.send(new PutObjectCommand({ Bucket: intakeBucket, Key: `intake/${channelId}/${chSid}.zip`, Body: channelZip, ContentType: 'application/zip' }));
  await s3.send(new PutObjectCommand({ Bucket: intakeBucket, Key: `intake/${channelId}/${chSid}.png`, Body: png, ContentType: 'image/png' }));
  const chSub = await waitFor('the channel review', async () => {
    const s = await get(`CH#${channelId}`, `SUB#${chSid}`);
    return s && s.state !== 'uploading' ? s : undefined;
  });
  if (chSub.state !== 'awaiting_review') throw new Error(`the channel did not pass: ${JSON.stringify(chSub.validation)}`);
  const prompts = await invoke(operatorSub, '[operator]', 'GET', `/api/admin/channels/${channelId}/submissions/${chSid}/sample-prompts`);
  const saved = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${channelId}/submissions/${chSid}/samples`, {
    body: { service: 'e2e', model: 'none', items: prompts.scenarios.map((x: { id: string }) => ({ scenarioId: x.id, output: '（アプリの確認のため AI は呼ばない）' })) },
  });
  const chStarted = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${channelId}/submissions/${chSid}/start`, { ifMatch: Number(chSub.rev) });
  await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${channelId}/submissions/${chSid}/approve`, {
    body: { samplesIds: [saved.samplesId], message: 'アプリの確認' }, ifMatch: chStarted.rev,
  });
  await waitFor('the channel on the list', async () => (await listBody()).channels.find((c) => c.id === channelId));
  const discovery = await (await fetch(`${providerUrl}/.well-known/sanpo-channels`)).json();
  console.log(`listed ${channelId} using ${collectionId}`);
  console.log(`list: ${providerUrl} (${discovery.provider}), contact ${discovery.contact}`);
  console.log('remove with --cleanup');
  ok = true;
} catch (e) {
  console.error(e);
} finally {
  if (!ok) await cleanup(state);
}
process.exit(ok ? 0 : 1);
