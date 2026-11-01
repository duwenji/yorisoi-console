import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@yorisoi-console/api-types';
import { auditItem, notifyAfter, type Deps, type LocalDeps } from './deps.js';
import { fail, ifMatch, json, noContent, object, requireOperator, requiredText, text, withEtag, type Request, type Response } from './http.js';
import { myPublisher, transact } from './publisher.js';
import type { Item } from './shared.js';
import { downItems, loadStudio, studioView, stateChange, localOf } from './studio.js';
import { approx, localItem, queue, reportOf } from './local-ops.js';

// The operator's side of the studios after they are up (DES-013 K-17, platform policies/studio-rules.md 4),
// and a producer's counts (K-18).

// ---- reported studios (スタジオの決まり 4) ----

export async function listReportedStudios(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const local = localOf(deps);
  const items = await Promise.all(
    (await queue(deps, local, 'REPORTED_STUDIO')).map(async (q) => {
      const p = await localItem(deps, local, `STUDIO#${String(q.SK)}`, 'STUDIO');
      return p ? { studio: studioView(p), reports: Number(p.reports ?? 0), ...reportOf(q) } : undefined;
    }),
  );
  return json(200, { items: items.filter((i) => i !== undefined) });
}

/**
 * The operator's answer to a reported studio (4.3): `restore` puts a stopped one back up (or
 * leaves a live one up), `remove` takes it down for good. Either way it leaves the queue.
 */
export async function decideReportedStudio(deps: Deps, req: Request, decision: 'restore' | 'remove'): Promise<Response> {
  requireOperator(req);
  const local = localOf(deps);
  const studio = await loadStudio(deps, local, req.params.studioId!);
  const id = String(studio.id);
  const rev = ifMatch(req);
  if (studio.rev !== rev) fail('precondition_failed', `the studio is at rev ${String(studio.rev)}`);
  const body = object(req.body ?? {});
  const reason = decision === 'remove' ? requiredText(body, 'reason', { max: 1000 }) : text(body, 'reason', { max: 1000, optional: true, min: 0 });
  const at = deps.now().toISOString();
  const dequeue = { Delete: { TableName: local.table, Key: { PK: 'QUEUE#REPORTED_STUDIO', SK: id } } };
  const audit = auditItem(deps, req.caller, { action: `studio.${decision}`, target: `STUDIO#${id}`, ...(reason ? { reason } : {}) });
  const fails = { 0: ['precondition_failed', 'changed by someone else; read it again'] as ['precondition_failed', string] };
  const state = String(studio.state);

  if (decision === 'restore') {
    if (state === 'suspended') {
      // Its audio is already served: only the cells' copies come back (K-7).
      const audio = studio.audio as Record<string, unknown> | undefined;
      const copy = {
        id, providerName: studio.providerName, category: studio.category, text: studio.text, ...(audio ? { audio } : {}), cells: studio.cells,
        startsAt: studio.startsAt, endsAt: studio.endsAt, ...(studio.hours ? { hours: studio.hours } : {}),
        ttl: Math.floor(Date.parse(String(studio.endsAt)) / 1000),
      };
      await transact(
        deps,
        [
          stateChange(local, id, rev, 'suspended', 'live', at, { reports: 0 }),
          dequeue,
          audit,
          ...(studio.cells as string[]).map((cell) => ({ Put: { TableName: local.table, Item: { PK: `CELL#${cell}`, SK: `P#${id}`, ...copy } } })),
        ],
        fails,
      );
    } else {
      await transact(deps, [dequeue, audit], {});
    }
  } else {
    if (state === 'live') await transact(deps, [...downItems(local, studio, 'removed', at), dequeue, audit], fails);
    else if (state === 'suspended') await transact(deps, [stateChange(local, id, rev, 'suspended', 'removed', at), dequeue, audit], fails);
    else await transact(deps, [dequeue, audit], {});
  }
  if (decision === 'remove' || state === 'suspended') {
    await notifyAfter(deps, {
      event: decision === 'remove' ? 'studio.removed' : 'studio.restored', publisherId: String(studio.publisherId), studioId: id,
      ...(reason ? { message: reason } : {}),
    });
  }
  return withEtag(200, studioView(await loadStudio(deps, local, id)));
}


// ---- the provider's counts (K-18) ----

export async function studioStats(deps: Deps, req: Request): Promise<Response> {
  const local = localOf(deps);
  const account = await myPublisher(deps, req);
  const studio = await loadStudio(deps, local, req.params.studioId!);
  if (studio.publisherId !== account.publisherId) fail('not_found', `no studio ${req.params.studioId}`);
  const out = await deps.db.send(
    new QueryCommand({ TableName: local.table, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `STATS#${String(studio.id)}` } }),
  );
  const days = (out.Items ?? []).map((d) => ({ date: String(d.SK).slice(4), heard: Number(d.heard ?? 0), opened: Number(d.opened ?? 0) }));
  const total = days.reduce((t, d) => ({ heard: t.heard + d.heard, opened: t.opened + d.opened }), { heard: 0, opened: 0 });
  const stats: Schemas['StudioStats'] = {
    studioId: String(studio.id),
    total: { heard: approx(total.heard), opened: approx(total.opened) },
    days: days.sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ date: d.date, heard: approx(d.heard), opened: approx(d.opened) })),
  };
  return json(200, stats);
}
