import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { hasContact, NOTE_CHECK_SYSTEM, noteCheckUser, readVerdict } from './check.js';

/**
 * The studio's API for the apps (platform API-LOCAL-MATERIALS, DES-013): notes that people place for a
 * while, studios that approved providers put up, both handed out per cell to whoever comes
 * near. The token, the operator's AI and its budget are the relay's (K-3); the studio keeps only
 * the relay's install hash, never an install id, a token or a position finer than a cell (K-6).
 */

export type LocalCode =
  | 'invalid_request'
  | 'token_invalid'
  | 'terms_not_accepted'
  | 'author_banned'
  | 'area_closed'
  | 'not_found'
  | 'text_too_long'
  | 'note_rejected'
  | 'daily_note_limit'
  | 'too_many_requests'
  | 'upstream_error'
  | 'relay_paused'
  | 'local_paused';

const STATUS: Record<LocalCode, number> = {
  invalid_request: 400,
  token_invalid: 401,
  terms_not_accepted: 403,
  author_banned: 403,
  area_closed: 403,
  not_found: 404,
  text_too_long: 413,
  note_rejected: 422,
  daily_note_limit: 429,
  too_many_requests: 429,
  upstream_error: 502,
  relay_paused: 503,
  local_paused: 503,
};

export class LocalError extends Error {
  constructor(
    readonly code: LocalCode,
    detail: string,
    /** Extra members of the problem: `until`, `resetsAt`. */
    readonly extra: Record<string, string> = {},
  ) {
    super(detail);
  }

  get status() {
    return STATUS[this.code];
  }
}

/** A model of the operator's AI and its price, as the relay has them (ADR-AI-RELAY R-5). */
export interface ModelChoice {
  id: string;
  profile: string;
  price: { inputPerMTok: number; outputPerMTok: number };
}

/** The operator's settings: the studio's own, and the relay's model and budget (K-3, K-19). */
export interface LocalSettings {
  termsVersion: number;
  termsUrl: string;
  termsUpdatedAt: string;
  paused: boolean;
  monthlyBudgetUsd: number;
  model: ModelChoice;
}

export interface CheckReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LocalPorts {
  db: DynamoDBDocumentClient;
  /** The studio's table (DES-013「データモデル」). */
  table: string;
  /** The relay's table: tokens are read there, and the AI's cost is added to its month (K-3). */
  relayTable: string;
  now: () => Date;
  /** A new ULID. */
  id: () => string;
  settings: () => Promise<LocalSettings>;
  /** One call to the operator's AI; throws when the service fails. */
  check: (model: ModelChoice, system: string, user: string) => Promise<CheckReply>;
  /** Where studios' audio is served (CloudFront), without a trailing slash (K-5). */
  audioBase: string;
  /** A CloudWatch metric; never carries text, cells or installs. */
  metric: (name: string, value: number) => void;
}

/** API-LOCAL-MATERIALS's limits. */
export const NOTE_MAX_CHARS = 60;
export const SPOT_MAX_CHARS = 40;
export const NOTES_PER_DAY = 10;
export const NOTES_PER_CELL = 20;
export const LIST_MAX = 50;
export const LIST_MAX_BYTES = 3 * 1024 * 1024;
export const REACTIONS_MAX = 200;
export const REPORTS_TO_HIDE = 3;
/** K-8: the same cells again within this many seconds are refused. */
export const REFETCH_SECONDS = 240;
const REFETCH_AFTER = 300;
const TTLS = { '1h': 3600, '24h': 24 * 3600, '7d': 7 * 24 * 3600 } as const;
/** How long a note's author is kept after it expires, so it can still be blocked (ADR-MATERIALS D-43). */
const AUTHOR_KEEP_SECONDS = 7 * 24 * 3600;
const BLOCK_SECONDS = 365 * 24 * 3600;
const REPORT_KEEP_SECONDS = 30 * 24 * 3600;
const STATS_KEEP_SECONDS = 120 * 24 * 3600;
const AREA_CACHE_MS = 5 * 60 * 1000;
const REASONS = ['danger', 'harassment', 'ad', 'rights', 'inappropriate', 'other'] as const;
/** Reasons that stop a studio at the first report (platform policies/studio-rules.md 4.1). */
const STOPPING_REASONS = new Set(['danger', 'rights']);
const BUCKETS = [1000, 300, 100, 30, 10, 3];

const JST_MS = 9 * 3600 * 1000;
const dayOf = (now: Date) => new Date(now.getTime() + JST_MS).toISOString().slice(0, 10);
const monthOf = (now: Date) => dayOf(now).slice(0, 7);
function resetsAt(now: Date): string {
  const [y, m, d] = dayOf(now).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1) - JST_MS).toISOString();
}
const epoch = (date: Date) => Math.floor(date.getTime() / 1000);
const later = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64url');

const GEOHASH = /^[0123456789bcdefghjkmnpqrstuvwxyz]+$/;
const isCell = (value: unknown, length: number): value is string => typeof value === 'string' && value.length === length && GEOHASH.test(value);
const chars = (text: string) => [...text].length;

/** API-LOCAL-MATERIALS「概数」: hidden below 3, otherwise the lower end of its bucket. */
export function approx(n: number): { atLeast: number } | null {
  const bucket = BUCKETS.find((b) => n >= b);
  return bucket ? { atLeast: bucket } : null;
}

function isConditionFailure(e: unknown) {
  return e instanceof ConditionalCheckFailedException || (e as { name?: string })?.name === 'ConditionalCheckFailedException';
}
function isCancelled(e: unknown) {
  return e instanceof TransactionCanceledException || (e as { name?: string })?.name === 'TransactionCanceledException';
}

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new LocalError('invalid_request', 'The body must be a JSON object');
  return body as Record<string, unknown>;
}

/** The relay's install hash a bearer token stands for (ST-2). */
async function installOf(ports: LocalPorts, authorization: string | undefined): Promise<string> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  if (!token) throw new LocalError('token_invalid', 'A bearer token is required');
  const item = (await ports.db.send(new GetCommand({ TableName: ports.relayTable, Key: { PK: `TOKEN#${sha256(token)}`, SK: 'TOKEN' } }))).Item;
  if (!item || String(item.expiresAt) <= ports.now().toISOString()) throw new LocalError('token_invalid', 'The token is unknown or expired');
  return String(item.install);
}

async function running(ports: LocalPorts): Promise<LocalSettings> {
  const settings = await ports.settings();
  if (settings.paused) throw new LocalError('local_paused', 'The studio is paused');
  return settings;
}

// ---- GET /v1/local/cells ----

interface NoteCopy {
  id: string;
  text: string;
  cell: string;
  spotName?: string;
  expiresAt: string;
  author: string;
  state: string;
  likes?: number;
}

interface StudioCopy {
  id: string;
  providerName: string;
  category: string;
  text: string;
  audio?: { key: string; durationSec: number; bytes: number; contentType: string; sha256: string };
  cells: string[];
  startsAt: string;
  endsAt: string;
  hours?: { from: string; to: string };
}

export async function cells(ports: LocalPorts, authorization: string | undefined, query: Record<string, string | undefined>) {
  await running(ports);
  const install = await installOf(ports, authorization);
  const asked = (query.cells ?? '').split(',').filter((c) => c !== '');
  if (asked.length === 0 || asked.length > 9 || !asked.every((c) => isCell(c, 6))) throw new LocalError('invalid_request', 'cells must be 1 to 9 geohash6, comma separated');
  const wanted = new Set(asked);
  const kinds = new Set((query.kinds ?? 'note,studio').split(','));
  if (kinds.size === 0 || [...kinds].some((k) => k !== 'note' && k !== 'studio')) throw new LocalError('invalid_request', 'kinds must be note, studio or both');

  const now = ports.now();
  await limitRefetch(ports, install, [...wanted].sort().join(','), now);

  const blocked = kinds.has('note') ? await blockedAuthors(ports, install, now) : new Set<string>();
  const nowIso = now.toISOString();
  const notes: NoteCopy[] = [];
  const studios = new Map<string, StudioCopy>();
  await Promise.all(
    [...wanted].map(async (cell) => {
      for (const item of await queryAll(ports, { PK: `CELL#${cell}` })) {
        const sk = String(item.SK);
        if (sk.startsWith('N#') && kinds.has('note')) {
          const note = item as unknown as NoteCopy;
          if (note.state === 'active' && note.expiresAt > nowIso && !blocked.has(note.author)) notes.push(note);
        } else if (sk.startsWith('P#') && kinds.has('studio')) {
          const p = item as unknown as StudioCopy;
          if (p.startsAt <= nowIso && p.endsAt > nowIso) studios.set(p.id, p);
        }
      }
    }),
  );

  // F-4: at most 20 notes per geohash7; the ones closest to expiring go first.
  const byCell = new Map<string, NoteCopy[]>();
  for (const n of notes) byCell.set(n.cell, [...(byCell.get(n.cell) ?? []), n]);
  const keptNotes = [...byCell.values()]
    .flatMap((list) => list.sort((a, b) => b.expiresAt.localeCompare(a.expiresAt)).slice(0, NOTES_PER_CELL))
    .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0) || b.id.localeCompare(a.id));
  const sortedStudios = [...studios.values()].sort((a, b) => a.cells.length - b.cells.length || a.endsAt.localeCompare(b.endsAt));

  // Studios first, as long as their audio fits in 3 MB; notes fill the rest of the 50.
  const outStudios = [];
  let bytes = 0;
  for (const p of sortedStudios) {
    if (outStudios.length >= LIST_MAX) break;
    const size = (p.audio?.bytes ?? 0) + 1024;
    if (bytes + size > LIST_MAX_BYTES) continue;
    bytes += size;
    outStudios.push({
      id: p.id,
      providerName: p.providerName,
      category: p.category,
      text: p.text,
      ...(p.audio
        ? { audio: { url: `${ports.audioBase}/${p.audio.key}`, durationSec: p.audio.durationSec, bytes: p.audio.bytes, contentType: p.audio.contentType, sha256: p.audio.sha256 } }
        : {}),
      cells: p.cells,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      ...(p.hours ? { hours: p.hours } : {}),
    });
  }
  const outNotes = keptNotes.slice(0, LIST_MAX - outStudios.length).map((n) => ({
    id: n.id,
    text: n.text,
    cell: n.cell,
    ...(n.spotName ? { spotName: n.spotName } : {}),
    expiresAt: n.expiresAt,
    mine: n.author === install,
  }));
  ports.metric('Fetches', 1);
  return { notes: outNotes, studios: outStudios, fetchedAt: nowIso, refetchAfterSec: REFETCH_AFTER };
}

async function limitRefetch(ports: LocalPorts, install: string, cellSet: string, now: Date) {
  const key = { PK: `FETCH#${install}`, SK: 'LAST' };
  const last = (await ports.db.send(new GetCommand({ TableName: ports.table, Key: key }))).Item;
  if (last && last.cells === sha256(cellSet) && Number(last.at) > now.getTime() - REFETCH_SECONDS * 1000) {
    throw new LocalError('too_many_requests', 'The same cells were fetched a moment ago');
  }
  await ports.db.send(new PutCommand({ TableName: ports.table, Item: { ...key, cells: sha256(cellSet), at: now.getTime(), ttl: epoch(later(now, 600)) } }));
}

async function blockedAuthors(ports: LocalPorts, install: string, now: Date): Promise<Set<string>> {
  const nowIso = now.toISOString();
  return new Set((await queryAll(ports, { PK: `BLOCKS#${install}` })).filter((b) => String(b.expiresAt) > nowIso).map((b) => String(b.target)));
}

async function queryAll(ports: LocalPorts, key: { PK: string }, index?: { name: string; after?: string }): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const out = await ports.db.send(
      new QueryCommand({
        TableName: ports.table,
        ...(index
          ? {
              IndexName: index.name,
              KeyConditionExpression: index.after ? 'GSI1PK = :pk AND GSI1SK > :after' : 'GSI1PK = :pk',
              ExpressionAttributeValues: { ':pk': key.PK, ...(index.after ? { ':after': index.after } : {}) },
            }
          : { KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': key.PK } }),
        ExclusiveStartKey: start,
      }),
    );
    items.push(...((out.Items ?? []) as Record<string, unknown>[]));
    start = out.LastEvaluatedKey;
  } while (start);
  return items;
}

// ---- POST /v1/local/notes ----

let areaCache: { table: string; prefixes: string[]; until: number } | undefined;

async function closedAreas(ports: LocalPorts): Promise<string[]> {
  if (areaCache && areaCache.table === ports.table && areaCache.until > Date.now()) return areaCache.prefixes;
  const prefixes = (await queryAll(ports, { PK: 'AREA' })).map((a) => String(a.SK));
  areaCache = { table: ports.table, prefixes, until: Date.now() + AREA_CACHE_MS };
  return prefixes;
}

/** Forgets the cached closed areas (tests, and the operator's console after an edit). */
export function forgetAreas() {
  areaCache = undefined;
}

export async function placeNote(ports: LocalPorts, authorization: string | undefined, body: unknown) {
  const settings = await running(ports);
  const install = await installOf(ports, authorization);
  const { text, cell, spotName, ttl, termsVersion } = object(body);
  if (typeof text !== 'string' || text.trim() === '' || /[\r\n]/.test(text)) throw new LocalError('invalid_request', 'text must be one line');
  if (chars(text) > NOTE_MAX_CHARS) throw new LocalError('text_too_long', `text is up to ${NOTE_MAX_CHARS} characters`);
  if (!isCell(cell, 7)) throw new LocalError('invalid_request', 'cell must be a geohash7');
  if (spotName !== undefined && (typeof spotName !== 'string' || chars(spotName) > SPOT_MAX_CHARS || /[\r\n]/.test(spotName))) {
    throw new LocalError('invalid_request', `spotName is one line of up to ${SPOT_MAX_CHARS} characters`);
  }
  if (typeof ttl !== 'string' || !(ttl in TTLS)) throw new LocalError('invalid_request', 'ttl must be 1h, 24h or 7d');
  if (!Number.isInteger(termsVersion) || (termsVersion as number) < settings.termsVersion) {
    throw new LocalError('terms_not_accepted', 'The current note terms have not been accepted');
  }

  const now = ports.now();
  const ban = (await ports.db.send(new GetCommand({ TableName: ports.table, Key: { PK: `BAN#${install}`, SK: 'BAN' } }))).Item;
  if (ban && (!ban.until || String(ban.until) > now.toISOString())) {
    throw new LocalError('author_banned', 'This device may not place notes', ban.until ? { until: String(ban.until) } : {});
  }
  if ((await closedAreas(ports)).some((prefix) => cell.startsWith(prefix))) throw new LocalError('area_closed', 'Notes cannot be placed here');

  const spendKey = { PK: 'SPEND', SK: `MONTH#${monthOf(now)}` };
  const spent = Number((await ports.db.send(new GetCommand({ TableName: ports.relayTable, Key: spendKey }))).Item?.microUsd ?? 0) / 1e6;
  if (spent >= settings.monthlyBudgetUsd) {
    ports.metric('RelayPaused', 1);
    throw new LocalError('relay_paused', 'The operator’s AI is paused for this month');
  }

  // Take one of today's ten before checking, so parallel notes can't pass the limit. A rejected
  // note still counts, so the check can't be probed for free; a failing service gives it back.
  const countKey = { PK: `NOTES#${install}`, SK: `DAY#${dayOf(now)}` };
  let used: number;
  try {
    const out = await ports.db.send(
      new UpdateCommand({
        TableName: ports.table,
        Key: countKey,
        UpdateExpression: 'ADD #n :one SET #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
        ExpressionAttributeNames: { '#n': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':max': NOTES_PER_DAY, ':ttl': epoch(later(now, 2 * 24 * 3600)) },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    used = Number(out.Attributes?.count ?? 1);
  } catch (e) {
    if (isConditionFailure(e)) throw new LocalError('daily_note_limit', 'Today’s notes are used up', { resetsAt: resetsAt(now) });
    throw e;
  }

  let ok: boolean;
  if (hasContact(text) || (spotName !== undefined && hasContact(spotName))) {
    ok = false;
    ports.metric('NoteContact', 1);
  } else {
    let reply: CheckReply;
    try {
      reply = await ports.check(settings.model, NOTE_CHECK_SYSTEM, noteCheckUser(text, spotName as string | undefined));
    } catch (e) {
      await ports.db.send(
        new UpdateCommand({ TableName: ports.table, Key: countKey, UpdateExpression: 'ADD #n :minus', ExpressionAttributeNames: { '#n': 'count' }, ExpressionAttributeValues: { ':minus': -1 } }),
      );
      ports.metric('UpstreamError', 1);
      console.error(JSON.stringify({ event: 'upstream_error', model: settings.model.id, error: (e as Error)?.name, message: String((e as Error)?.message).slice(0, 300) }));
      throw new LocalError('upstream_error', 'The note could not be checked');
    }
    const microUsd = Math.ceil(reply.inputTokens * settings.model.price.inputPerMTok + reply.outputTokens * settings.model.price.outputPerMTok);
    await ports.db.send(new UpdateCommand({ TableName: ports.relayTable, Key: spendKey, UpdateExpression: 'ADD microUsd :c', ExpressionAttributeValues: { ':c': microUsd } }));
    ok = readVerdict(reply.text).ok;
  }
  if (!ok) {
    ports.metric('NoteRejected', 1);
    throw new LocalError('note_rejected', 'The note could not be placed');
  }

  const id = ports.id();
  const expires = later(now, TTLS[ttl as keyof typeof TTLS]);
  const expiresAt = expires.toISOString();
  const copy = { id, text, cell, ...(spotName ? { spotName } : {}), expiresAt, author: install, state: 'active', likes: 0 };
  await ports.db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: ports.table,
            Item: { PK: `NOTE#${id}`, SK: 'NOTE', GSI1PK: `AUTHOR#${install}`, GSI1SK: expiresAt, ...copy, reports: 0, createdAt: now.toISOString(), ttl: epoch(later(expires, AUTHOR_KEEP_SECONDS)) },
          },
        },
        { Put: { TableName: ports.table, Item: { PK: `CELL#${cell.slice(0, 6)}`, SK: `N#${id}`, ...copy, ttl: epoch(expires) } } },
      ],
    }),
  );
  ports.metric('NotesPlaced', 1);
  console.log(JSON.stringify({ event: 'note', ttl, chars: chars(text) }));
  return { id, expiresAt, remainingToday: Math.max(0, NOTES_PER_DAY - used) };
}

// ---- GET /v1/local/notes/mine, DELETE /v1/local/notes/{id} ----

async function heardOf(ports: LocalPorts, id: string): Promise<number> {
  return (await queryAll(ports, { PK: `STATS#${id}` })).reduce((sum, day) => sum + Number(day.heard ?? 0), 0);
}

export async function myNotes(ports: LocalPorts, authorization: string | undefined) {
  const install = await installOf(ports, authorization);
  const now = ports.now();
  const items = await queryAll(ports, { PK: `AUTHOR#${install}` }, { name: 'GSI1', after: now.toISOString() });
  const notes = await Promise.all(
    items
      .filter((n) => n.state !== 'deleted')
      .sort((a, b) => String(b.id).localeCompare(String(a.id)))
      .map(async (n) => ({
        id: String(n.id),
        text: String(n.text),
        cell: String(n.cell),
        ...(n.spotName ? { spotName: String(n.spotName) } : {}),
        expiresAt: String(n.expiresAt),
        state: String(n.state),
        heard: approx(await heardOf(ports, String(n.id))),
        likes: approx(Number(n.likes ?? 0)),
      })),
  );
  const count = (await ports.db.send(new GetCommand({ TableName: ports.table, Key: { PK: `NOTES#${install}`, SK: `DAY#${dayOf(now)}` } }))).Item?.count;
  return { notes, remainingToday: Math.max(0, NOTES_PER_DAY - Number(count ?? 0)) };
}

export async function deleteNote(ports: LocalPorts, authorization: string | undefined, id: string | undefined) {
  const install = await installOf(ports, authorization);
  const now = ports.now();
  const note = id ? (await ports.db.send(new GetCommand({ TableName: ports.table, Key: { PK: `NOTE#${id}`, SK: 'NOTE' } }))).Item : undefined;
  if (!note || note.author !== install || String(note.expiresAt) <= now.toISOString() || note.state === 'deleted') throw new LocalError('not_found', 'No such note of yours');
  // The text goes; the author stays until the note's own time is up, so it can still be blocked.
  await ports.db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: ports.table,
            Key: { PK: `NOTE#${id}`, SK: 'NOTE' },
            UpdateExpression: 'SET #s = :deleted REMOVE #t, spotName, GSI1PK, GSI1SK',
            ExpressionAttributeNames: { '#s': 'state', '#t': 'text' },
            ExpressionAttributeValues: { ':deleted': 'deleted' },
          },
        },
        { Delete: { TableName: ports.table, Key: { PK: `CELL#${String(note.cell).slice(0, 6)}`, SK: `N#${id}` } } },
      ],
    }),
  );
}

// ---- POST /v1/local/reactions ----

type ItemType = 'note' | 'studio';
const keyOf = (type: ItemType, id: string) => (type === 'note' ? { PK: `NOTE#${id}`, SK: 'NOTE' } : { PK: `STUDIO#${id}`, SK: 'STUDIO' });
const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9A-Z]{26}$/.test(value);

function refs(value: unknown, name: string): { type: ItemType; id: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new LocalError('invalid_request', `${name} must be a list`);
  return value.map((r) => {
    const { type, id } = (r ?? {}) as { type?: unknown; id?: unknown };
    if ((type !== 'note' && type !== 'studio') || !isId(id)) throw new LocalError('invalid_request', `${name} holds { type, id }`);
    return { type, id };
  });
}

async function existing(ports: LocalPorts, wanted: { type: ItemType; id: string }[]): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  const unique = [...new Map(wanted.map((w) => [`${w.type}:${w.id}`, w])).values()];
  for (let i = 0; i < unique.length; i += 100) {
    const out = await ports.db.send(new BatchGetCommand({ RequestItems: { [ports.table]: { Keys: unique.slice(i, i + 100).map((w) => keyOf(w.type, w.id)) } } }));
    for (const item of out.Responses?.[ports.table] ?? []) found.set(`${item.PK}`, item);
  }
  return found;
}

export async function reactions(ports: LocalPorts, authorization: string | undefined, body: unknown) {
  const install = await installOf(ports, authorization);
  const b = object(body);
  const heard = refs(b.heard, 'heard');
  const opened = refs(b.opened, 'opened');
  const liked = b.liked === undefined ? [] : b.liked;
  if (!Array.isArray(liked) || !liked.every(isId)) throw new LocalError('invalid_request', 'liked must be a list of note ids');
  if (heard.length + opened.length + liked.length > REACTIONS_MAX) throw new LocalError('invalid_request', `At most ${REACTIONS_MAX} reactions at a time`);

  const now = ports.now();
  const items = await existing(ports, [...heard, ...opened, ...liked.map((id) => ({ type: 'note' as const, id }))]);
  const live = (type: ItemType, id: string) => {
    const item = items.get(keyOf(type, id).PK);
    return item && item.state !== 'deleted' ? item : undefined;
  };
  const day = dayOf(now);
  const count = async (field: 'heard' | 'opened', list: { type: ItemType; id: string }[]) => {
    for (const { type, id } of new Map(list.map((r) => [r.id, r])).values()) {
      if (!live(type, id)) continue;
      await ports.db.send(
        new UpdateCommand({
          TableName: ports.table,
          Key: { PK: `STATS#${id}`, SK: `DAY#${day}` },
          UpdateExpression: 'ADD #f :one SET #ttl = :ttl',
          ExpressionAttributeNames: { '#f': field, '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':ttl': epoch(later(now, STATS_KEEP_SECONDS)) },
        }),
      );
    }
  };
  await count('heard', heard);
  await count('opened', opened);
  for (const id of new Set(liked)) {
    const note = live('note', id);
    if (!note || note.state !== 'active') continue;
    try {
      await ports.db.send(
        new PutCommand({
          TableName: ports.table,
          Item: { PK: `SEEN#${id}`, SK: `LIKE#${install}`, ttl: epoch(new Date(String(note.expiresAt))) },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (e) {
      if (isConditionFailure(e)) continue;
      throw e;
    }
    // The cell's copy carries the likes too, to order the list (API-LOCAL-MATERIALS).
    await ports.db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: ports.table, Key: { PK: `NOTE#${id}`, SK: 'NOTE' }, UpdateExpression: 'ADD likes :one', ExpressionAttributeValues: { ':one': 1 } } },
          {
            Update: {
              TableName: ports.table,
              Key: { PK: `CELL#${String(note.cell).slice(0, 6)}`, SK: `N#${id}` },
              UpdateExpression: 'ADD likes :one',
              ConditionExpression: 'attribute_exists(PK)',
              ExpressionAttributeValues: { ':one': 1 },
            },
          },
        ],
      }),
    ).catch((e) => {
      if (!isCancelled(e)) throw e;
    });
  }
  // Totals only: who sent them is not kept (ST-5).
  ports.metric('Reactions', heard.length + opened.length + liked.length);
}

// ---- POST /v1/local/reports ----

export async function report(ports: LocalPorts, authorization: string | undefined, body: unknown) {
  const install = await installOf(ports, authorization);
  const { type, id, reason } = object(body);
  if ((type !== 'note' && type !== 'studio') || !isId(id)) throw new LocalError('invalid_request', 'type and id are required');
  if (typeof reason !== 'string' || !(REASONS as readonly string[]).includes(reason)) throw new LocalError('invalid_request', `reason must be one of ${REASONS.join(', ')}`);
  const now = ports.now();
  const item = (await ports.db.send(new GetCommand({ TableName: ports.table, Key: keyOf(type, id) }))).Item;
  if (!item || item.state === 'deleted') return;
  try {
    await ports.db.send(
      new PutCommand({
        TableName: ports.table,
        Item: { PK: `SEEN#${id}`, SK: `REPORT#${install}`, reason, ttl: epoch(later(now, REPORT_KEEP_SECONDS)) },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (e) {
    if (isConditionFailure(e)) return;
    throw e;
  }
  const out = await ports.db.send(new UpdateCommand({ TableName: ports.table, Key: keyOf(type, id), UpdateExpression: 'ADD reports :one', ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'UPDATED_NEW' }));
  const reports = Number(out.Attributes?.reports ?? 1);
  ports.metric('Reports', 1);
  // One entry per note or studio in the operator's queue: the first report's time, and every reason given.
  const queued = (queue: string) => ({
    Update: {
      TableName: ports.table,
      Key: { PK: `QUEUE#${queue}`, SK: id },
      UpdateExpression: 'SET #t = :type, firstAt = if_not_exists(firstAt, :now), lastAt = :now ADD reasons :reason',
      ExpressionAttributeNames: { '#t': 'type' },
      ExpressionAttributeValues: { ':type': type, ':now': now.toISOString(), ':reason': new Set([reason]) },
    },
  });

  if (type === 'note') {
    if (reports < REPORTS_TO_HIDE || item.state !== 'active') return;
    // F-13: hidden from everyone until the operator looks.
    await ports.db
      .send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: ports.table,
                Key: keyOf('note', id),
                UpdateExpression: 'SET #s = :hidden',
                ConditionExpression: '#s = :active',
                ExpressionAttributeNames: { '#s': 'state' },
                ExpressionAttributeValues: { ':hidden': 'hidden', ':active': 'active' },
              },
            },
            {
              Update: {
                TableName: ports.table,
                Key: { PK: `CELL#${String(item.cell).slice(0, 6)}`, SK: `N#${id}` },
                UpdateExpression: 'SET #s = :hidden',
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeNames: { '#s': 'state' },
                ExpressionAttributeValues: { ':hidden': 'hidden' },
              },
            },
            queued('REPORTED_NOTE'),
          ],
        }),
      )
      .catch((e) => {
        if (!isCancelled(e)) throw e;
      });
    ports.metric('NotesHidden', 1);
    return;
  }

  // Studios: every report reaches the operator; three, or one about safety or rights, stop it
  // (platform policies/studio-rules.md 4.1).
  const stop = item.state === 'live' && (reports >= REPORTS_TO_HIDE || STOPPING_REASONS.has(reason));
  if (!stop) {
    await ports.db.send(new TransactWriteCommand({ TransactItems: [queued('REPORTED_STUDIO')] }));
    return;
  }
  await ports.db
    .send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ports.table,
              Key: keyOf('studio', id),
              UpdateExpression: 'SET #s = :suspended',
              ConditionExpression: '#s = :live',
              ExpressionAttributeNames: { '#s': 'state' },
              ExpressionAttributeValues: { ':suspended': 'suspended', ':live': 'live' },
            },
          },
          ...((item.cells as string[]) ?? []).map((cell) => ({ Delete: { TableName: ports.table, Key: { PK: `CELL#${cell}`, SK: `P#${id}` } } })),
          queued('REPORTED_STUDIO'),
        ],
      }),
    )
    .catch((e) => {
      if (!isCancelled(e)) throw e;
    });
  ports.metric('StudiosSuspended', 1);
}

// ---- blocks ----

export async function block(ports: LocalPorts, authorization: string | undefined, body: unknown) {
  const install = await installOf(ports, authorization);
  const { noteId } = object(body);
  if (!isId(noteId)) throw new LocalError('invalid_request', 'noteId is required');
  const now = ports.now();
  const note = (await ports.db.send(new GetCommand({ TableName: ports.table, Key: keyOf('note', noteId) }))).Item;
  if (!note || later(new Date(String(note.expiresAt)), AUTHOR_KEEP_SECONDS) <= now) throw new LocalError('not_found', 'No such note');
  if (note.author === install) throw new LocalError('invalid_request', 'Your own note cannot be blocked');
  const id = `blk_${ports.id()}`;
  const expires = later(now, BLOCK_SECONDS);
  await ports.db.send(
    new PutCommand({
      TableName: ports.table,
      Item: { PK: `BLOCKS#${install}`, SK: `B#${id}`, id, target: note.author, createdAt: now.toISOString(), expiresAt: expires.toISOString(), ttl: epoch(expires) },
    }),
  );
  ports.metric('Blocks', 1);
  return { id, createdAt: now.toISOString() };
}

export async function blocks(ports: LocalPorts, authorization: string | undefined) {
  const install = await installOf(ports, authorization);
  const nowIso = ports.now().toISOString();
  const list = (await queryAll(ports, { PK: `BLOCKS#${install}` }))
    .filter((b) => String(b.expiresAt) > nowIso)
    .map((b) => ({ id: String(b.id), createdAt: String(b.createdAt), expiresAt: String(b.expiresAt) }));
  return { blocks: list };
}

export async function unblock(ports: LocalPorts, authorization: string | undefined, id: string | undefined) {
  const install = await installOf(ports, authorization);
  if (!id) throw new LocalError('not_found', 'No such block');
  try {
    await ports.db.send(new DeleteCommand({ TableName: ports.table, Key: { PK: `BLOCKS#${install}`, SK: `B#${id}` }, ConditionExpression: 'attribute_exists(PK)' }));
  } catch (e) {
    if (isConditionFailure(e)) throw new LocalError('not_found', 'No such block');
    throw e;
  }
}

// ---- GET /v1/local/terms ----

export async function terms(ports: LocalPorts) {
  const { termsVersion, termsUrl, termsUpdatedAt } = await ports.settings();
  return { version: termsVersion, url: termsUrl, updatedAt: termsUpdatedAt };
}
