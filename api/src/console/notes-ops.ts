import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@yorisoi-console/api-types';
import { auditItem, notifyAfter, type Deps, type LocalDeps } from './deps.js';
import { fail, ifMatch, json, noContent, object, requireOperator, requiredText, text, withEtag, type Request, type Response } from './http.js';
import { myPublisher, transact } from './publisher.js';
import type { Item } from './shared.js';
import { downItems, loadStudio, studioView, stateChange, localOf } from './studio.js';
import { approx, DAY_MS, localItem, queue, reportOf } from './local-ops.js';

// The operator's side of the notes after they are put (DES-013 K-17, platform policies/notes-terms.md 3):
// reported notes and banning the device that put one.

// ---- reported notes (一言の利用規約 3) ----

export async function listReportedNotes(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const local = localOf(deps);
  const items = await Promise.all(
    (await queue(deps, local, 'REPORTED_NOTE')).map(async (q) => {
      const n = await localItem(deps, local, `NOTE#${String(q.SK)}`, 'NOTE');
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
  const local = localOf(deps);
  const noteId = req.params.noteId!;
  const decision = req.params.decision;
  if (decision !== 'restore' && decision !== 'remove') return fail('not_found', `no decision ${decision}`);
  const note = (await localItem(deps, local, `NOTE#${noteId}`, 'NOTE')) ?? fail('not_found', `no note ${noteId}`);
  const body = object(req.body ?? {});
  const reason = decision === 'remove' ? requiredText(body, 'reason', { max: 1000 }) : text(body, 'reason', { max: 1000, optional: true, min: 0 });
  const now = deps.now();
  const at = now.toISOString();
  const cellKey = { PK: `CELL#${String(note.cell).slice(0, 6)}`, SK: `N#${noteId}` };
  const dequeue = { Delete: { TableName: local.table, Key: { PK: 'QUEUE#REPORTED_NOTE', SK: noteId } } };
  const audit = auditItem(deps, req.caller, { action: `note.${decision}`, target: `NOTE#${noteId}`, ...(reason ? { reason } : {}) });

  if (decision === 'restore') {
    if (note.state !== 'hidden') fail('invalid_state', `the note is ${String(note.state)}`);
    const live = String(note.expiresAt) > at;
    await transact(
      deps,
      [
        {
          Update: {
            TableName: local.table, Key: { PK: `NOTE#${noteId}`, SK: 'NOTE' },
            UpdateExpression: 'SET #s = :active, reports = :zero', ConditionExpression: '#s = :hidden',
            ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':active': 'active', ':hidden': 'hidden', ':zero': 0 },
          },
        },
        ...(live
          ? [{
              Update: {
                TableName: local.table, Key: cellKey, UpdateExpression: 'SET #s = :active', ConditionExpression: 'attribute_exists(PK)',
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
          TableName: local.table, Key: { PK: `NOTE#${noteId}`, SK: 'NOTE' },
          UpdateExpression: 'SET #s = :removed REMOVE #t, spotName, GSI1PK, GSI1SK', ConditionExpression: '#s <> :removed',
          ExpressionAttributeNames: { '#s': 'state', '#t': 'text' }, ExpressionAttributeValues: { ':removed': 'removed' },
        },
      },
      { Delete: { TableName: local.table, Key: cellKey } },
      dequeue,
      ...(ban
        ? [
            { Put: { TableName: local.table, Item: { PK: `BAN#${author}`, SK: 'BAN', ...(ban.until ? { until: ban.until, ttl: Math.floor(Date.parse(ban.until) / 1000) } : {}) } } },
            // The list the operator sees: by the note, never by the device (K-6).
            {
              Put: {
                TableName: local.table,
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
  const local = localOf(deps);
  const at = deps.now().toISOString();
  const out = await deps.db.send(new QueryCommand({ TableName: local.table, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': 'BANS' } }));
  const items = (out.Items ?? [])
    .filter((b) => b.until === undefined || String(b.until) > at)
    .map((b) => ({ noteId: String(b.noteId), reason: String(b.reason), createdAt: String(b.createdAt), ...(b.until ? { until: String(b.until) } : {}) }));
  return json(200, { items });
}

export async function liftBan(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const local = localOf(deps);
  const noteId = req.params.noteId!;
  const entry = (await localItem(deps, local, 'BANS', noteId)) ?? fail('not_found', `no ban from note ${noteId}`);
  await transact(
    deps,
    [
      { Delete: { TableName: local.table, Key: { PK: 'BANS', SK: noteId } } },
      { Delete: { TableName: local.table, Key: { PK: `BAN#${String(entry.author)}`, SK: 'BAN' } } },
      auditItem(deps, req.caller, { action: 'note.unban', target: `NOTE#${noteId}` }),
    ],
    {},
  );
  return noContent();
}

