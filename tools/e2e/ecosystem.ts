import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { utf8 } from '@yorisoi-console/protocol';
import { zipSync } from 'fflate';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '../../api/src/console/util.js';
import { checkProvider } from '../../conformance/src/check.js';
import { createKey, signPackage } from '../../web/src/publisher-crypto.js';

/**
 * DES-011 on the dev environment: three channels, for walking only, for walking and cycling, and
 * for cycling only, pass the machine review with the samples of each activity's representative app
 * (SanpoGuide's for walking, CycleGuide's `ride-` ones for cycling; N-8, CycleGuide AC-23) and are
 * approved and listed. The list must carry their activities, genres, requires and `minAppVersions`
 * (API-CHANNEL-LIST P-19・P-20). Then the conformance checks (V-27, V-29).
 *
 * `--keep` leaves them listed so the apps (the emulator) can be checked to offer only theirs
 * (CycleGuide AC-9: not the walking one); `--cleanup` removes them afterwards.
 */
const region = 'ap-northeast-1';
const stack = 'YorisoiConsole-dev';
const stateFile = join(tmpdir(), 'sanpo-e2e-ecosystem.json');
const cfn = new CloudFormationClient({ region });
const outputs = new Map(((await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
const resources = (await cfn.send(new DescribeStackResourcesCommand({ StackName: stack }))).StackResources ?? [];
const consoleFn = resources.find((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.startsWith('ConsoleConsoleApi'))!.PhysicalResourceId!;
const table = outputs.get('TableName')!;
const bucket = outputs.get('IntakeBucketName')!;
const providerUrl = outputs.get('ProviderUrl')!;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const lambda = new LambdaClient({ region });
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function invoke(sub: string, groups: string, method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) {
  const event = {
    rawPath: path,
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    requestContext: { requestId: 'e2e-ecosystem', http: { method }, authorizer: { jwt: { claims: { sub, 'cognito:groups': groups } } } },
  };
  const res = await lambda.send(new InvokeCommand({ FunctionName: consoleFn, Payload: utf8.encode(JSON.stringify(event)) }));
  const out = JSON.parse(utf8.decode(res.Payload!));
  const body = out.body ? JSON.parse(out.body) : undefined;
  if (out.statusCode >= 400) throw new Error(`${method} ${path}: ${out.statusCode} ${out.body}`);
  return body;
}

interface State { operatorSub: string; channelIds: string[]; seeded: { PK: string; SK: string }[] }

async function cleanup(state: State) {
  const items = [...state.seeded];
  for (const channelId of state.channelIds) {
    const rest = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `CH#${channelId}` } }));
    items.push(...((rest.Items ?? []) as { PK: string; SK: string }[]));
  }
  for (const item of items) await db.send(new DeleteCommand({ TableName: table, Key: { PK: item.PK, SK: item.SK } }));
  await invoke(state.operatorSub, '[operator]', 'POST', '/api/admin/publications', { body: { reason: 'エコシステムの通しの確認の後片付け' } }).catch((e) => console.error(e));
  rmSync(stateFile, { force: true });
  console.log('cleaned up; the list is being rebuilt without', state.channelIds.join(', '));
}

if (process.argv.includes('--cleanup')) {
  await cleanup(JSON.parse(readFileSync(stateFile, 'utf8')) as State);
  process.exit(0);
}
const keep = process.argv.includes('--keep');

const { key } = await createKey('e2e-ecosystem-passphrase');
const run = Date.now().toString(36);
const publisherSub = `e2e-publisher-${run}`;
const operatorSub = `e2e-operator-${run}`;
const publisherId = ulid();
const now = new Date().toISOString();
const channels = [
  { channelId: `e2e-walk-${run}`, name: '通しの確認（歩くだけ）', activities: ['walk'], genres: ['general'], requires: [] as string[] },
  { channelId: `e2e-walk-cycle-${run}`, name: '通しの確認（歩く・自転車）', activities: ['walk', 'cycle'], genres: ['history'], requires: ['slot:guide'] },
  { channelId: `e2e-cycle-${run}`, name: '通しの確認（自転車だけ）', activities: ['cycle'], genres: ['nature'], requires: [] as string[] },
].map((c) => ({ ...c, sid: ulid() }));
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const seeded: { PK: string; SK: string; [k: string]: unknown }[] = [
  { PK: `USER#${publisherSub}`, SK: 'USER', type: 'user', publisherId },
  { PK: `PUB#${publisherId}`, SK: 'PUB', type: 'publisher', roles: ['publisher'], publisherId, displayName: 'エコシステムの通しの確認', status: 'active', activeAccountId: key.accountId, channelCount: channels.length, rev: 2, createdAt: now, updatedAt: now },
  ...channels.flatMap(({ channelId, sid }) => [
    { PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId, status: 'active', rev: 1, pendingSubmissionId: sid, createdAt: now, updatedAt: now, GSI1PK: `PUB#${publisherId}`, GSI1SK: `CH#${channelId}` },
    {
      PK: `CH#${channelId}`, SK: `SUB#${sid}`, type: 'submission', submissionId: sid, channelId, publisherId, accountId: key.accountId,
      state: 'uploading', intakeKey: `intake/${channelId}/${sid}.zip`, iconIntakeKey: `intake/${channelId}/${sid}.png`, description: 'エコシステムの通しの確認', rev: 1, createdAt: now, updatedAt: now,
    },
  ]),
];
const state: State = { operatorSub, channelIds: channels.map((c) => c.channelId), seeded: seeded.map(({ PK, SK }) => ({ PK, SK })) };

let ok = true;
try {
  writeFileSync(stateFile, JSON.stringify(state));
  for (const Item of seeded) await db.send(new PutCommand({ TableName: table, Item }));
  const s3 = new S3Client({ region });
  for (const c of channels) {
    const manifest = {
      format: 1, id: c.channelId, version: 1, publisher: key.accountId,
      name: c.name, summary: 'エコシステムの通しの確認', lang: 'ja', greeting: '確認です。',
      activities: c.activities, genres: c.genres, requires: { features: c.requires },
      talk: { level: 'quiet', events: { spot: true, revisit: false, milestone: false, rest: false, start: true, finish: true } },
      spots: { prefer: ['temple'], skip: [] }, guide: { length: 'short' }, mood: { tone: false, sound: 'auto' },
    };
    const zip = (await signPackage(zipSync({ 'channel.json': enc.encode(JSON.stringify(manifest)), 'prompts/guide/focus.md': enc.encode('- 由来を中心に話す\n') }), key, { channel: c.channelId })).zip;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `intake/${c.channelId}/${c.sid}.zip`, Body: zip, ContentType: 'application/zip' }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `intake/${c.channelId}/${c.sid}.png`, Body: png, ContentType: 'image/png' }));
  }

  for (const c of channels) {
    // 1. The machine review records what the package says (DES-011 N-3).
    let sub: Record<string, unknown> = {};
    for (let t = Date.now(); Date.now() - t < 120_000; await sleep(2000)) {
      sub = (await db.send(new GetCommand({ TableName: table, Key: { PK: `CH#${c.channelId}`, SK: `SUB#${c.sid}` }, ConsistentRead: true }))).Item!;
      if (sub.state !== 'uploading') break;
    }
    console.log(`${c.channelId}: machine review ${sub.state}`, JSON.stringify(sub.listing));
    if (sub.state !== 'awaiting_review') throw new Error(JSON.stringify(sub.validation));

    // 2. The samples come from each activity's representative app (N-8), and the operator approves.
    const prompts = await invoke(operatorSub, '[operator]', 'GET', `/api/admin/channels/${c.channelId}/submissions/${c.sid}/sample-prompts`);
    const ids: string[] = prompts.scenarios.map((x: { id: string }) => x.id);
    const walkSamples = ids.some((id) => !id.startsWith('ride-'));
    const rideSamples = ids.some((id) => id.startsWith('ride-'));
    const samplesMatch = walkSamples === c.activities.includes('walk') && rideSamples === c.activities.includes('cycle') && !prompts.noRepresentativeApp;
    ok &&= samplesMatch;
    console.log(`  ${samplesMatch ? 'PASS' : 'FAIL'} samples of ${c.channelId}: ${ids.join(', ')}`);
    const saved = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${c.channelId}/submissions/${c.sid}/samples`, {
      body: { service: 'e2e', model: 'none', items: prompts.scenarios.map((x: { id: string }) => ({ scenarioId: x.id, output: '（通しの確認のため AI は呼ばない）' })) },
    });
    const started = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${c.channelId}/submissions/${c.sid}/start`, { ifMatch: Number(sub.rev) });
    const approved = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${c.channelId}/submissions/${c.sid}/approve`, {
      body: { samplesIds: [saved.samplesId], message: 'エコシステムの通しの確認' }, ifMatch: started.rev,
    });
    console.log(`${c.channelId}: approved ${approved.submission.state}`);
  }

  // 3. Wait until the list carries both, then compare what it says with DES-011 N-3・N-5・N-6.
  type Listed = { id: string; activities?: string[]; genres?: string[]; requires?: string[]; minAppVersions: Record<string, number>; package: { format: number } };
  let listed: Listed[] = [];
  for (let t = Date.now(); listed.length < channels.length && Date.now() - t < 180_000; await sleep(3000)) {
    const doc = await (await fetch(`${providerUrl}/v1/channels.json?${Date.now()}`)).json();
    const body = JSON.parse(utf8.decode(Uint8Array.from(atob(doc.payload.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0))));
    listed = (body.channels as Listed[]).filter((l) => state.channelIds.includes(l.id));
  }
  const expected: Record<string, Partial<Listed>> = {
    [channels[0].channelId]: { activities: ['walk'], genres: ['general'], requires: [] },
    [channels[1].channelId]: { activities: ['walk', 'cycle'], genres: ['history'], requires: ['slot:guide'] },
    [channels[2].channelId]: { activities: ['cycle'], genres: ['nature'], requires: [] },
  };
  for (const l of listed) {
    const want = expected[l.id];
    const got = { activities: l.activities, genres: l.genres, requires: l.requires };
    const match = JSON.stringify(got) === JSON.stringify(want);
    ok &&= match;
    console.log(`  ${match ? 'PASS' : 'FAIL'} listed ${l.id} ${JSON.stringify({ ...got, minAppVersions: l.minAppVersions, format: l.package.format })}`);
  }
  if (listed.length < channels.length) { ok = false; console.log('  FAIL not every channel was listed'); }

  // 4. The conformance checks (V-27, V-29).
  const discovery = await (await fetch(`${providerUrl}/.well-known/sanpo-channels`)).json();
  const results = await checkProvider(providerUrl, { expectedProvider: discovery.provider });
  for (const r of results) console.log(`  ${r.status.toUpperCase().padEnd(4)} ${r.id} ${r.detail}`);
  ok &&= results.every((r) => r.status !== 'fail');
} catch (e) {
  ok = false;
  console.error(e);
} finally {
  if (keep && ok) console.log(`kept for the app check (${state.channelIds.join(', ')}); remove with --cleanup`);
  else await cleanup(state);
}
process.exit(ok ? 0 : 1);
