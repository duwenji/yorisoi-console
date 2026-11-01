import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@yorisoi-console/api-types';
import { auditItem, notifyAfter, type Deps, type LocalDeps } from './deps.js';
import { fail, ifMatch, json, object, requireOperator, requiredText, text, withEtag, type Request, type Response } from './http.js';
import { myPublisher, transact } from './publisher.js';
import { isStudioCategory, STUDIO_CATEGORIES } from '@yorisoi-console/protocol';
import { get, loadPublisher, rolesOf, type Item } from './shared.js';
import { ulid } from './util.js';

// The studio in the console (DES-013 K-14〜K-17): providers apply to put up studios and make
// them; the operator approves providers and answers appeals. Studios live in the studio's own
// table (K-2); the check runs in the studio stack (K-11).

type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

/** The version of the studio rules (platform policies/studio-rules.md) providers agree to. */
export const STUDIO_RULES_VERSION = 2;
export const AUDIO_MAX_BYTES = 512 * 1024;
const DAY_MS = 24 * 3600_000;
const REAPPLY_AFTER_MS = 365 * DAY_MS;
const STUDIO_KEEP_MS = 90 * DAY_MS;
const LIST_MAX = 50;
const GEOHASH6 = /^[0123456789bcdefghjkmnpqrstuvwxyz]{6}$/;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function localOf(deps: Deps): LocalDeps {
  return deps.local ?? fail('not_found', 'the studio is not set up here');
}

// ---- the provider's approval (K-14) ----

const studioAccountKey = (publisherId: string) => ({ PK: `PUB#${publisherId}`, SK: 'STUDIO' });

/** The approval as the API shows it; before any application, `none` at rev 0. */
export function studioAccountView(publisherId: string, item: Item | undefined, now: Date): Schemas['StudioAccount'] {
  if (!item) return { publisherId, status: 'none', rev: 0 };
  // A suspension that has run out is shown, and treated, as approved.
  const lapsed = item.status === 'suspended' && item.suspendedUntil !== undefined && String(item.suspendedUntil) <= now.toISOString();
  const pick = (key: string) => (item[key] !== undefined ? { [key]: item[key] } : {});
  return {
    publisherId,
    status: (lapsed ? 'approved' : item.status) as Schemas['StudioStatus'],
    ...pick('displayName'), ...pick('description'), ...pick('plans'), ...pick('agreedVersion'), ...pick('requestedAt'), ...pick('decidedAt'),
    ...pick('reason'), ...pick('checks'), ...(lapsed ? {} : pick('suspendedUntil')), ...pick('reapplyAfter'),
    rev: Number(item.rev),
  } as Schemas['StudioAccount'];
}

export async function getMyStudio(deps: Deps, req: Request): Promise<Response> {
  const account = await myPublisher(deps, req);
  const publisherId = String(account.publisherId);
  return withEtag(200, studioAccountView(publisherId, await get(deps, studioAccountKey(publisherId).PK, 'STUDIO'), deps.now()));
}

/** Applies, or applies again after a decline or once a revocation's year is over (スタジオの決まり 1.1・1.2). Only a producer may (REQ-STUDIO D-14). */
export async function applyForStudio(deps: Deps, req: Request): Promise<Response> {
  const account = await myPublisher(deps, req);
  if (account.status !== 'active') fail('publisher_not_active', `the account is ${String(account.status)}`);
  if (!rolesOf(account).includes('producer')) fail('role_required', 'turn on the producer role first');
  const body = object(req.body);
  const displayName = requiredText(body, 'displayName', { max: 40 });
  const description = requiredText(body, 'description', { max: 1000 });
  const plans = requiredText(body, 'plans', { max: 1000 });
  const agreedVersion = body.agreedVersion;
  if (agreedVersion !== STUDIO_RULES_VERSION) fail('invalid_request', `agree to the studio rules, version ${STUDIO_RULES_VERSION}`);

  const publisherId = String(account.publisherId);
  const now = deps.now();
  const at = now.toISOString();
  const current = await get(deps, studioAccountKey(publisherId).PK, 'STUDIO');
  if (current) {
    const again = current.status === 'declined' || (current.status === 'revoked' && String(current.reapplyAfter) <= at);
    if (!again) fail('invalid_state', `the studio approval is ${String(current.status)}`);
  }
  const rev = Number(current?.rev ?? 0) + 1;
  await transact(
    deps,
    [
      {
        Put: {
          TableName: deps.table,
          Item: {
            ...studioAccountKey(publisherId), type: 'studio', publisherId, status: 'requested', displayName, description, plans, agreedVersion,
            requestedAt: at, rev, GSI2PK: 'QUEUE#STUDIO', GSI2SK: `${at}#${publisherId}`,
          },
          ConditionExpression: current ? 'rev = :rev' : 'attribute_not_exists(PK)',
          ...(current ? { ExpressionAttributeValues: { ':rev': current.rev } } : {}),
        },
      },
      auditItem(deps, req.caller, { action: 'studio.apply', target: `PUB#${publisherId}` }),
    ],
    { 0: ['precondition_failed', 'changed by someone else; read it again'] },
  );
  return withEtag(200, studioAccountView(publisherId, await get(deps, studioAccountKey(publisherId).PK, 'STUDIO'), now));
}

export async function listStudioApplications(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const out = await deps.db.send(
    new QueryCommand({ TableName: deps.table, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :q', ExpressionAttributeValues: { ':q': 'QUEUE#STUDIO' } }),
  );
  return json(200, { items: (out.Items ?? []).map((i) => studioAccountView(String(i.publisherId), i, deps.now())) });
}

export async function getPublisherStudio(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const publisherId = req.params.publisherId!;
  await loadPublisher(deps, publisherId);
  return withEtag(200, studioAccountView(publisherId, await get(deps, studioAccountKey(publisherId).PK, 'STUDIO'), deps.now()));
}

const DECISIONS = {
  approve: { from: ['requested'], to: 'approved', notice: 'studio.approved' },
  decline: { from: ['requested'], to: 'declined', notice: 'studio.declined' },
  suspend: { from: ['approved'], to: 'suspended', notice: 'studio.suspended' },
  resume: { from: ['suspended'], to: 'approved', notice: undefined },
  revoke: { from: ['approved', 'suspended'], to: 'revoked', notice: 'studio.revoked' },
} as const;

/** The operator decides on a provider (スタジオの決まり 1.4・4.3). Suspending or revoking takes their studios down. */
export async function decideStudio(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const publisherId = req.params.publisherId!;
  const decision = req.params.decision as keyof typeof DECISIONS;
  const rule = DECISIONS[decision] ?? fail('not_found', `no decision ${req.params.decision}`);
  await loadPublisher(deps, publisherId);
  const rev = ifMatch(req);
  const body = object(req.body ?? {});
  const message = text(body, 'message', { max: 1000, optional: true, min: 0 });
  const now = deps.now();
  const at = now.toISOString();
  const current = (await get(deps, studioAccountKey(publisherId).PK, 'STUDIO')) ?? fail('not_found', 'no application');
  if (current.rev !== rev) fail('precondition_failed', `the approval is at rev ${String(current.rev)}`);
  const status = studioAccountView(publisherId, current, now).status;
  if (!(rule.from as readonly string[]).includes(status)) fail('invalid_state', `the approval is ${status}`);

  const set: Record<string, unknown> = { status: rule.to, decidedAt: at };
  const remove = ['GSI2PK', 'GSI2SK'];
  if (decision === 'approve') {
    const checks = object(body.checks ?? {});
    const all = ['identity', 'name', 'content', 'history'].every((k) => checks[k] === true);
    if (!all) fail('invalid_request', 'all four checks of スタジオの決まり 1.3 are required to approve');
    set.checks = { identity: true, name: true, content: true, history: true };
    remove.push('reason');
  } else if (decision === 'resume') {
    remove.push('suspendedUntil', 'reason');
  } else {
    set.reason = requiredText(body, 'reason', { max: 1000 });
  }
  if (decision === 'suspend') {
    const until = requiredText(body, 'until', { max: 40 });
    const ms = Date.parse(until) - now.getTime();
    if (!(ms >= 28 * DAY_MS && ms <= 92 * DAY_MS)) fail('invalid_request', 'until must be one to three months ahead');
    set.suspendedUntil = new Date(Date.parse(until)).toISOString();
  }
  if (decision === 'revoke') {
    set.reapplyAfter = new Date(now.getTime() + REAPPLY_AFTER_MS).toISOString();
    remove.push('suspendedUntil');
  }

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':rev': rev, ':one': 1 };
  const sets = Object.entries(set).map(([k, v], i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = v;
    return `#k${i} = :v${i}`;
  });
  const removes = remove.map((k, i) => {
    names[`#r${i}`] = k;
    return `#r${i}`;
  });
  await transact(
    deps,
    [
      {
        Update: {
          TableName: deps.table,
          Key: studioAccountKey(publisherId),
          UpdateExpression: `SET ${sets.join(', ')}, rev = rev + :one REMOVE ${removes.join(', ')}`,
          ConditionExpression: 'rev = :rev',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      },
      auditItem(deps, req.caller, { action: `studio.${decision}`, target: `PUB#${publisherId}`, ...(set.reason ? { reason: String(set.reason) } : {}) }),
    ],
    { 0: ['precondition_failed', 'changed by someone else; read it again'] },
  );
  if (decision === 'suspend' || decision === 'revoke') await takeDown(deps, publisherId, decision === 'revoke' ? 'removed' : 'suspended');
  if (rule.notice) await notifyAfter(deps, { event: rule.notice, publisherId, ...(set.reason || message ? { message: String(set.reason ?? message) } : {}) });
  return withEtag(200, studioAccountView(publisherId, await get(deps, studioAccountKey(publisherId).PK, 'STUDIO'), now));
}

/** Takes every live studio of a provider out of the cells (スタジオの決まり 4.3). */
async function takeDown(deps: Deps, publisherId: string, to: 'suspended' | 'removed') {
  if (!deps.local) return;
  for (const p of await studiosOf(deps, deps.local, publisherId)) {
    if (p.state !== 'live') continue;
    await deps.db.send(new TransactWriteCommand({ TransactItems: downItems(deps.local, p, to, deps.now().toISOString()) }));
  }
}

export function downItems(local: LocalDeps, p: Item, to: string, at: string): TransactItems {
  const id = String(p.id);
  return [
    {
      Update: {
        TableName: local.table,
        Key: { PK: `STUDIO#${id}`, SK: 'STUDIO' },
        UpdateExpression: 'SET #s = :to, updatedAt = :now, rev = rev + :one',
        ConditionExpression: '#s = :live',
        ExpressionAttributeNames: { '#s': 'state' },
        ExpressionAttributeValues: { ':to': to, ':live': 'live', ':now': at, ':one': 1 },
      },
    },
    ...(p.cells as string[]).map((cell) => ({ Delete: { TableName: local.table, Key: { PK: `CELL#${cell}`, SK: `P#${id}` } } })),
  ];
}

// ---- studios (K-16) ----

export function studioView(item: Item): Schemas['Studio'] {
  const audio = item.audio as { durationSec?: number; bytes?: number } | undefined;
  return {
    studioId: String(item.id),
    publisherId: String(item.publisherId),
    providerName: String(item.providerName),
    category: item.category as Schemas['StudioCategory'],
    text: String(item.text),
    cells: item.cells as string[],
    startsAt: String(item.startsAt),
    endsAt: String(item.endsAt),
    ...(item.hours ? { hours: item.hours as Schemas['StudioHours'] } : {}),
    ...(audio ? { audio: { ...(audio.durationSec !== undefined ? { durationSec: audio.durationSec } : {}), ...(audio.bytes !== undefined ? { bytes: audio.bytes } : {}) } } : {}),
    state: item.state as Schemas['StudioState'],
    ...(item.check ? { check: item.check as Schemas['Studio']['check'] } : {}),
    ...(item.appeal ? { appeal: item.appeal as Schemas['Studio']['appeal'] } : {}),
    ...(item.decision ? { decision: item.decision as Schemas['Studio']['decision'] } : {}),
    rev: Number(item.rev),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  } as Schemas['Studio'];
}

async function studiosOf(deps: Deps, local: LocalDeps, publisherId: string): Promise<Item[]> {
  const out = await deps.db.send(
    new QueryCommand({
      TableName: local.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': `PROVIDER#${publisherId}` },
      ScanIndexForward: false, Limit: LIST_MAX,
    }),
  );
  return out.Items ?? [];
}

export async function loadStudio(deps: Deps, local: LocalDeps, id: string): Promise<Item> {
  const out = await deps.db.send(new GetCommand({ TableName: local.table, Key: { PK: `STUDIO#${id}`, SK: 'STUDIO' }, ConsistentRead: true }));
  return out.Item ?? fail('not_found', `no studio ${id}`);
}

/** The caller's account, approved for the studio now (スタジオの決まり 1.4). */
async function approvedProvider(deps: Deps, req: Request): Promise<{ account: Item; studio: Item }> {
  const account = await myPublisher(deps, req);
  if (account.status !== 'active') fail('publisher_not_active', `the account is ${String(account.status)}`);
  const studio = await get(deps, studioAccountKey(String(account.publisherId)).PK, 'STUDIO');
  if (!studio || studioAccountView(String(account.publisherId), studio, deps.now()).status !== 'approved') fail('studio_not_approved', 'the studio approval is needed');
  return { account, studio: studio! };
}

export async function listMyStudios(deps: Deps, req: Request): Promise<Response> {
  const local = localOf(deps);
  const account = await myPublisher(deps, req);
  return json(200, { items: (await studiosOf(deps, local, String(account.publisherId))).map(studioView) });
}

/** Makes a studio (REQ-STUDIO F-18, D-16・D-17): with audio it waits for the upload, without it the check starts. */
export async function createStudio(deps: Deps, req: Request): Promise<Response> {
  const local = localOf(deps);
  const { account, studio: approval } = await approvedProvider(deps, req);
  const body = object(req.body);
  const studioText = requiredText(body, 'text', { max: 200 });
  const category = body.category;
  if (!isStudioCategory(category)) fail('invalid_request', 'category is one of the studio categories', [{ path: '/category', message: Object.keys(STUDIO_CATEGORIES).join(', ') }]);
  if (/[\r\n]/.test(studioText)) fail('invalid_request', 'text is one paragraph', [{ path: '/text', message: 'no line breaks' }]);
  const cells = body.cells;
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > 9 || !cells.every((c) => typeof c === 'string' && GEOHASH6.test(c)) || new Set(cells).size !== cells.length) {
    fail('invalid_request', 'cells are 1 to 9 different geohash6', [{ path: '/cells', message: '1–9 geohash6' }]);
  }
  const now = deps.now();
  const startsAt = Date.parse(String(body.startsAt));
  const endsAt = Date.parse(String(body.endsAt));
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) fail('invalid_request', 'startsAt and endsAt are times', [{ path: '/startsAt', message: 'date-time' }]);
  if (startsAt > now.getTime() + 30 * DAY_MS) fail('invalid_request', 'startsAt is within 30 days', [{ path: '/startsAt', message: 'within 30 days' }]);
  if (endsAt - startsAt < DAY_MS || endsAt - startsAt > 30 * DAY_MS) fail('invalid_request', 'a studio runs one to thirty days', [{ path: '/endsAt', message: '1–30 days after startsAt' }]);
  if (endsAt <= now.getTime()) fail('invalid_request', 'endsAt has passed', [{ path: '/endsAt', message: 'in the future' }]);
  let hours: { from: string; to: string } | undefined;
  if (body.hours !== undefined) {
    const h = object(body.hours);
    if (typeof h.from !== 'string' || typeof h.to !== 'string' || !HHMM.test(h.from) || !HHMM.test(h.to) || h.from >= h.to) {
      fail('invalid_request', 'hours run from HH:MM to a later HH:MM', [{ path: '/hours', message: 'from < to' }]);
    }
    hours = { from: h.from as string, to: h.to as string };
  }
  let audioBytes: number | undefined;
  if (body.audio !== undefined) {
    const bytes = object(body.audio).bytes;
    if (!Number.isInteger(bytes) || (bytes as number) < 1 || (bytes as number) > AUDIO_MAX_BYTES) fail('invalid_request', `audio is up to ${AUDIO_MAX_BYTES} bytes`, [{ path: '/audio/bytes', message: 'too large' }]);
    audioBytes = bytes as number;
  }

  const id = ulid(now.getTime());
  const publisherId = String(account.publisherId);
  const at = now.toISOString();
  const item = {
    PK: `STUDIO#${id}`, SK: 'STUDIO', GSI1PK: `PROVIDER#${publisherId}`, GSI1SK: at,
    id, publisherId, providerName: String(approval.displayName), category, text: studioText, cells,
    startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), ...(hours ? { hours } : {}),
    ...(audioBytes !== undefined ? { audio: { bytes: audioBytes } } : {}),
    state: audioBytes !== undefined ? 'uploading' : 'checking', rev: 1, createdAt: at, updatedAt: at,
    ttl: Math.floor((endsAt + STUDIO_KEEP_MS) / 1000),
  };
  await transact(
    deps,
    [
      { Put: { TableName: local.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      auditItem(deps, req.caller, { action: 'studio.create', target: `STUDIO#${id}` }),
    ],
    {},
  );
  if (audioBytes === undefined) {
    await local.invokeCheck({ check: id });
    return json(201, { studio: studioView(item) }, { etag: '"1"' });
  }
  const upload = await local.presignAudio(`uploads/${id}.m4a`, AUDIO_MAX_BYTES);
  return json(201, { studio: studioView(item), upload: { ...upload, maxBytes: AUDIO_MAX_BYTES } }, { etag: '"1"' });
}

/** A studio of the caller's, for one of submit, stop and appeal. */
async function myStudio(deps: Deps, req: Request): Promise<{ local: LocalDeps; studio: Item; rev: number }> {
  const local = localOf(deps);
  const account = await myPublisher(deps, req);
  const studio = await loadStudio(deps, local, req.params.studioId!);
  if (studio.publisherId !== account.publisherId) fail('not_found', `no studio ${req.params.studioId}`);
  const rev = ifMatch(req);
  if (studio.rev !== rev) fail('precondition_failed', `the studio is at rev ${String(studio.rev)}`);
  return { local, studio, rev };
}

export function stateChange(local: LocalDeps, id: string, rev: number, from: string, to: string, at: string, extra: Record<string, unknown> = {}) {
  const names: Record<string, string> = { '#s': 'state' };
  const values: Record<string, unknown> = { ':to': to, ':from': from, ':rev': rev, ':now': at, ':one': 1 };
  const sets = Object.entries(extra).map(([k, v], i) => {
    names[`#e${i}`] = k;
    values[`:e${i}`] = v;
    return `, #e${i} = :e${i}`;
  });
  return {
    Update: {
      TableName: local.table,
      Key: { PK: `STUDIO#${id}`, SK: 'STUDIO' },
      UpdateExpression: `SET #s = :to, updatedAt = :now, rev = rev + :one${sets.join('')}`,
      ConditionExpression: '#s = :from AND rev = :rev',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

export async function actOnStudio(deps: Deps, req: Request): Promise<Response> {
  const { local, studio, rev } = await myStudio(deps, req);
  const id = String(studio.id);
  const at = deps.now().toISOString();
  const fails = { 0: ['precondition_failed', 'changed by someone else; read it again'] as ['precondition_failed', string] };
  switch (req.params.action) {
    case 'submit':
      if (studio.state !== 'uploading') fail('invalid_state', `the studio is ${String(studio.state)}`);
      await transact(deps, [stateChange(local, id, rev, 'uploading', 'checking', at), auditItem(deps, req.caller, { action: 'studio.submit', target: `STUDIO#${id}` })], fails);
      await local.invokeCheck({ check: id });
      break;
    case 'stop':
      if (studio.state !== 'live') fail('invalid_state', `the studio is ${String(studio.state)}`);
      await transact(
        deps,
        [
          stateChange(local, id, rev, 'live', 'stopped', at),
          ...(studio.cells as string[]).map((cell) => ({ Delete: { TableName: local.table, Key: { PK: `CELL#${cell}`, SK: `P#${id}` } } })),
          auditItem(deps, req.caller, { action: 'studio.stop', target: `STUDIO#${id}` }),
        ],
        fails,
      );
      break;
    case 'appeal': {
      if (studio.state !== 'returned') fail('invalid_state', `the studio is ${String(studio.state)}`);
      const message = requiredText(object(req.body), 'message', { max: 1000 });
      await transact(
        deps,
        [
          stateChange(local, id, rev, 'returned', 'appealed', at, { appeal: { message, at } }),
          { Put: { TableName: local.table, Item: { PK: 'QUEUE#APPEAL', SK: id, type: 'studio', id, firstAt: at } } },
          auditItem(deps, req.caller, { action: 'studio.appeal', target: `STUDIO#${id}` }),
        ],
        fails,
      );
      break;
    }
    default:
      fail('not_found', `no action ${req.params.action}`);
  }
  return withEtag(200, studioView(await loadStudio(deps, local, id)));
}

export async function listStudioAppeals(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const local = localOf(deps);
  const queue = await deps.db.send(new QueryCommand({ TableName: local.table, KeyConditionExpression: 'PK = :q', ExpressionAttributeValues: { ':q': 'QUEUE#APPEAL' } }));
  const items = await Promise.all((queue.Items ?? []).sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt))).map((q) => loadStudio(deps, local, String(q.id))));
  return json(200, { items: items.map(studioView) });
}

/** The operator answers an appeal (スタジオの決まり 3): up through the check's Lambda, or not at all. */
export async function decideAppeal(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const local = localOf(deps);
  const studio = await loadStudio(deps, local, req.params.studioId!);
  const id = String(studio.id);
  const rev = ifMatch(req);
  if (studio.rev !== rev) fail('precondition_failed', `the studio is at rev ${String(studio.rev)}`);
  if (studio.state !== 'appealed') fail('invalid_state', `the studio is ${String(studio.state)}`);
  const body = object(req.body ?? {});
  const at = deps.now().toISOString();
  const decision = req.params.decision;
  if (decision !== 'publish' && decision !== 'reject') return fail('not_found', `no decision ${decision}`);
  const message = decision === 'reject' ? requiredText(body, 'message', { max: 1000 }) : text(body, 'message', { max: 1000, optional: true, min: 0 });
  const record = { decision: { ...(message ? { message } : {}), at } };
  const dequeue = { Delete: { TableName: local.table, Key: { PK: 'QUEUE#APPEAL', SK: id } } };
  const fails = { 0: ['precondition_failed', 'changed by someone else; read it again'] as ['precondition_failed', string] };
  if (decision === 'reject') {
    await transact(deps, [stateChange(local, id, rev, 'appealed', 'rejected', at, record), dequeue, auditItem(deps, req.caller, { action: 'studio.reject', target: `STUDIO#${id}`, ...(message ? { reason: message } : {}) })], fails);
  } else {
    // The state stays `appealed` until the check's Lambda has put it up (K-11).
    await transact(
      deps,
      [
        {
          Update: {
            TableName: local.table, Key: { PK: `STUDIO#${id}`, SK: 'STUDIO' },
            UpdateExpression: 'SET #d = :d, updatedAt = :now, rev = rev + :one', ConditionExpression: '#s = :appealed AND rev = :rev',
            ExpressionAttributeNames: { '#d': 'decision', '#s': 'state' }, ExpressionAttributeValues: { ':d': record.decision, ':now': at, ':one': 1, ':appealed': 'appealed', ':rev': rev },
          },
        },
        dequeue,
        auditItem(deps, req.caller, { action: 'studio.publish', target: `STUDIO#${id}` }),
      ],
      fails,
    );
    await local.invokeCheck({ publish: id });
  }
  await notifyAfter(deps, { event: decision === 'reject' ? 'studio.rejected' : 'studio.published', publisherId: String(studio.publisherId), studioId: id, ...(message ? { message } : {}) });
  return withEtag(200, studioView(await loadStudio(deps, local, id)));
}
