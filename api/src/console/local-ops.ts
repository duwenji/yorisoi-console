import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@yorisoi-console/api-types';
import { auditItem, notifyAfter, type Deps, type LocalDeps } from './deps.js';
import { fail, ifMatch, json, noContent, object, requireOperator, requiredText, text, withEtag, type Request, type Response } from './http.js';
import { myPublisher, transact } from './publisher.js';
import type { Item } from './shared.js';
import { downItems, loadStudio, studioView, stateChange, localOf } from './studio.js';

// The operator's side of what is fetched by area, studios and notes alike (platform MATERIALS D-44):
// the closed areas, where neither may be put (REQ-STUDIO・REQ-NOTES F-15), and what the studio's and the notes'
// pages share.

const BUCKETS = [1000, 300, 100, 30, 10, 3];
export const approx = (n: number) => {
  const bucket = BUCKETS.find((b) => n >= b);
  return bucket ? { atLeast: bucket } : null;
};
const GEOHASH = /^[0123456789bcdefghjkmnpqrstuvwxyz]{5,7}$/;
export const DAY_MS = 24 * 3600_000;

export async function localItem(deps: Deps, local: LocalDeps, PK: string, SK: string): Promise<Item | undefined> {
  return (await deps.db.send(new GetCommand({ TableName: local.table, Key: { PK, SK }, ConsistentRead: true }))).Item;
}

export async function queue(deps: Deps, local: LocalDeps, name: string): Promise<Item[]> {
  const out = await deps.db.send(new QueryCommand({ TableName: local.table, KeyConditionExpression: 'PK = :q', ExpressionAttributeValues: { ':q': `QUEUE#${name}` } }));
  return (out.Items ?? []).sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
}

export const reportOf = (q: Item) => ({ firstAt: String(q.firstAt), lastAt: String(q.lastAt ?? q.firstAt), reasons: [...((q.reasons as Set<string> | undefined) ?? [])].sort() });

// ---- closed areas (REQ-STUDIO F-15) ----

export async function listAreas(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const local = localOf(deps);
  const out = await deps.db.send(new QueryCommand({ TableName: local.table, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': 'AREA' } }));
  return json(200, { items: (out.Items ?? []).map((a) => ({ cell: String(a.SK), reason: String(a.reason ?? ''), createdAt: String(a.createdAt ?? '') })) });
}

export async function closeArea(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const local = localOf(deps);
  const body = object(req.body);
  const cell = requiredText(body, 'cell', { min: 5, max: 7, pattern: GEOHASH });
  const reason = requiredText(body, 'reason', { max: 500 });
  const at = deps.now().toISOString();
  await transact(
    deps,
    [
      { Put: { TableName: local.table, Item: { PK: 'AREA', SK: cell, reason, createdAt: at } } },
      auditItem(deps, req.caller, { action: 'studio.area.close', target: `AREA#${cell}`, reason }),
    ],
    {},
  );
  return json(201, { cell, reason, createdAt: at });
}

export async function openArea(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const local = localOf(deps);
  const cell = req.params.cell!;
  await transact(
    deps,
    [
      { Delete: { TableName: local.table, Key: { PK: 'AREA', SK: cell }, ConditionExpression: 'attribute_exists(PK)' } },
      auditItem(deps, req.caller, { action: 'studio.area.open', target: `AREA#${cell}` }),
    ],
    { 0: ['not_found', `no closed area ${cell}`] },
  );
  return noContent();
}

