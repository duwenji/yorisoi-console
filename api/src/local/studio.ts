import { createHash } from 'node:crypto';
import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { hasContact, STUDIO_CHECK_SYSTEM, studioCheckUser, readStudioVerdict } from './check.js';
import type { CheckReply, ModelChoice, LocalSettings } from './local.js';

/**
 * The check before a studio goes up (platform REQ-STUDIO D-18, DES-013 K-11): its form, the
 * audio written out by Amazon Transcribe, then the operator's AI against the studio rules. A
 * studio that passes goes up at once; one that doesn't goes back to its provider with the
 * rules it hit. Going up is done here only, for the check and for an appeal the operator accepts.
 */

export interface StudioPorts {
  db: DynamoDBDocumentClient;
  table: string;
  relayTable: string;
  now: () => Date;
  settings: () => Promise<LocalSettings>;
  check: (model: ModelChoice, system: string, user: string) => Promise<CheckReply>;
  /** The intake bucket: uploads (1 day), held audio and transcripts (30 days). */
  intake: {
    head: (key: string) => Promise<{ bytes: number } | undefined>;
    read: (key: string) => Promise<Uint8Array>;
    copy: (from: string, to: string) => Promise<void>;
    text: (key: string) => Promise<string | undefined>;
  };
  /** Copies checked audio from the intake bucket to the served one (K-5). */
  serveAudio: (from: string, to: string) => Promise<void>;
  /** Starts a Transcribe job on an intake object, writing its result to another intake key. */
  transcribe: (jobName: string, mediaKey: string, outputKey: string) => Promise<void>;
  /** Names this stack's Transcribe jobs, so the rule only hands back its own. */
  jobPrefix: string;
  metric: (name: string, value: number) => void;
}

export const AUDIO_MAX_BYTES = 512 * 1024;
export const AUDIO_MAX_SECONDS = 30;

export const uploadKey = (id: string) => `uploads/${id}.m4a`;
const heldKey = (id: string) => `held/${id}.m4a`;
const transcriptKey = (id: string) => `transcripts/${id}.json`;
const servedKey = (id: string) => `studios/${id}/audio.m4a`;

const epoch = (date: Date) => Math.floor(date.getTime() / 1000);
const JST_MS = 9 * 3600 * 1000;
const monthOf = (now: Date) => new Date(now.getTime() + JST_MS).toISOString().slice(0, 7);

/**
 * The length of an MP4/M4A file in seconds, from its movie header (`mvhd`); undefined when the
 * file isn't one.
 */
export function mp4Seconds(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(4) !== 'ftyp') return undefined;
  for (let i = 8; i + 32 <= bytes.length; i++) {
    if (bytes[i] !== 0x6d || tag(i) !== 'mvhd') continue;
    const version = bytes[i + 4];
    if (version === 0) return view.getUint32(i + 20) / view.getUint32(i + 16);
    if (version === 1 && i + 40 <= bytes.length) return Number(view.getBigUint64(i + 28)) / view.getUint32(i + 24);
    return undefined;
  }
  return undefined;
}

async function load(ports: StudioPorts, id: string) {
  return (await ports.db.send(new GetCommand({ TableName: ports.table, Key: { PK: `STUDIO#${id}`, SK: 'STUDIO' }, ConsistentRead: true }))).Item;
}

/** Back to its provider, with the rules (or form problems) it hit. */
async function returnToProvider(ports: StudioPorts, id: string, items: string[], extra: { transcript?: string } = {}) {
  const now = ports.now().toISOString();
  await ports.db.send(
    new UpdateCommand({
      TableName: ports.table,
      Key: { PK: `STUDIO#${id}`, SK: 'STUDIO' },
      UpdateExpression: 'SET #s = :returned, #c = :check, updatedAt = :now, rev = rev + :one',
      ConditionExpression: '#s = :checking',
      ExpressionAttributeNames: { '#s': 'state', '#c': 'check' },
      ExpressionAttributeValues: { ':returned': 'returned', ':checking': 'checking', ':check': { items, checkedAt: now, ...extra }, ':now': now, ':one': 1 },
    }),
  );
  ports.metric('StudiosReturned', 1);
}

/** Starts the check of a studio the provider has just put up (`checking`). */
export async function startCheck(ports: StudioPorts, id: string) {
  const studio = await load(ports, id);
  if (!studio || studio.state !== 'checking') return;
  if (!studio.audio) return judge(ports, studio);

  const head = await ports.intake.head(uploadKey(id));
  if (!head) return returnToProvider(ports, id, ['audio_missing']);
  if (head.bytes > AUDIO_MAX_BYTES) return returnToProvider(ports, id, ['audio_format']);
  const bytes = await ports.intake.read(uploadKey(id));
  const seconds = mp4Seconds(bytes);
  if (seconds === undefined) return returnToProvider(ports, id, ['audio_format']);
  if (seconds > AUDIO_MAX_SECONDS + 0.5) return returnToProvider(ports, id, ['audio_length']);

  // Held for 30 days, so an appeal decided later can still put it up.
  await ports.intake.copy(uploadKey(id), heldKey(id));
  const audio = { key: heldKey(id), durationSec: Math.round(seconds * 10) / 10, bytes: bytes.length, contentType: 'audio/mp4', sha256: createHash('sha256').update(bytes).digest('hex') };
  const jobName = `${ports.jobPrefix}${id}-${epoch(ports.now())}`;
  await ports.db.send(
    new UpdateCommand({
      TableName: ports.table,
      Key: { PK: `STUDIO#${id}`, SK: 'STUDIO' },
      UpdateExpression: 'SET audio = :audio, jobName = :job, updatedAt = :now, rev = rev + :one',
      ConditionExpression: '#s = :checking',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':audio': audio, ':job': jobName, ':now': ports.now().toISOString(), ':one': 1, ':checking': 'checking' },
    }),
  );
  await ports.transcribe(jobName, heldKey(id), transcriptKey(id));
  ports.metric('TranscribeSeconds', seconds);
}

/** The end of a Transcribe job this stack started (EventBridge, K-11). */
export async function finishTranscription(ports: StudioPorts, jobName: string, status: string) {
  const id = new RegExp(`^${ports.jobPrefix}([0-9A-Z]{26})-\\d+$`).exec(jobName)?.[1];
  if (!id) return;
  const studio = await load(ports, id);
  if (!studio || studio.state !== 'checking' || studio.jobName !== jobName) return;
  if (status !== 'COMPLETED') return returnToProvider(ports, id, ['transcribe_failed']);
  const raw = await ports.intake.text(transcriptKey(id));
  const transcript = raw ? ((JSON.parse(raw) as { results?: { transcripts?: { transcript?: string }[] } }).results?.transcripts ?? []).map((t) => t.transcript ?? '').join('') : '';
  return judge(ports, studio, transcript);
}

async function judge(ports: StudioPorts, studio: Record<string, unknown>, transcript?: string) {
  const id = String(studio.id);
  const text = String(studio.text);
  const kept = transcript !== undefined ? { transcript } : {};
  if (hasContact(text) || (transcript !== undefined && hasContact(transcript))) return returnToProvider(ports, id, ['2.2.2'], kept);

  const settings = await ports.settings();
  const now = ports.now();
  const spendKey = { PK: 'SPEND', SK: `MONTH#${monthOf(now)}` };
  const spent = Number((await ports.db.send(new GetCommand({ TableName: ports.relayTable, Key: spendKey }))).Item?.microUsd ?? 0) / 1e6;
  if (spent >= settings.monthlyBudgetUsd) return returnToProvider(ports, id, ['check_unavailable'], kept);

  let reply: CheckReply;
  try {
    reply = await ports.check(settings.model, STUDIO_CHECK_SYSTEM, studioCheckUser({ providerName: String(studio.providerName), category: String(studio.category), text, ...kept }));
  } catch (e) {
    ports.metric('UpstreamError', 1);
    console.error(JSON.stringify({ event: 'upstream_error', model: settings.model.id, error: (e as Error)?.name }));
    return returnToProvider(ports, id, ['check_unavailable'], kept);
  }
  const microUsd = Math.ceil(reply.inputTokens * settings.model.price.inputPerMTok + reply.outputTokens * settings.model.price.outputPerMTok);
  await ports.db.send(new UpdateCommand({ TableName: ports.relayTable, Key: spendKey, UpdateExpression: 'ADD microUsd :c', ExpressionAttributeValues: { ':c': microUsd } }));

  const verdict = readStudioVerdict(reply.text);
  if (!verdict.ok) return returnToProvider(ports, id, verdict.items.length > 0 ? verdict.items : ['unclear'], kept);
  return goLive(ports, id, 'checking', { items: [], checkedAt: now.toISOString(), ...kept });
}

/**
 * Puts a studio up: its audio to the served bucket, and a copy into each of its cells (K-7).
 * From `checking` after a clean check, or from `appealed` when the operator accepts the appeal.
 */
export async function goLive(ports: StudioPorts, id: string, from: 'checking' | 'appealed', check?: Record<string, unknown>) {
  const studio = await load(ports, id);
  if (!studio || studio.state !== from) return;
  const now = ports.now();
  const audio = studio.audio as { key: string; durationSec: number; bytes: number; contentType: string; sha256: string } | undefined;
  const served = audio ? { ...audio, key: servedKey(id) } : undefined;
  if (audio && served) await ports.serveAudio(audio.key, served.key);
  const cells = studio.cells as string[];
  const copy = {
    id,
    providerName: studio.providerName,
    category: studio.category,
    text: studio.text,
    ...(served ? { audio: served } : {}),
    cells,
    startsAt: studio.startsAt,
    endsAt: studio.endsAt,
    ...(studio.hours ? { hours: studio.hours } : {}),
    ttl: epoch(new Date(String(studio.endsAt))),
  };
  await ports.db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: ports.table,
            Key: { PK: `STUDIO#${id}`, SK: 'STUDIO' },
            UpdateExpression: `SET #s = :live, liveAt = :now, updatedAt = :now, rev = rev + :one${served ? ', audio = :audio' : ''}${check ? ', #c = :check' : ''}`,
            ConditionExpression: '#s = :from',
            ExpressionAttributeNames: { '#s': 'state', ...(check ? { '#c': 'check' } : {}) },
            ExpressionAttributeValues: {
              ':live': 'live', ':from': from, ':now': now.toISOString(), ':one': 1,
              ...(served ? { ':audio': served } : {}), ...(check ? { ':check': check } : {}),
            },
          },
        },
        ...cells.map((cell) => ({ Put: { TableName: ports.table, Item: { PK: `CELL#${cell}`, SK: `P#${id}`, ...copy } } })),
      ],
    }),
  );
  ports.metric('StudiosLive', 1);
}
