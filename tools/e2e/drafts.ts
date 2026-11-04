import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, utf8 } from '@yorisoi-console/protocol';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { ulid } from '../../api/src/console/util.js';
import { createKey, sha256 } from '../../web/src/publisher-crypto.js';

/**
 * Drafts on the dev environment, end to end (DES-014):
 *  1. a channel's draft is saved as a ZIP body (If-None-Match, then If-Match) and read back,
 *  2. its machine review runs in the DraftReview Lambda and passes; a draft naming another
 *     account fails with publisher_mismatch, and a draft without an icon warns icon_missing,
 *  3. a collection's draft with an outside audio file passes, its hash read over HTTPS,
 *  4. the owner's own returned submission is handed out from the intake bucket,
 *  5. the drafts are deleted with their files.
 * Then everything this run made is removed.
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
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const lambda = new LambdaClient({ region });
const s3 = new S3Client({ region });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const get = async (PK: string, SK: string) => (await db.send(new GetCommand({ TableName: table, Key: { PK, SK }, ConsistentRead: true }))).Item;
const step = (label: string, ...rest: unknown[]) => console.log(`\n== ${label}`, ...rest);

interface Res { status: number; headers: Record<string, string>; body: string; isBase64Encoded?: boolean }

/** Calls the console API's Lambda as API Gateway does, a ZIP body in base64. */
async function invoke(sub: string, method: string, path: string, options: { body?: unknown; zip?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Res> {
  const event = {
    rawPath: path,
    headers: { ...(options.zip ? { 'content-type': 'application/zip' } : {}), ...options.headers },
    body: options.zip ? Buffer.from(options.zip).toString('base64') : options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: !!options.zip,
    requestContext: { requestId: 'e2e-drafts', http: { method }, authorizer: { jwt: { claims: { sub, 'cognito:groups': '[publisher]' } } } },
  };
  const res = await lambda.send(new InvokeCommand({ FunctionName: consoleFn, Payload: utf8.encode(JSON.stringify(event)) }));
  const out = JSON.parse(utf8.decode(res.Payload!)) as { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded?: boolean };
  return { status: out.statusCode, headers: out.headers, body: out.body, ...(out.isBase64Encoded ? { isBase64Encoded: true } : {}) };
}
const json = (r: Res) => JSON.parse(r.body) as Record<string, unknown>;
function expectStatus(r: Res, status: number, what: string) {
  if (r.status !== status) throw new Error(`${what}: ${r.status} ${r.body}`);
}

const stamp = Date.now().toString(36);
const key = (await createKey('e2e-drafts-passphrase')).key;
const sub = `e2e-drafts-${stamp}`;
const publisherId = ulid();
const channelId = `e2e-dch-${stamp}`;
const collectionId = `e2e-dcol-${stamp}`;
const returnedSid = ulid();
const now = new Date().toISOString();
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const audio = utf8.encode(`OggS e2e draft narration ${stamp} `.repeat(200));
const audioKey = `e2e/${stamp}.ogg`;

const channelJson = (publisher: string) => ({
  format: 1, id: channelId, version: 1, publisher, name: '下書きの確認', summary: '画面で作ったチャンネル', lang: 'ja', activities: ['walk'], genres: [], greeting: '確認です。',
  talk: { level: 'quiet', events: { spot: true, revisit: false, milestone: false, rest: false, start: true, finish: true } },
  spots: { prefer: ['shrine'], skip: [] }, guide: { length: 'short' }, mood: { tone: false, sound: 'auto' },
  resources: [{ id: 'intro', type: 'text', file: 'resources/text/intro.md' }],
  cues: [{ id: 'hachimangu', trigger: { type: 'spot', osm: 'way/123456', name: '鶴岡八幡宮' }, present: [{ as: 'speak', resource: 'intro' }] }],
});
/** A draft as the screen packs it (DES-014 R-3). */
const channelDraft = (publisher: string, icon = true) => zipSync({
  'package/channel.json': strToU8(JSON.stringify(channelJson(publisher), null, 2)),
  'package/prompts/guide/focus.md': strToU8('- 由来と、関わった人物を中心に話す\n'),
  'package/resources/text/intro.md': strToU8('鶴岡八幡宮の由来の話です。\n'),
  'draft.json': strToU8(JSON.stringify({ description: '通しの確認' })),
  ...(icon ? { 'icon.png': png } : {}),
});
const collectionDraft = async () => zipSync({
  'package/collection.json': strToU8(JSON.stringify({
    format: 1, id: collectionId, version: 1, producer: key.accountId, name: '下書きの素材集', summary: '外部の音声つき', lang: 'ja', grants: { publishers: '*' },
    resources: [
      { id: 'intro', type: 'text', file: 'resources/text/intro.md', tags: ['history'], about: { type: 'spot', osm: 'way/123456', name: '鶴岡八幡宮', lat: 35.326, lon: 139.5565 } },
      {
        id: 'narration', type: 'audio', url: `${providerUrl}/${audioKey}`, sha256: hex(await sha256(audio)), size: audio.length, durationSec: 30, mime: 'audio/ogg',
        transcript: 'intro', credit: { author: '通しの確認', license: 'permission' },
      },
    ],
  })),
  'package/resources/text/intro.md': strToU8('鶴岡八幡宮の話です。\n'),
  'draft.json': strToU8('{}'),
});

const seeded = [
  { PK: `USER#${sub}`, SK: 'USER', type: 'user', publisherId },
  {
    PK: `PUB#${publisherId}`, SK: 'PUB', type: 'publisher', publisherId, displayName: '下書きの確認', status: 'active', roles: ['publisher', 'producer'],
    activeAccountId: key.accountId, channelCount: 1, collectionCount: 1, rev: 2, createdAt: now, updatedAt: now,
  },
  { PK: `PUB#${publisherId}`, SK: `KEY#${key.accountId}`, type: 'publisher-key', accountId: key.accountId, publicKey: b64url.encode(key.publicKey), status: 'active', boundAt: now },
  { PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId, status: 'active', rev: 1, createdAt: now, updatedAt: now, GSI1PK: `PUB#${publisherId}`, GSI1SK: `CH#${channelId}` },
  {
    PK: `COL#${collectionId}`, SK: 'COL', type: 'collection', kind: 'collection', collectionId, publisherId, status: 'active', rev: 1, createdAt: now, updatedAt: now,
    GSI1PK: `PUB#${publisherId}`, GSI1SK: `COL#${collectionId}`,
  },
  {
    PK: `CH#${channelId}`, SK: `SUB#${returnedSid}`, type: 'submission', submissionId: returnedSid, channelId, publisherId, accountId: key.accountId, state: 'returned', version: 1,
    intakeKey: `intake/${channelId}/${returnedSid}.zip`, iconIntakeKey: `intake/${channelId}/${returnedSid}.png`, rev: 3, createdAt: now, updatedAt: now,
  },
];
const archived = [`archive/${channelId}/${returnedSid}.zip`, `archive/${channelId}/${returnedSid}.png`];

/** Starts the draft's machine review and waits for its result (R-18). */
async function checked(path: string, pk: string, rev: number, ms = 300_000) {
  const started = Date.now();
  const r = await invoke(sub, 'POST', `${path}/draft/check`, { headers: { 'if-match': `"${rev}"` } });
  expectStatus(r, 202, 'check');
  for (; Date.now() - started < ms; await sleep(3000)) {
    const check = (await get(pk, 'DRAFT'))?.check as { state: string; validation?: { ok: boolean; errors: { code: string }[]; warnings?: { code: string }[] } } | undefined;
    if (check?.state === 'done') {
      console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s:`, JSON.stringify(check.validation));
      return check.validation!;
    }
  }
  throw new Error('timed out waiting for the draft check');
}

try {
  for (const Item of seeded) await db.send(new PutCommand({ TableName: table, Item }));
  await s3.send(new PutObjectCommand({ Bucket: publicBucket, Key: audioKey, Body: audio, ContentType: 'audio/ogg', CacheControl: 'no-store' }));
  for (const k of archived) await s3.send(new PutObjectCommand({ Bucket: intakeBucket, Key: k, Body: k.endsWith('.png') ? png : zipSync({ 'channel.json': strToU8(JSON.stringify(channelJson(key.accountId))) }) }));
  const ch = `/api/channels/${channelId}`;
  const col = `/api/collections/${collectionId}`;

  step('1. save and read a channel draft');
  expectStatus(await invoke(sub, 'PUT', `${ch}/draft`, { zip: channelDraft(key.accountId) }), 428, 'save without a condition');
  let saved = await invoke(sub, 'PUT', `${ch}/draft`, { zip: channelDraft(key.accountId), headers: { 'if-none-match': '*' } });
  expectStatus(saved, 200, 'first save');
  console.log('saved:', saved.body, 'etag', saved.headers.etag);
  const read = await invoke(sub, 'GET', `${ch}/draft`);
  expectStatus(read, 200, 'read');
  const back = unzipSync(Buffer.from(read.body, 'base64'));
  console.log('read back:', read.headers['content-type'], Object.keys(back).sort().join(' '));
  if (!read.isBase64Encoded || !back['package/channel.json']) throw new Error('the draft did not come back');
  expectStatus(await invoke(sub, 'PUT', `${ch}/draft`, { zip: channelDraft(key.accountId), headers: { 'if-match': '"9"' } }), 412, 'stale save');
  console.log('channel view draft:', JSON.stringify(json(await invoke(sub, 'GET', ch)).draft));

  step('2. the machine review of the channel draft');
  let v = await checked(ch, `CH#${channelId}`, 1);
  if (!v.ok) throw new Error('the good draft did not pass');
  saved = await invoke(sub, 'PUT', `${ch}/draft`, { zip: channelDraft('sg1' + 'a'.repeat(32), false), headers: { 'if-match': '"1"' } });
  expectStatus(saved, 200, 'second save');
  v = await checked(ch, `CH#${channelId}`, 2);
  if (v.ok || !v.errors.some((e) => e.code === 'publisher_mismatch') || !v.warnings?.some((w) => w.code === 'icon_missing')) throw new Error('the bad draft was not found out');

  step('3. a collection draft with an outside audio file');
  expectStatus(await invoke(sub, 'PUT', `${col}/draft`, { zip: await collectionDraft(), headers: { 'if-none-match': '*' } }), 200, 'collection save');
  v = await checked(col, `COL#${collectionId}`, 1);
  if (!v.ok) throw new Error('the collection draft did not pass');

  step('4. the owner’s own returned submission');
  const pkg = json(await invoke(sub, 'GET', `${ch}/submissions/${returnedSid}/package`));
  console.log('urls:', Object.keys(pkg).join(' '));
  const zip = new Uint8Array(await (await fetch(String(pkg.packageUrl))).arrayBuffer());
  console.log('package from the presigned URL:', Object.keys(unzipSync(zip)).join(' '));
  const cors = await fetch(String(pkg.packageUrl), { headers: { Origin: 'https://d32w19p7au8cu2.cloudfront.net' } });
  console.log('CORS for the console:', cors.headers.get('access-control-allow-origin'));

  step('5. delete the drafts');
  for (const [path, pk] of [[ch, `CH#${channelId}`], [col, `COL#${collectionId}`]] as const) {
    const draft = await get(pk, 'DRAFT');
    expectStatus(await invoke(sub, 'DELETE', `${path}/draft`, { headers: { 'if-match': `"${String(draft!.rev)}"` } }), 204, 'delete');
  }
  console.log('drafts left:', await get(`CH#${channelId}`, 'DRAFT'), await get(`COL#${collectionId}`, 'DRAFT'));
  console.log('\nall good');
} finally {
  step('cleanup');
  for (const pk of [`CH#${channelId}`, `COL#${collectionId}`]) {
    const draft = await get(pk, 'DRAFT');
    if (draft) await s3.send(new DeleteObjectCommand({ Bucket: intakeBucket, Key: String(draft.key) }));
    await db.send(new DeleteCommand({ TableName: table, Key: { PK: pk, SK: 'DRAFT' } }));
  }
  for (const { PK, SK } of seeded) await db.send(new DeleteCommand({ TableName: table, Key: { PK, SK } }));
  await db.send(new DeleteCommand({ TableName: table, Key: { PK: `PUB#${publisherId}`, SK: `QUOTA#${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date())}` } }));
  await s3.send(new DeleteObjectCommand({ Bucket: publicBucket, Key: audioKey }));
  for (const k of archived) await s3.send(new DeleteObjectCommand({ Bucket: intakeBucket, Key: k }));
  console.log('removed');
}
