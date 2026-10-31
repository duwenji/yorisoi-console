import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@yorisoi-console/api-types';
import { auditItem, notifyAfter, type Deps, type StudioDeps } from './deps.js';
import { fail, ifMatch, json, noContent, object, requireOperator, requiredText, text, withEtag, type Request, type Response } from './http.js';
import { myPublisher, transact } from './publisher.js';
import type { Item } from './shared.js';
import { downItems, loadPlacement, placementView, stateChange, studioOf } from './studio.js';

// The operator's side of the studio after things are up (DES-013 K-17, platform policies/
// studio-placement.md 4, studio-note-terms.md 3): reported placements and notes, banning the device
// that placed a note, closed areas; and the provider's day counts (K-18). The operator never sees
// which device placed a note: a ban is made and listed by the note.

const BUCKETS = [1000, 300, 100, 30, 10, 3];
const approx = (n: number) => {
  const bucket = BUCKETS.find((b) => n >= b);
  return bucket ? { atLeast: bucket } : null;
};
const GEOHASH = /^[0123456789bcdefghjkmnpqrstuvwxyz]{5,7}$/;
const DAY_MS = 24 * 3600_000;

async function studioItem(deps: Deps, studio: StudioDeps, PK: string, SK: string): Promise<Item | undefined> {
  return (await deps.db.send(new GetCommand({ TableName: studio.table, Key: { PK, SK }, ConsistentRead: true }))).Item;
}

async function queue(deps: Deps, studio: StudioDeps, name: string): Promise<Item[]> {
  const out = await deps.db.send(new QueryCommand({ TableName: studio.table, KeyConditionExpression: 'PK = :q', ExpressionAttributeValues: { ':q': `QUEUE#${name}` } }));
  return (out.Items ?? []).sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
}

const reportOf = (q: Item) => ({ firstAt: String(q.firstAt), lastAt: String(q.lastAt ?? q.firstAt), reasons: [...((q.reasons as Set<string> | undefined) ?? [])].sort() });

// ---- reported placements (掲載の決まり 4) ----

export async function listReportedPlacements(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const studio = studioOf(deps);
  const items = await Promise.all(
    (await queue(deps, studio, 'REPORTED_PLACEMENT')).map(async (q) => {
      const p = await studioItem(deps, studio, `PLACEMENT#${String(q.SK)}`, 'PLACEMENT');
      return p ? { placement: placementView(p), reports: Number(p.reports ?? 0), ...reportOf(q) } : undefined;
    }),
  );
  return json(200, { items: items.filter((i) => i !== undefined) });
}

/**
 * The operator's answer to a reported placement (4.3): `restore` puts a stopped one back up (or
 * leaves a live one up), `remove` takes it down for good. Either way it leaves the queue.
 */
export async function decideReportedPlacement(deps: Deps, req: Request, decision: 'restore' | 'remove'): Promise<Response> {
  requireOperator(req);
  const studio = studioOf(deps);
  const placement = await loadPlacement(deps, studio, req.params.placementId!);
  const id = String(placement.id);
  const rev = ifMatch(req);
  if (placement.rev !== rev) fail('precondition_failed', `the placement is at rev ${String(placement.rev)}`);
  const body = object(req.body ?? {});
  const reason = decision === 'remove' ? requiredText(body, 'reason', { max: 1000 }) : text(body, 'reason', { max: 1000, optional: true, min: 0 });
  const at = deps.now().toISOString();
  const dequeue = { Delete: { TableName: studio.table, Key: { PK: 'QUEUE#REPORTED_PLACEMENT', SK: id } } };
  const audit = auditItem(deps, req.caller, { action: `placement.${decision}`, target: `PLACEMENT#${id}`, ...(reason ? { reason } : {}) });
  const fails = { 0: ['precondition_failed', 'changed by someone else; read it again'] as ['precondition_failed', string] };
  const state = String(placement.state);

  if (decision === 'restore') {
    if (state === 'suspended') {
      // Its audio is already served: only the cells' copies come back (K-7).
      const audio = placement.audio as Record<string, unknown> | undefined;
      const copy = {
        id, providerName: placement.providerName, text: placement.text, ...(audio ? { audio } : {}), cells: placement.cells,
        startsAt: placement.startsAt, endsAt: placement.endsAt, ...(placement.hours ? { hours: placement.hours } : {}),
        ttl: Math.floor(Date.parse(String(placement.endsAt)) / 1000),
      };
      await transact(
        deps,
        [
          stateChange(studio, id, rev, 'suspended', 'live', at, { reports: 0 }),
          dequeue,
          audit,
          ...(placement.cells as string[]).map((cell) => ({ Put: { TableName: studio.table, Item: { PK: `CELL#${cell}`, SK: `P#${id}`, ...copy } } })),
        ],
        fails,
      );
    } else {
      await transact(deps, [dequeue, audit], {});
    }
  } else {
    if (state === 'live') await transact(deps, [...downItems(studio, placement, 'removed', at), dequeue, audit], fails);
    else if (state === 'suspended') await transact(deps, [stateChange(studio, id, rev, 'suspended', 'removed', at), dequeue, audit], fails);
    else await transact(deps, [dequeue, audit], {});
  }
  if (decision === 'remove' || state === 'suspended') {
    await notifyAfter(deps, {
      event: decision === 'remove' ? 'placement.removed' : 'placement.restored', publisherId: String(placement.publisherId), placementId: id,
      ...(reason ? { message: reason } : {}),
    });
  }
  return withEtag(200, placementView(await loadPlacement(deps, studio, id)));
}

// ---- reported notes (一言の利用規約 3) ----

export async function listReportedNotes(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const studio = studioOf(deps);
  const items = await Promise.all(
    (await queue(deps, studio, 'REPORTED_NOTE')).map(async (q) => {
      const n = await studioItem(deps, studio, `NOTE#${String(q.SK)}`, 'NOTE');
      if (!n) return undefined;
      return {
        noteId: String(n.id),
        ...(n.text !== undefined ? { text: String(n.text) } : {}),
        cell: String(n.cell),
        ...(n.spotName ? { spotName: String(n.spotName) } : {}),
        state: String(n.state),
        expiresAt: String(n.expiresAt),
        createdAt: String(n.createdAt),
        reports: Number(n.reports ?? 0),
        ...reportOf(q),
      };
    }),
  );
  return json(200, { items: items.filter((i) => i !== undefined) });
}

/**
 * `restore` brings a hidden note back while it lasts; `remove` takes it down and its text with it,
 * and may ban the device that placed it (`ban.days`, or no end).
 */
export async function decideReportedNote(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const studio = studioOf(deps);
  const noteId = req.params.noteId!;
  const decision = req.params.decision;
  if (decision !== 'restore' && decision !== 'remove') return fail('not_found', `no decision ${decision}`);
  const note = (await studioItem(deps, studio, `NOTE#${noteId}`, 'NOTE')) ?? fail('not_found', `no note ${noteId}`);
  const body = object(req.body ?? {});
  const reason = decision === 'remove' ? requiredText(body, 'reason', { max: 1000 }) : text(body, 'reason', { max: 1000, optional: true, min: 0 });
  const now = deps.now();
  const at = now.toISOString();
  const cellKey = { PK: `CELL#${String(note.cell).slice(0, 6)}`, SK: `N#${noteId}` };
  const dequeue = { Delete: { TableName: studio.table, Key: { PK: 'QUEUE#REPORTED_NOTE', SK: noteId } } };
  const audit = auditItem(deps, req.caller, { action: `note.${decision}`, target: `NOTE#${noteId}`, ...(reason ? { reason } : {}) });

  if (decision === 'restore') {
    if (note.state !== 'hidden') fail('invalid_state', `the note is ${String(note.state)}`);
    const live = String(note.expiresAt) > at;
    await transact(
      deps,
      [
        {
          Update: {
            TableName: studio.table, Key: { PK: `NOTE#${noteId}`, SK: 'NOTE' },
            UpdateExpression: 'SET #s = :active, reports = :zero', ConditionExpression: '#s = :hidden',
            ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':active': 'active', ':hidden': 'hidden', ':zero': 0 },
          },
        },
        ...(live
          ? [{
              Update: {
                TableName: studio.table, Key: cellKey, UpdateExpression: 'SET #s = :active', ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':active': 'active' },
              },
            }]
          : []),
        dequeue,
        audit,
      ],
      { 0: ['invalid_state', 'the note changed; read it again'] },
    );
    return json(200, { noteId, state: 'active' });
  }

  if (note.state === 'deleted' || note.state === 'removed') fail('invalid_state', `the note is ${String(note.state)}`);
  let ban: { until?: string } | undefined;
  if (body.ban !== undefined) {
    const days = object(body.ban).days;
    if (days !== undefined && (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365)) fail('invalid_request', 'ban.days is 1–365, or left out for no end');
    ban = days === undefined ? {} : { until: new Date(now.getTime() + (days as number) * DAY_MS).toISOString() };
  }
  const author = String(note.author);
  await transact(
    deps,
    [
      {
        Update: {
          TableName: studio.table, Key: { PK: `NOTE#${noteId}`, SK: 'NOTE' },
          UpdateExpression: 'SET #s = :removed REMOVE #t, spotName, GSI1PK, GSI1SK', ConditionExpression: '#s <> :removed',
          ExpressionAttributeNames: { '#s': 'state', '#t': 'text' }, ExpressionAttributeValues: { ':removed': 'removed' },
        },
      },
      { Delete: { TableName: studio.table, Key: cellKey } },
      dequeue,
      ...(ban
        ? [
            { Put: { TableName: studio.table, Item: { PK: `BAN#${author}`, SK: 'BAN', ...(ban.until ? { until: ban.until, ttl: Math.floor(Date.parse(ban.until) / 1000) } : {}) } } },
            // The list the operator sees: by the note, never by the device (K-6).
            {
              Put: {
                TableName: studio.table,
                Item: { PK: 'BANS', SK: noteId, noteId, author, reason, createdAt: at, ...(ban.until ? { until: ban.until, ttl: Math.floor(Date.parse(ban.until) / 1000) } : {}) },
              },
            },
          ]
        : []),
      audit,
    ],
    { 0: ['invalid_state', 'the note changed; read it again'] },
  );
  return json(200, { noteId, state: 'removed', ...(ban ? { ban: { ...(ban.until ? { until: ban.until } : {}) } } : {}) });
}

// ---- bans ----

export async function listBans(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const studio = studioOf(deps);
  const at = deps.now().toISOString();
  const out = await deps.db.send(new QueryCommand({ TableName: studio.table, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': 'BANS' } }));
  const items = (out.Items ?? [])
    .filter((b) => b.until === undefined || String(b.until) > at)
    .map((b) => ({ noteId: String(b.noteId), reason: String(b.reason), createdAt: String(b.createdAt), ...(b.until ? { until: String(b.until) } : {}) }));
  return json(200, { items });
}

export async function liftBan(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const studio = studioOf(deps);
  const noteId = req.params.noteId!;
  const entry = (await studioItem(deps, studio, 'BANS', noteId)) ?? fail('not_found', `no ban from note ${noteId}`);
  await transact(
    deps,
    [
      { Delete: { TableName: studio.table, Key: { PK: 'BANS', SK: noteId } } },
      { Delete: { TableName: studio.table, Key: { PK: `BAN#${String(entry.author)}`, SK: 'BAN' } } },
      auditItem(deps, req.caller, { action: 'note.unban', target: `NOTE#${noteId}` }),
    ],
    {},
  );
  return noContent();
}

// ---- closed areas (REQ-STUDIO F-15) ----

export async function listAreas(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const studio = studioOf(deps);
  const out = await deps.db.send(new QueryCommand({ TableName: studio.table, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': 'AREA' } }));
  return json(200, { items: (out.Items ?? []).map((a) => ({ cell: String(a.SK), reason: String(a.reason ?? ''), createdAt: String(a.createdAt ?? '') })) });
}

export async function closeArea(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const studio = studioOf(deps);
  const body = object(req.body);
  const cell = requiredText(body, 'cell', { min: 5, max: 7, pattern: GEOHASH });
  const reason = requiredText(body, 'reason', { max: 500 });
  const at = deps.now().toISOString();
  await transact(
    deps,
    [
      { Put: { TableName: studio.table, Item: { PK: 'AREA', SK: cell, reason, createdAt: at } } },
      auditItem(deps, req.caller, { action: 'studio.area.close', target: `AREA#${cell}`, reason }),
    ],
    {},
  );
  return json(201, { cell, reason, createdAt: at });
}

export async function openArea(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const studio = studioOf(deps);
  const cell = req.params.cell!;
  await transact(
    deps,
    [
      { Delete: { TableName: studio.table, Key: { PK: 'AREA', SK: cell }, ConditionExpression: 'attribute_exists(PK)' } },
      auditItem(deps, req.caller, { action: 'studio.area.open', target: `AREA#${cell}` }),
    ],
    { 0: ['not_found', `no closed area ${cell}`] },
  );
  return noContent();
}

// ---- the provider's counts (K-18) ----

export async function placementStats(deps: Deps, req: Request): Promise<Response> {
  const studio = studioOf(deps);
  const account = await myPublisher(deps, req);
  const placement = await loadPlacement(deps, studio, req.params.placementId!);
  if (placement.publisherId !== account.publisherId) fail('not_found', `no placement ${req.params.placementId}`);
  const out = await deps.db.send(
    new QueryCommand({ TableName: studio.table, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `STATS#${String(placement.id)}` } }),
  );
  const days = (out.Items ?? []).map((d) => ({ date: String(d.SK).slice(4), heard: Number(d.heard ?? 0), opened: Number(d.opened ?? 0) }));
  const total = days.reduce((t, d) => ({ heard: t.heard + d.heard, opened: t.opened + d.opened }), { heard: 0, opened: 0 });
  const stats: Schemas['PlacementStats'] = {
    placementId: String(placement.id),
    total: { heard: approx(total.heard), opened: approx(total.opened) },
    days: days.sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ date: d.date, heard: approx(d.heard), opened: approx(d.opened) })),
  };
  return json(200, stats);
}
