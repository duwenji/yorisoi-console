import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readPlacementVerdict } from '../src/studio/check.js';
import { finishTranscription, goLive, mp4Seconds, startCheck, uploadKey, type PlacementPorts } from '../src/studio/placement.js';
import type { CheckReply, ModelChoice, StudioSettings } from '../src/studio/studio.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';

// DES-013 K-11: the placement check, from upload to going up or back to the provider.

const DEEPSEEK: ModelChoice = { id: 'deepseek-v3-2', profile: 'deepseek.v3.2', price: { inputPerMTok: 0.74, outputPerMTok: 2.22 } };
const ID = '01JBY00000000000000000000A';

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let ports: PlacementPorts;
let db: DynamoDBDocumentClient;
let relayTable: string;
let intake: Map<string, Uint8Array>;
let served: [string, string][];
let jobs: { jobName: string; mediaKey: string; outputKey: string }[];
let reply: CheckReply | Error;
let checked: string[];
let settings: StudioSettings;

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

/** An M4A of [seconds]: an `ftyp` box, then a movie header (version 0) with a timescale of 1000. */
function m4a(seconds: number, version: 0 | 1 = 0): Uint8Array {
  const bytes = new Uint8Array(16 + 8 + 120);
  const view = new DataView(bytes.buffer);
  const put = (at: number, tag: string) => [...tag].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  view.setUint32(0, 16);
  put(4, 'ftyp');
  put(8, 'M4A ');
  view.setUint32(16, 128);
  put(20, 'moov');
  const m = 24;
  view.setUint32(m, 120);
  put(m + 4, 'mvhd');
  bytes[m + 8] = version;
  if (version === 0) {
    view.setUint32(m + 20, 1000);
    view.setUint32(m + 24, seconds * 1000);
  } else {
    view.setUint32(m + 28, 1000);
    view.setBigUint64(m + 32, BigInt(seconds * 1000));
  }
  return bytes;
}

beforeEach(async () => {
  const studio = await freshTable(local.endpoint);
  const relay = await freshTable(local.endpoint);
  db = studio.db;
  relayTable = relay.table;
  intake = new Map();
  served = [];
  jobs = [];
  checked = [];
  reply = { text: '{"ok": true}', inputTokens: 900, outputTokens: 8 };
  settings = { termsVersion: 1, termsUrl: 'u', termsUpdatedAt: '', paused: false, monthlyBudgetUsd: 5, model: DEEPSEEK };
  ports = {
    db,
    table: studio.table,
    relayTable: relay.table,
    now: () => new Date('2026-10-31T03:00:00.000Z'),
    settings: async () => settings,
    check: async (_model, _system, user) => {
      checked.push(user);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    intake: {
      head: async (key) => (intake.has(key) ? { bytes: intake.get(key)!.length } : undefined),
      read: async (key) => intake.get(key)!,
      copy: async (from, to) => void intake.set(to, intake.get(from)!),
      text: async (key) => (intake.has(key) ? new TextDecoder().decode(intake.get(key)) : undefined),
    },
    serveAudio: async (from, to) => void served.push([from, to]),
    transcribe: async (jobName, mediaKey, outputKey) => void jobs.push({ jobName, mediaKey, outputKey }),
    jobPrefix: 'studio-dev-',
    metric: () => {},
  };
});

async function placement(extra: Record<string, unknown> = {}) {
  await db.send(
    new PutCommand({
      TableName: ports.table,
      Item: {
        PK: `PLACEMENT#${ID}`, SK: 'PLACEMENT', id: ID, publisherId: 'P', providerName: '谷中銀座商店会', text: '今日 15 時から豆まきをします',
        cells: ['xn77h2', 'xn77h3'], startsAt: '2026-10-31T00:00:00.000Z', endsAt: '2026-11-02T00:00:00.000Z', state: 'checking', rev: 2, ...extra,
      },
    }),
  );
}
const load = async () => (await db.send(new GetCommand({ TableName: ports.table, Key: { PK: `PLACEMENT#${ID}`, SK: 'PLACEMENT' } }))).Item!;
const cell = async (c: string) => (await db.send(new GetCommand({ TableName: ports.table, Key: { PK: `CELL#${c}`, SK: `P#${ID}` } }))).Item;
const transcript = (text: string) => new TextEncoder().encode(JSON.stringify({ results: { transcripts: [{ transcript: text }] } }));

describe('the placement check', () => {
  it('puts a text-only placement up at once, into each of its cells', async () => {
    await placement();
    await startCheck(ports, ID);
    expect(JSON.parse(checked[0]!)).toEqual({ provider: '谷中銀座商店会', text: '今日 15 時から豆まきをします' });
    expect((await load()).state).toBe('live');
    expect(await cell('xn77h3')).toMatchObject({ id: ID, providerName: '谷中銀座商店会', cells: ['xn77h2', 'xn77h3'], ttl: Math.floor(Date.parse('2026-11-02T00:00:00.000Z') / 1000) });
    const spend = await db.send(new GetCommand({ TableName: relayTable, Key: { PK: 'SPEND', SK: 'MONTH#2026-10' } }));
    expect(spend.Item?.microUsd).toBe(Math.ceil(900 * 0.74 + 8 * 2.22));
  });

  it('writes the audio out, then checks it with the text, and serves the audio when it passes', async () => {
    await placement({ audio: { bytes: 144 } });
    intake.set(uploadKey(ID), m4a(24));
    await startCheck(ports, ID);
    expect(jobs).toEqual([{ jobName: expect.stringMatching(new RegExp(`^studio-dev-${ID}-[0-9]+$`)), mediaKey: `held/${ID}.m4a`, outputKey: `transcripts/${ID}.json` }]);
    expect((await load()).audio).toMatchObject({ key: `held/${ID}.m4a`, durationSec: 24, contentType: 'audio/mp4' });
    expect(await cell('xn77h2')).toBeUndefined();

    intake.set(`transcripts/${ID}.json`, transcript('本日十五時より夕やけだんだんで豆まきを行います'));
    await finishTranscription(ports, jobs[0]!.jobName, 'COMPLETED');
    expect(JSON.parse(checked[0]!).audio).toBe('本日十五時より夕やけだんだんで豆まきを行います');
    expect(served).toEqual([[`held/${ID}.m4a`, `placements/${ID}/audio.m4a`]]);
    const live = await load();
    expect(live.state).toBe('live');
    expect((await cell('xn77h2'))?.audio).toMatchObject({ key: `placements/${ID}/audio.m4a`, durationSec: 24, bytes: 144 });
    expect(live.check).toMatchObject({ items: [], transcript: '本日十五時より夕やけだんだんで豆まきを行います' });
  });

  it('returns a placement whose audio says a phone number, without asking the AI (2.2.2)', async () => {
    await placement({ audio: { bytes: 144 } });
    intake.set(uploadKey(ID), m4a(10));
    await startCheck(ports, ID);
    intake.set(`transcripts/${ID}.json`, transcript('ご予約は 03 1234 5678 まで'));
    await finishTranscription(ports, jobs[0]!.jobName, 'COMPLETED');
    expect(checked).toEqual([]);
    expect(await load()).toMatchObject({ state: 'returned', check: { items: ['2.2.2'], transcript: 'ご予約は 03 1234 5678 まで' } });
    expect(await cell('xn77h2')).toBeUndefined();
  });

  it('returns what the AI flags, with the rules it hit', async () => {
    reply = { text: '{"ok": false, "items": ["2.2.4", "9.9"]}', inputTokens: 900, outputTokens: 12 };
    await placement({ text: '〇〇党の演説会を駅前で行います' });
    await startCheck(ports, ID);
    expect(await load()).toMatchObject({ state: 'returned', check: { items: ['2.2.4'] } });
  });

  it('returns audio that is missing, too long or not M4A, before any job', async () => {
    await placement({ audio: { bytes: 144 } });
    await startCheck(ports, ID);
    expect((await load()).check.items).toEqual(['audio_missing']);

    await placement({ audio: { bytes: 144 } });
    intake.set(uploadKey(ID), m4a(31));
    await startCheck(ports, ID);
    expect((await load()).check.items).toEqual(['audio_length']);

    await placement({ audio: { bytes: 144 } });
    intake.set(uploadKey(ID), new TextEncoder().encode('RIFF....WAVEfmt '));
    await startCheck(ports, ID);
    expect((await load()).check.items).toEqual(['audio_format']);
    expect(jobs).toEqual([]);
  });

  it('returns it to try again when the check can’t run: the AI fails, the budget is spent, Transcribe fails', async () => {
    reply = new Error('ThrottlingException');
    await placement();
    await startCheck(ports, ID);
    expect((await load()).check.items).toEqual(['check_unavailable']);

    reply = { text: '{"ok": true}', inputTokens: 1, outputTokens: 1 };
    await db.send(new PutCommand({ TableName: relayTable, Item: { PK: 'SPEND', SK: 'MONTH#2026-10', microUsd: 5_000_000 } }));
    await placement();
    await startCheck(ports, ID);
    expect((await load()).check.items).toEqual(['check_unavailable']);

    await placement({ audio: { bytes: 144 } });
    intake.set(uploadKey(ID), m4a(5));
    await startCheck(ports, ID);
    await finishTranscription(ports, jobs[0]!.jobName, 'FAILED');
    expect((await load()).check.items).toEqual(['transcribe_failed']);
  });

  it('ignores jobs that aren’t this stack’s or this check’s', async () => {
    await placement({ audio: { bytes: 144 } });
    intake.set(uploadKey(ID), m4a(5));
    await startCheck(ports, ID);
    await finishTranscription(ports, `studio-prod-${ID}-1`, 'FAILED');
    await finishTranscription(ports, `studio-dev-${ID}-1`, 'FAILED');
    expect((await load()).state).toBe('checking');
  });

  it('puts an appealed placement up when the operator accepts, and nothing else', async () => {
    await placement({ state: 'appealed', audio: { key: `held/${ID}.m4a`, durationSec: 12, bytes: 144, contentType: 'audio/mp4', sha256: 'x' } });
    await goLive(ports, ID, 'appealed');
    expect((await load()).state).toBe('live');
    expect(served).toHaveLength(1);
    await goLive(ports, ID, 'appealed');
    expect(served).toHaveLength(1);
    const cells = await db.send(new QueryCommand({ TableName: ports.table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'CELL#xn77h3' } }));
    expect(cells.Items).toHaveLength(1);
  });
});

describe('reading audio and verdicts', () => {
  it('reads an M4A’s length from its movie header, in both versions', () => {
    expect(mp4Seconds(m4a(24))).toBe(24);
    expect(mp4Seconds(m4a(30, 1))).toBe(30);
    expect(mp4Seconds(new TextEncoder().encode('ID3 not an mp4 file at all, really'))).toBeUndefined();
  });

  it('keeps only the rule numbers from the AI', () => {
    expect(readPlacementVerdict('{"ok": true}').ok).toBe(true);
    expect(readPlacementVerdict('{"ok": false, "items": ["2.2.8", "2.2.13", "x"]}')).toEqual({ ok: false, items: ['2.2.8'] });
    expect(readPlacementVerdict('大丈夫です').ok).toBe(false);
  });
});
