import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readLocalSettings } from '../src/local/aws.js';
import { hasContact, readVerdict } from '../src/local/check.js';
import { route } from '../src/local/handler.js';
import { approx, forgetAreas, type CheckReply, type ModelChoice, type LocalPorts, type LocalSettings } from '../src/local/local.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';

const DEEPSEEK: ModelChoice = { id: 'deepseek-v3-2', profile: 'deepseek.v3.2', price: { inputPerMTok: 0.74, outputPerMTok: 2.22 } };

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let ports: LocalPorts;
let db: DynamoDBDocumentClient;
let relayTable: string;
let now: Date;
let reply: CheckReply | Error;
let checks: string[];
let metrics: Record<string, number>;
let settings: LocalSettings;
let counter: number;

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64url');

beforeEach(async () => {
  const localTable = await freshTable(local.endpoint);
  const relay = await freshTable(local.endpoint);
  db = localTable.db;
  relayTable = relay.table;
  now = new Date('2026-10-31T03:00:00.000Z'); // 12:00 in Japan
  reply = { text: '{"ok": true}', inputTokens: 600, outputTokens: 8 };
  checks = [];
  metrics = {};
  settings = { termsVersion: 1, termsUrl: 'https://example.org/terms/1', termsUpdatedAt: '2026-11-01T00:00:00Z', paused: false, monthlyBudgetUsd: 5, model: DEEPSEEK };
  counter = 0;
  forgetAreas();
  ports = {
    db,
    table: localTable.table,
    relayTable: relay.table,
    now: () => now,
    // ULIDs that sort by creation, as real ones do.
    id: () => `01JBX${String(++counter).padStart(21, '0')}`,
    settings: async () => settings,
    check: async (_model, _system, user) => {
      checks.push(user);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    audioBase: 'https://audio.example.org',
    metric: (name, value) => {
      metrics[name] = (metrics[name] ?? 0) + value;
    },
  };
  for (const name of ['a', 'b', 'c', 'd']) await token(name);
});

/** A relay session for install hash `install-{name}`, as the relay writes it. */
async function token(name: string, expiresAt = '2026-11-01T03:00:00.000Z') {
  await db.send(new PutCommand({ TableName: relayTable, Item: { PK: `TOKEN#${sha256(`tok-${name}`)}`, SK: 'TOKEN', install: `install-${name}`, expiresAt } }));
}

function event(method: string, resource: string, opts: { body?: unknown; who?: string; query?: Record<string, string>; id?: string } = {}): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    resource,
    path: resource,
    headers: opts.who ? { Authorization: `Bearer tok-${opts.who}` } : {},
    queryStringParameters: opts.query ?? null,
    pathParameters: opts.id ? { id: opts.id } : null,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
  } as unknown as APIGatewayProxyEvent;
}

async function call(method: string, resource: string, opts: Parameters<typeof event>[2] = {}) {
  const res = await route(event(method, resource, opts), ports);
  return { status: res.statusCode, type: res.headers?.['content-type'], body: res.body ? JSON.parse(res.body) : undefined };
}

const NOTE = { text: 'この坂の上から富士山が見えた', cell: 'xn76ury', spotName: '富士見坂', ttl: '24h', termsVersion: 1 };
const place = (who: string, body: Record<string, unknown> = {}) => call('POST', '/v1/local/notes', { who, body: { ...NOTE, ...body } });
const list = (who: string, cells = 'xn76ur', kinds?: string) => call('GET', '/v1/local/cells', { who, query: { cells, ...(kinds ? { kinds } : {}) } });
const pass = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};

describe('POST /v1/local/notes', () => {
  it('checks the note with the operator’s AI and places it for its time', async () => {
    const res = await place('a');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), expiresAt: '2026-11-01T03:00:00.000Z', remainingToday: 9 });
    expect(JSON.parse(checks[0]!)).toEqual({ note: NOTE.text, spot: NOTE.spotName });
    // The AI's cost goes on the relay's month (K-3).
    const spend = await db.send(new GetCommand({ TableName: relayTable, Key: { PK: 'SPEND', SK: 'MONTH#2026-10' } }));
    expect(spend.Item?.microUsd).toBe(Math.ceil(600 * 0.74 + 8 * 2.22));
  });

  it('stops contact details without asking the AI (terms 2-4)', async () => {
    for (const text of ['詳しくは https://example.com を見て', '090-1234-5678 まで', 'mail: a@example.jp', '＠yorisoi_cafe をフォロー']) {
      const res = await place('a', { text });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('note_rejected');
    }
    expect(checks).toHaveLength(0);
  });

  it('does not place what the AI flags, and says no more than that (V-01 of the terms 3)', async () => {
    reply = { text: '{"ok": false, "items": [3]}', inputTokens: 600, outputTokens: 12 };
    const res = await place('a', { text: '今この公園に赤い服の〇〇さんがいる' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ type: 'about:blank', title: expect.any(String), status: 422, code: 'note_rejected' });
  });

  it('places nothing when the AI fails, and gives the count back', async () => {
    reply = new Error('ThrottlingException');
    expect((await place('a')).body.code).toBe('upstream_error');
    reply = { text: '{"ok": true}', inputTokens: 1, outputTokens: 1 };
    expect((await place('a')).body.remainingToday).toBe(9);
  });

  it('allows ten a day and says when it resets (V-04)', async () => {
    for (let i = 0; i < 10; i++) expect((await place('a')).status).toBe(201);
    const res = await place('a');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'daily_note_limit', resetsAt: '2026-10-31T15:00:00.000Z' });
  });

  it('asks for the current terms (V-05)', async () => {
    settings.termsVersion = 2;
    expect((await place('a')).body.code).toBe('terms_not_accepted');
    expect((await place('a', { termsVersion: undefined })).body.code).toBe('terms_not_accepted');
    expect((await place('a', { termsVersion: 2 })).status).toBe(201);
  });

  it('refuses a banned device, a closed area, a long text and a paused budget', async () => {
    await db.send(new PutCommand({ TableName: ports.table, Item: { PK: 'BAN#install-b', SK: 'BAN', until: '2026-12-01T00:00:00.000Z' } }));
    expect((await place('b')).body).toMatchObject({ code: 'author_banned', until: '2026-12-01T00:00:00.000Z' });

    await db.send(new PutCommand({ TableName: ports.table, Item: { PK: 'AREA', SK: 'xn76u' } }));
    forgetAreas();
    expect((await place('a')).body.code).toBe('area_closed');
    forgetAreas();
    expect((await place('a', { cell: 'xn77h2b' })).status).toBe(201);

    expect((await place('a', { cell: 'xn77h2b', text: 'あ'.repeat(61) })).body.code).toBe('text_too_long');
    expect((await place('a', { cell: 'xn77h2', text: 'x' })).body.code).toBe('invalid_request');

    await db.send(new PutCommand({ TableName: relayTable, Item: { PK: 'SPEND', SK: 'MONTH#2026-10', microUsd: 5_000_000 } }));
    expect((await place('a', { cell: 'xn77h2b' })).body.code).toBe('relay_paused');
  });

  it('needs a live relay token', async () => {
    expect((await call('POST', '/v1/local/notes', { body: NOTE })).body.code).toBe('token_invalid');
    await token('old', '2026-10-31T02:00:00.000Z');
    expect((await place('old')).body.code).toBe('token_invalid');
  });

  it('answers local_paused when the operator pauses it', async () => {
    settings.paused = true;
    expect((await place('a')).body.code).toBe('local_paused');
    expect((await list('a')).status).toBe(503);
  });
});

describe('GET /v1/local/cells', () => {
  it('lists notes without anything that tells who placed them; only mine is marked (V-01)', async () => {
    const { body: mine } = await place('a');
    const res = await list('b');
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([{ id: mine.id, text: NOTE.text, cell: 'xn76ury', spotName: '富士見坂', expiresAt: mine.expiresAt, mine: false }]);
    expect(JSON.stringify(res.body)).not.toContain('install-a');
    expect(res.body.refetchAfterSec).toBe(300);
    expect((await list('a')).body.notes[0].mine).toBe(true);
  });

  it('refuses the same cells again within four minutes, but not new cells (K-8)', async () => {
    expect((await list('a')).status).toBe(200);
    expect((await list('a')).body.code).toBe('too_many_requests');
    expect((await list('a', 'xn76ur,xn76us')).status).toBe(200);
    pass(5);
    expect((await list('a', 'xn76ur,xn76us')).status).toBe(200);
  });

  it('leaves out expired notes and keeps 20 per geohash7', async () => {
    await place('a', { ttl: '1h' });
    pass(61);
    expect((await list('b')).body.notes).toEqual([]);
    for (const who of ['a', 'b', 'c']) {
      for (let i = 0; i < 7; i++) await place(who, { text: `${who}${i}` });
    }
    pass(5);
    expect((await list('d')).body.notes).toHaveLength(20);
  });

  it('lists studios in their period with the audio URL, and only the kinds asked for (V-06)', async () => {
    const base = { providerName: '谷中銀座商店会', category: 'event', text: '今日 15 時から豆まき', startsAt: '2026-10-31T00:00:00.000Z', endsAt: '2026-11-02T00:00:00.000Z' };
    const audio = { key: 'studios/P1/audio.m4a', durationSec: 24, bytes: 196000, contentType: 'audio/mp4', sha256: 'abc' };
    await db.send(new PutCommand({ TableName: ports.table, Item: { PK: 'CELL#xn76ur', SK: 'P#P1', id: 'P1', ...base, audio, cells: ['xn76ur'], hours: { from: '10:00', to: '18:00' } } }));
    await db.send(new PutCommand({ TableName: ports.table, Item: { PK: 'CELL#xn76ur', SK: 'P#P2', id: 'P2', ...base, cells: ['xn76ur'], startsAt: '2026-11-01T00:00:00.000Z' } }));
    await place('a');
    pass(5);
    const res = await list('b');
    expect(res.body.studios).toEqual([{ id: 'P1', ...base, audio: { ...audio, key: undefined, url: 'https://audio.example.org/studios/P1/audio.m4a' }, cells: ['xn76ur'], hours: { from: '10:00', to: '18:00' } }].map((p) => JSON.parse(JSON.stringify(p))));
    pass(5);
    const onlyStudios = await list('b', 'xn76ur', 'studio');
    expect(onlyStudios.body.notes).toEqual([]);
    expect(onlyStudios.body.studios).toHaveLength(1);
  });

  it('keeps the list within 50 items and 3 MB (V-09)', async () => {
    for (let i = 0; i < 20; i++) {
      await db.send(
        new PutCommand({
          TableName: ports.table,
          Item: {
            PK: 'CELL#xn76ur',
            SK: `P#P${i}`,
            id: `P${i}`,
            providerName: 'x',
            text: 'x',
            audio: { key: `p/${i}.m4a`, durationSec: 30, bytes: 400_000, contentType: 'audio/mp4', sha256: 's' },
            cells: ['xn76ur'],
            startsAt: '2026-10-30T00:00:00.000Z',
            endsAt: '2026-11-30T00:00:00.000Z',
          },
        }),
      );
    }
    await token('e');
    await token('f');
    for (const who of ['a', 'b', 'c', 'd', 'e', 'f']) for (let i = 0; i < 10; i++) await place(who, { cell: `xn76ur${'0123456789'[i]}`, text: `${who}${i}` });
    const res = await list('a');
    expect(res.body.studios.length).toBe(7); // 7 × 400 KB fits in 3 MB, 8 doesn't
    expect(res.body.notes.length + res.body.studios.length).toBe(50);
  });
});

describe('reactions, likes and counts', () => {
  it('adds heard and opened to day totals without keeping who sent them (V-07, V-08)', async () => {
    const { body: n } = await place('a');
    for (const who of ['b', 'c']) await call('POST', '/v1/local/reactions', { who, body: { heard: [{ type: 'note', id: n.id }], liked: [n.id] } });
    let mine = await call('GET', '/v1/local/notes/mine', { who: 'a' });
    expect(mine.body.notes[0]).toMatchObject({ heard: null, likes: null, state: 'active' });

    const res = await call('POST', '/v1/local/reactions', { who: 'd', body: { heard: [{ type: 'note', id: n.id }], opened: [{ type: 'note', id: n.id }], liked: [n.id, n.id] } });
    expect(res.status).toBe(202);
    // A like counts once per device.
    await call('POST', '/v1/local/reactions', { who: 'd', body: { liked: [n.id] } });
    mine = await call('GET', '/v1/local/notes/mine', { who: 'a' });
    expect(mine.body.notes[0]).toMatchObject({ heard: { atLeast: 3 }, likes: { atLeast: 3 } });

    const stats = await db.send(new QueryCommand({ TableName: ports.table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `STATS#${n.id}` } }));
    expect(stats.Items).toEqual([expect.objectContaining({ SK: 'DAY#2026-10-31', heard: 3, opened: 1 })]);
    expect(JSON.stringify(stats.Items)).not.toContain('install-');
  });

  it('ignores ids that are unknown and refuses too many at once', async () => {
    expect((await call('POST', '/v1/local/reactions', { who: 'a', body: { heard: [{ type: 'note', id: '01JBX000000000000000000099' }] } })).status).toBe(202);
    const many = Array.from({ length: 201 }, () => ({ type: 'note', id: '01JBX000000000000000000099' }));
    expect((await call('POST', '/v1/local/reactions', { who: 'a', body: { heard: many } })).body.code).toBe('invalid_request');
  });

  it('turns counts into the API-LOCAL-MATERIALS buckets', () => {
    expect([0, 2, 3, 9, 10, 47, 100, 999, 5000].map((n) => approx(n)?.atLeast ?? null)).toEqual([null, null, 3, 3, 10, 30, 100, 300, 1000]);
  });
});

describe('reports, blocks and my notes', () => {
  it('hides a note reported by three devices from everyone but its author (V-03)', async () => {
    const { body: n } = await place('a');
    for (const who of ['b', 'b', 'c']) await call('POST', '/v1/local/reports', { who, body: { type: 'note', id: n.id, reason: 'harassment' } });
    pass(5);
    expect((await list('d')).body.notes).toHaveLength(1);
    await call('POST', '/v1/local/reports', { who: 'd', body: { type: 'note', id: n.id, reason: 'harassment' } });
    pass(5);
    expect((await list('d')).body.notes).toEqual([]);
    expect((await call('GET', '/v1/local/notes/mine', { who: 'a' })).body.notes[0].state).toBe('hidden');
    const queue = await db.send(new QueryCommand({ TableName: ports.table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'QUEUE#REPORTED_NOTE' } }));
    expect(queue.Items).toHaveLength(1);
  });

  it('stops a studio at the first report about safety, and queues every studio report', async () => {
    const p = { PK: 'STUDIO#01JBX000000000000000000P01', SK: 'STUDIO', id: '01JBX000000000000000000P01', state: 'live', cells: ['xn76ur', 'xn76us'] };
    await db.send(new PutCommand({ TableName: ports.table, Item: p }));
    for (const cell of p.cells) await db.send(new PutCommand({ TableName: ports.table, Item: { PK: `CELL#${cell}`, SK: `P#${p.id}`, id: p.id } }));
    await call('POST', '/v1/local/reports', { who: 'a', body: { type: 'studio', id: p.id, reason: 'other' } });
    expect((await db.send(new GetCommand({ TableName: ports.table, Key: { PK: p.PK, SK: 'STUDIO' } }))).Item?.state).toBe('live');
    await call('POST', '/v1/local/reports', { who: 'b', body: { type: 'studio', id: p.id, reason: 'danger' } });
    expect((await db.send(new GetCommand({ TableName: ports.table, Key: { PK: p.PK, SK: 'STUDIO' } }))).Item?.state).toBe('suspended');
    expect((await db.send(new GetCommand({ TableName: ports.table, Key: { PK: 'CELL#xn76us', SK: `P#${p.id}` } }))).Item).toBeUndefined();
    const queue = await db.send(new QueryCommand({ TableName: ports.table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'QUEUE#REPORTED_STUDIO' } }));
    expect(queue.Items).toEqual([expect.objectContaining({ SK: p.id, type: 'studio', reasons: new Set(['other', 'danger']) })]);
  });

  it('blocks the author of a note for this device only, and unblocks (V-02)', async () => {
    const { body: first } = await place('a');
    await place('a', { text: '紅葉がきれい' });
    const res = await call('POST', '/v1/local/blocks', { who: 'b', body: { noteId: first.id } });
    expect(res.status).toBe(201);
    const createdAt = now.toISOString();
    expect(res.body).toEqual({ id: expect.stringMatching(/^blk_/), createdAt });
    pass(5);
    expect((await list('b')).body.notes).toEqual([]);
    expect((await list('c')).body.notes).toHaveLength(2);
    const { body: listed } = await call('GET', '/v1/local/blocks', { who: 'b' });
    expect(listed.blocks).toEqual([{ id: res.body.id, createdAt, expiresAt: expect.any(String) }]);
    expect(JSON.stringify(listed)).not.toContain('install-a');
    expect((await call('DELETE', '/v1/local/blocks/{id}', { who: 'b', id: res.body.id })).status).toBe(204);
    pass(5);
    expect((await list('b')).body.notes).toHaveLength(2);
    expect((await call('DELETE', '/v1/local/blocks/{id}', { who: 'b', id: res.body.id })).body.code).toBe('not_found');
    expect((await call('POST', '/v1/local/blocks', { who: 'a', body: { noteId: first.id } })).body.code).toBe('invalid_request');
  });

  it('can still block a few days after the note expired', async () => {
    const { body: n } = await place('a', { ttl: '1h' });
    for (const who of ['b', 'c']) await token(who, '2026-12-01T00:00:00.000Z');
    pass(3 * 24 * 60);
    expect((await call('POST', '/v1/local/blocks', { who: 'b', body: { noteId: n.id } })).status).toBe(201);
    pass(5 * 24 * 60);
    expect((await call('POST', '/v1/local/blocks', { who: 'c', body: { noteId: n.id } })).body.code).toBe('not_found');
  });

  it('lets the author delete a note, which leaves the list at once and keeps no text', async () => {
    const { body: n } = await place('a');
    expect((await call('DELETE', '/v1/local/notes/{id}', { who: 'b', id: n.id })).body.code).toBe('not_found');
    expect((await call('DELETE', '/v1/local/notes/{id}', { who: 'a', id: n.id })).status).toBe(204);
    expect((await list('b')).body.notes).toEqual([]);
    expect((await call('GET', '/v1/local/notes/mine', { who: 'a' })).body.notes).toEqual([]);
    const item = (await db.send(new GetCommand({ TableName: ports.table, Key: { PK: `NOTE#${n.id}`, SK: 'NOTE' } }))).Item;
    expect(item?.text).toBeUndefined();
    expect(item?.author).toBe('install-a');
  });
});

describe('terms and settings', () => {
  it('answers the terms without a token', async () => {
    const res = await call('GET', '/v1/local/terms');
    expect(res.body).toEqual({ version: 1, url: 'https://example.org/terms/1', updatedAt: '2026-11-01T00:00:00Z' });
  });

  it('falls back to the deployed values when a parameter is bad', () => {
    const seen: Record<string, number> = {};
    const s = readLocalSettings(
      { termsVersion: 'x', termsUrl: '', paused: 'false', monthlyBudgetUsd: '-1', model: 'none' },
      { termsVersion: 1, termsUrl: 'https://default', monthlyBudgetUsd: 5, models: [DEEPSEEK], model: 'deepseek-v3-2' },
      (name, value) => (seen[name] = value),
    );
    expect(s).toMatchObject({ termsVersion: 1, termsUrl: 'https://default', paused: false, monthlyBudgetUsd: 5, model: DEEPSEEK });
    expect(seen.InvalidSetting).toBe(1);
  });
});

describe('the note check', () => {
  it('finds contact details but not ordinary numbers', () => {
    for (const text of ['www.example.com', 'example.co.jp まで', '03 1234 5678', '０９０１２３４５６７８', 'a@b.jp', '@cafe_yorisoi']) expect(hasContact(text), text).toBe(true);
    for (const text of ['2026年10月31日の夕焼け', '3丁目の角を右', '気温は18度', '富士見坂']) expect(hasContact(text), text).toBe(false);
  });

  it('places only on a clear ok', () => {
    expect(readVerdict('{"ok": true}').ok).toBe(true);
    expect(readVerdict('```json\n{"ok": true}\n```').ok).toBe(true);
    expect(readVerdict('{"ok": false, "items": [5]}')).toEqual({ ok: false, items: [5] });
    expect(readVerdict('はい、問題ありません').ok).toBe(false);
    expect(readVerdict('{"ok": "true"}').ok).toBe(false);
  });
});
