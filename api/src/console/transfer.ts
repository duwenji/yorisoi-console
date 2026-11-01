import { QueryCommand, type TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@yorisoi-console/api-types';
import { b64url } from '@yorisoi-console/protocol';
import { auditItem, notifyAfter, type Deps } from './deps.js';
import { fail, ifMatch, json, object, requireOperator, requiredText, text, withEtag, type Request, type Response } from './http.js';
import { myPublisher, provenKey, transact } from './publisher.js';
import { get, loadPublisher, page, type Item } from './shared.js';
import { ulid } from './util.js';

/**
 * Moving a publisher to a new key when the old one is lost or leaked (ARCH-001 A-15, API-001 C-11,
 * DES-006): the publisher binds a new key and asks; an operator checks who they are by another
 * route and approves. All the publisher's channels move together.
 */

type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

const REASONS = ['lost', 'leaked', 'other'] as const;
const PENDING = ['uploading', 'validating', 'awaiting_review', 'in_review'];
/** How long the list carries `publisherChange` after the first version with the new key (API-CHANNEL-LIST P-9). */
export const PUBLISHER_CHANGE_DAYS = 90;

export function transferView(item: Item): Schemas['KeyTransfer'] {
  const v = item.verification as { method: string; detail: string } | undefined;
  return {
    transferId: String(item.transferId),
    publisherId: String(item.publisherId),
    fromAccountId: String(item.fromAccountId),
    toAccountId: String(item.toAccountId),
    reason: item.reason as Schemas['KeyTransfer']['reason'],
    publicReason: String(item.publicReason),
    ...(item.note ? { note: String(item.note) } : {}),
    state: item.state as Schemas['KeyTransferState'],
    ...(v ? { verification: { method: v.method, detail: v.detail } } : {}),
    ...(item.decisionReason ? { decisionReason: String(item.decisionReason) } : {}),
    ...(item.returnedSubmissions ? { returnedSubmissions: item.returnedSubmissions as string[] } : {}),
    rev: Number(item.rev),
    requestedAt: String(item.requestedAt),
    ...(item.decidedAt ? { decidedAt: String(item.decidedAt) } : {}),
  };
}

async function loadTransfer(deps: Deps, publisherId: string, transferId: string): Promise<Item> {
  return (await get(deps, `PUB#${publisherId}`, `TRANSFER#${transferId}`)) ?? fail('not_found', `no key transfer ${transferId}`);
}

/** Ends a requested transfer: the transfer, its new key and the publisher's lock, in one go. */
function closeItems(deps: Deps, transfer: Item, rev: number, state: 'approved' | 'rejected' | 'cancelled', at: string, extra: Record<string, unknown>): TransactItems {
  const publisherId = String(transfer.publisherId);
  const sets = Object.keys(extra).map((k) => `${k} = :${k}`);
  return [
    {
      Update: {
        TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `TRANSFER#${String(transfer.transferId)}` },
        UpdateExpression: `SET #s = :to, decidedAt = :now, updatedAt = :now, rev = rev + :one${sets.map((x) => `, ${x}`).join('')} REMOVE GSI2PK, GSI2SK`,
        ConditionExpression: 'rev = :rev AND #s = :requested', ExpressionAttributeNames: { '#s': 'state' },
        ExpressionAttributeValues: { ':to': state, ':requested': 'requested', ':now': at, ':one': 1, ':rev': rev, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`:${k}`, v])) },
      },
    },
    ...(state === 'approved'
      ? []
      : [
          {
            Update: {
              TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `KEY#${String(transfer.toAccountId)}` },
              UpdateExpression: 'SET #s = :unbound, unboundAt = :now, unboundReason = :why', ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':unbound': 'unbound', ':now': at, ':why': state === 'rejected' ? 'transfer_rejected' : 'transfer_cancelled' },
            },
          },
          {
            Update: {
              TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' },
              UpdateExpression: 'SET updatedAt = :now, rev = rev + :one REMOVE pendingTransferId', ConditionExpression: 'pendingTransferId = :tid',
              ExpressionAttributeValues: { ':now': at, ':one': 1, ':tid': transfer.transferId },
            },
          },
        ]),
  ];
}

// ---- the publisher ----

export async function requestKeyTransfer(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  const publisherId = String(pub.publisherId);
  if (pub.status !== 'active') fail('publisher_not_active', `the publisher is ${String(pub.status)}`);
  if (!pub.activeAccountId) fail('invalid_state', 'bind a first key instead');
  if (pub.pendingTransferId) fail('transfer_pending', `transfer ${String(pub.pendingTransferId)} is pending`);
  const body = object(req.body);
  const reason = body.reason;
  if (!REASONS.includes(reason as never)) fail('invalid_request', 'reason must be lost, leaked or other', [{ path: '/reason', message: REASONS.join(', ') }]);
  const publicReason = requiredText(body, 'publicReason', { max: 60 });
  const note = text(body, 'note', { max: 2000, optional: true, min: 0 });
  const { nonce, publicKey, account } = await provenKey(deps, pub, body);

  const at = deps.now().toISOString();
  const transferId = ulid(deps.now().getTime());
  const item = {
    PK: `PUB#${publisherId}`, SK: `TRANSFER#${transferId}`, type: 'transfer', transferId, publisherId,
    fromAccountId: String(pub.activeAccountId), toAccountId: account, reason, publicReason, ...(note ? { note } : {}),
    state: 'requested', rev: 1, requestedAt: at, updatedAt: at,
    GSI1PK: 'TRANSFERS', GSI1SK: `${at}#${transferId}`, GSI2PK: 'QUEUE#TRANSFER', GSI2SK: `${at}#${transferId}`,
  };
  await transact(
    deps,
    [
      { Delete: { TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `CHALLENGE#${nonce}` }, ConditionExpression: 'attribute_exists(PK)' } },
      { Put: { TableName: deps.table, Item: { PK: `ACCOUNT#${account}`, SK: 'ACCOUNT', type: 'account', publisherId }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: deps.table, Item: { PK: `PUB#${publisherId}`, SK: `KEY#${account}`, type: 'publisher-key', accountId: account, publicKey: b64url.encode(publicKey), status: 'pending_transfer', boundAt: at } } },
      { Put: { TableName: deps.table, Item: item } },
      {
        Update: {
          TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' },
          UpdateExpression: 'SET pendingTransferId = :tid, updatedAt = :now, rev = rev + :one',
          ConditionExpression: '#s = :active AND activeAccountId = :from AND attribute_not_exists(pendingTransferId)', ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':tid': transferId, ':active': 'active', ':from': pub.activeAccountId, ':now': at, ':one': 1 },
        },
      },
      auditItem(deps, req.caller, { action: 'transfer.request', target: `PUB#${publisherId}`, detail: { transferId, from: pub.activeAccountId, to: account, reason } }),
    ],
    { 0: ['challenge_invalid', 'the challenge was already used'], 1: ['account_id_taken', `${account} is or was used by a publisher`], 4: ['transfer_pending', 'a key transfer was requested meanwhile'] },
  );
  return withEtag(201, transferView(item));
}

export async function listMyKeyTransfers(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  const out = await deps.db.send(
    new QueryCommand({
      TableName: deps.table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :t)', ScanIndexForward: false,
      ExpressionAttributeValues: { ':pk': `PUB#${String(pub.publisherId)}`, ':t': 'TRANSFER#' },
    }),
  );
  return json(200, { items: (out.Items ?? []).map(transferView) });
}

export async function cancelKeyTransfer(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  const rev = ifMatch(req);
  const transfer = await loadTransfer(deps, String(pub.publisherId), req.params.transferId!);
  if (transfer.rev !== rev) fail('precondition_failed', `the transfer is at rev ${String(transfer.rev)}`);
  if (transfer.state !== 'requested') fail('invalid_state', `the transfer is ${String(transfer.state)}`);
  const at = deps.now().toISOString();
  await transact(
    deps,
    [
      ...closeItems(deps, transfer, rev, 'cancelled', at, {}),
      auditItem(deps, req.caller, { action: 'transfer.cancel', target: `PUB#${String(pub.publisherId)}`, detail: { transferId: transfer.transferId } }),
    ],
    { 0: ['precondition_failed', 'changed by someone else; read it again'] },
  );
  return withEtag(200, transferView(await loadTransfer(deps, String(pub.publisherId), String(transfer.transferId))));
}

// ---- the operator ----

/** The requested ones oldest first (the queue), or any state newest first. */
export async function listKeyTransfers(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const state = req.query.state ?? 'requested';
  if (!['requested', 'approved', 'rejected', 'cancelled'].includes(state)) fail('invalid_request', 'unknown state', [{ path: 'state', message: 'requested, approved, rejected or cancelled' }]);
  const { items, nextCursor } =
    state === 'requested'
      ? await page(deps, req, { IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :q', ExpressionAttributeValues: { ':q': 'QUEUE#TRANSFER' } })
      : await page(deps, req, {
          IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :t', FilterExpression: '#s = :s', ScanIndexForward: false,
          ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':t': 'TRANSFERS', ':s': state },
        });
  return json(200, { items: items.map(transferView), nextCursor });
}

async function loadForDecision(deps: Deps, req: Request) {
  requireOperator(req);
  const rev = ifMatch(req);
  const transfer = await loadTransfer(deps, req.params.publisherId!, req.params.transferId!);
  if (transfer.rev !== rev) fail('precondition_failed', `the transfer is at rev ${String(transfer.rev)}`);
  if (transfer.state !== 'requested') fail('invalid_state', `the transfer is ${String(transfer.state)}`);
  return { transfer, rev };
}

/**
 * Approves a transfer (DM-001 移し替えの承認): the new key becomes the publisher's, the old one is
 * unbound, pending submissions (signed with the old key) are returned, and every channel with an
 * approved version records the change for the list (`publisherChange`, from the account the
 * listed version names). The list carries it once a version with the new key is approved.
 */
export async function approveKeyTransfer(deps: Deps, req: Request): Promise<Response> {
  const { transfer, rev } = await loadForDecision(deps, req);
  const verification = object(object(req.body).verification);
  const method = requiredText(verification, 'method', { max: 100 });
  const detail = requiredText(verification, 'detail', { max: 2000 });
  const publisherId = String(transfer.publisherId);
  const transferId = String(transfer.transferId);
  const pub = await loadPublisher(deps, publisherId);
  if (pub.pendingTransferId !== transferId) fail('invalid_state', 'the publisher is not waiting for this transfer');

  const at = deps.now().toISOString();
  const channels = (
    await deps.db.send(
      new QueryCommand({ TableName: deps.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :ch)', ExpressionAttributeValues: { ':pk': `PUB#${publisherId}`, ':ch': 'CH#' } }),
    )
  ).Items ?? [];
  const collections = (
    await deps.db.send(
      new QueryCommand({ TableName: deps.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :c)', ExpressionAttributeValues: { ':pk': `PUB#${publisherId}`, ':c': 'COL#' } }),
    )
  ).Items ?? [];
  const items: TransactItems = [];
  const returned: string[] = [];
  const archives: string[] = [];
  const message = 'チャンネル提供者の鍵が移し替えられたため差し戻しました。新しい鍵で署名し直して申請してください。';
  // Its collections move with it, as its channels do (DM-001, API-CHANNEL-LIST P-13).
  for (const col of collections) {
    const collectionId = String(col.collectionId);
    const sets: string[] = [];
    const values: Record<string, unknown> = {};
    const listedBy = (col.latestApproved as { producer?: string } | undefined)?.producer;
    if (listedBy) {
      sets.push('producerChange = :pc');
      values[':pc'] = { from: listedBy, at, reason: String(transfer.publicReason) };
    }
    if (col.pendingSubmissionId) {
      const sid = String(col.pendingSubmissionId);
      const sub = await get(deps, `COL#${collectionId}`, `SUB#${sid}`);
      if (sub && PENDING.includes(String(sub.state))) {
        items.push({
          Update: {
            TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: `SUB#${sid}` },
            UpdateExpression: 'SET #s = :returned, decision = :d, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK, #ttl',
            ConditionExpression: '#s = :was', ExpressionAttributeNames: { '#s': 'state', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':returned': 'returned', ':was': sub.state, ':d': { action: 'return', findings: [], message, at }, ':now': at, ':one': 1 },
          },
        });
        returned.push(sid);
        archives.push(String(sub.intakeKey));
      }
    }
    if (sets.length || col.pendingSubmissionId) {
      items.push({
        Update: {
          TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: 'COL' },
          UpdateExpression: `SET ${[...sets, 'updatedAt = :now', 'rev = rev + :one'].join(', ')}${col.pendingSubmissionId ? ' REMOVE pendingSubmissionId' : ''}`,
          ExpressionAttributeValues: { ...values, ':now': at, ':one': 1 },
        },
      });
    }
  }
  for (const ch of channels) {
    const channelId = String(ch.channelId);
    const sets: string[] = [];
    const values: Record<string, unknown> = {};
    const removes: string[] = [];
    const listedBy = (ch.latestApproved as { publisher?: string } | undefined)?.publisher;
    if (listedBy) {
      // From the account the listed version names: the one the app holds.
      sets.push('publisherChange = :pc');
      values[':pc'] = { from: listedBy, at, reason: String(transfer.publicReason) };
    }
    if (ch.pendingSubmissionId) {
      const sid = String(ch.pendingSubmissionId);
      const sub = await get(deps, `CH#${channelId}`, `SUB#${sid}`);
      if (sub && PENDING.includes(String(sub.state))) {
        items.push({
          Update: {
            TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${sid}` },
            UpdateExpression: 'SET #s = :returned, decision = :d, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK, #ttl',
            ConditionExpression: '#s = :was', ExpressionAttributeNames: { '#s': 'state', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':returned': 'returned', ':was': sub.state, ':d': { action: 'return', findings: [], message, at }, ':now': at, ':one': 1 },
          },
        });
        returned.push(sid);
        archives.push(String(sub.intakeKey), String(sub.iconIntakeKey));
      }
      removes.push('pendingSubmissionId');
    }
    if (sets.length || removes.length) {
      items.push({
        Update: {
          TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: 'CH' },
          UpdateExpression: `SET ${[...sets, 'updatedAt = :now', 'rev = rev + :one'].join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
          ExpressionAttributeValues: { ...values, ':now': at, ':one': 1 },
        },
      });
    }
  }
  items.push(
    ...closeItems(deps, transfer, rev, 'approved', at, { verification: { method, detail, verifiedAt: at, operatorSub: req.caller.sub }, returnedSubmissions: returned }),
    {
      Update: {
        TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `KEY#${String(transfer.toAccountId)}` },
        UpdateExpression: 'SET #s = :active', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':active': 'active' },
      },
    },
    {
      Update: {
        TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `KEY#${String(transfer.fromAccountId)}` },
        UpdateExpression: 'SET #s = :unbound, unboundAt = :now, unboundReason = :why', ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':unbound': 'unbound', ':now': at, ':why': 'transferred' },
      },
    },
    {
      Update: {
        TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' },
        UpdateExpression: 'SET activeAccountId = :to, updatedAt = :now, rev = rev + :one REMOVE pendingTransferId',
        ConditionExpression: 'pendingTransferId = :tid AND activeAccountId = :from',
        ExpressionAttributeValues: { ':to': transfer.toAccountId, ':from': transfer.fromAccountId, ':tid': transferId, ':now': at, ':one': 1 },
      },
    },
    auditItem(deps, req.caller, {
      action: 'transfer.approve', target: `PUB#${publisherId}`, reason: method,
      detail: { transferId, from: transfer.fromAccountId, to: transfer.toAccountId, returned, channels: channels.map((c) => c.channelId), collections: collections.map((c) => c.collectionId) },
    }),
  );
  await transact(deps, items, {});
  for (const key of archives) await deps.archiveUpload(key).catch(() => undefined);
  await deps.requestPublish('transfer');
  await notifyAfter(deps, { event: 'transfer.approved', publisherId, transferId, returned: returned.length });
  return withEtag(200, transferView(await loadTransfer(deps, publisherId, transferId)));
}

export async function rejectKeyTransfer(deps: Deps, req: Request): Promise<Response> {
  const { transfer, rev } = await loadForDecision(deps, req);
  const reason = requiredText(object(req.body), 'reason', { max: 500 });
  const publisherId = String(transfer.publisherId);
  const at = deps.now().toISOString();
  await transact(
    deps,
    [
      ...closeItems(deps, transfer, rev, 'rejected', at, { decisionReason: reason }),
      auditItem(deps, req.caller, { action: 'transfer.reject', target: `PUB#${publisherId}`, reason, detail: { transferId: transfer.transferId } }),
    ],
    { 0: ['precondition_failed', 'changed by someone else; read it again'] },
  );
  await notifyAfter(deps, { event: 'transfer.rejected', publisherId, transferId: String(transfer.transferId), message: reason });
  return withEtag(200, transferView(await loadTransfer(deps, publisherId, String(transfer.transferId))));
}
