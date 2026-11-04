import { QueryCommand, type TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CHANNEL_ID } from '@yorisoi-console/protocol';
import { auditItem, type Deps } from './deps.js';
import { fail, ifMatch, json, object, requireOperator, requiredText, text, withEtag, type Request, type Response } from './http.js';
import { draftSummary } from './drafts.js';
import { myPublisher, transact } from './publisher.js';
import {
  DEFAULT_LIMITS, collectionSubmissionView, collectionView, get, loadCollection, loadCollectionSubmission, loadPublisher, page, publisherView, rolesOf, type Item,
} from './shared.js';
import { jstDate, ulid } from './util.js';

// The producer's side of collections (API-001 C-15〜C-18, DES-008). The operator's
// review of them is in review.ts, sharing the channel's steps.

type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

const UPLOAD_WINDOW_MS = 15 * 60_000;
/** An upload that never arrived frees its collection after an hour, as for channels. */
const UPLOAD_EXPIRY_MS = 60 * 60_000;
const MAX_PACKAGE = 2 * 1024 * 1024;

/** The caller's own account, if it is active and has the producer role (C-15). */
async function myProducer(deps: Deps, req: Request): Promise<Item> {
  const account = await myPublisher(deps, req);
  if (!rolesOf(account).includes('producer')) fail('role_required', 'turn on the producer role first');
  return account;
}

function requireActive(account: Item) {
  if (account.status !== 'active') fail('publisher_not_active', `the account is ${String(account.status)}`);
}

/** A collection the caller may see: their own, or any for an operator. Others' are 404, as for channels. */
async function visibleCollection(deps: Deps, req: Request, collectionId: string): Promise<{ collection: Item; account?: Item }> {
  const collection = await loadCollection(deps, collectionId);
  if (req.caller.roles.includes('operator')) return { collection };
  const account = await myProducer(deps, req);
  if (collection.publisherId !== account.publisherId) fail('not_found', `no collection ${collectionId}`);
  return { collection, account };
}

/** Turns on the producer role (C-15, DM-001 M-16・M-17): anyone may, as anyone may register. */
export async function enableProducerRole(deps: Deps, req: Request): Promise<Response> {
  const account = await myPublisher(deps, req);
  const rev = ifMatch(req);
  if (account.rev !== rev) fail('precondition_failed', `the account is at rev ${String(account.rev)}`);
  if (account.status !== 'active' && account.status !== 'pending_key') fail('publisher_not_active', `the account is ${String(account.status)}`);
  if (rolesOf(account).includes('producer')) return withEtag(200, await publisherView(deps, account));
  const publisherId = String(account.publisherId);
  await transact(
    deps,
    [
      {
        Update: {
          TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' },
          UpdateExpression: 'SET #roles = :roles, collectionCount = if_not_exists(collectionCount, :zero), updatedAt = :now, rev = rev + :one',
          ConditionExpression: 'rev = :rev', ExpressionAttributeNames: { '#roles': 'roles' },
          ExpressionAttributeValues: { ':roles': [...rolesOf(account), 'producer'], ':zero': 0, ':now': deps.now().toISOString(), ':one': 1, ':rev': rev },
        },
      },
      auditItem(deps, req.caller, { action: 'publisher.role.producer', target: `PUB#${publisherId}` }),
    ],
    { 0: ['precondition_failed', 'changed by someone else; read it again'] },
  );
  return withEtag(200, await publisherView(deps, await loadPublisher(deps, publisherId)));
}

// ---- collections ----

export async function registerCollection(deps: Deps, req: Request): Promise<Response> {
  const account = await myProducer(deps, req);
  requireActive(account);
  // The same form as a channel id, in another namespace (M-18).
  const collectionId = requiredText(object(req.body), 'collectionId', { min: 3, max: 40, pattern: CHANNEL_ID });
  const publisherId = String(account.publisherId);
  const max = Number((account.limits as { collections?: number } | undefined)?.collections ?? DEFAULT_LIMITS.collections);
  const now = deps.now().toISOString();
  const item = {
    PK: `COL#${collectionId}`, SK: 'COL', type: 'collection', kind: 'collection', collectionId, publisherId, status: 'active', rev: 1, createdAt: now, updatedAt: now,
    GSI1PK: `PUB#${publisherId}`, GSI1SK: `COL#${collectionId}`,
  };
  await transact(
    deps,
    [
      { Put: { TableName: deps.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      {
        Update: {
          TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' },
          UpdateExpression: 'SET collectionCount = if_not_exists(collectionCount, :zero) + :one, updatedAt = :now, rev = rev + :one',
          ConditionExpression: '#s = :active AND contains(#roles, :producer) AND (attribute_not_exists(collectionCount) OR collectionCount < :max)',
          ExpressionAttributeNames: { '#s': 'status', '#roles': 'roles' },
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':now': now, ':active': 'active', ':producer': 'producer', ':max': max },
        },
      },
      auditItem(deps, req.caller, { action: 'collection.register', target: `COL#${collectionId}` }),
    ],
    { 0: ['collection_id_taken', `${collectionId} is taken`], 1: ['limit_reached', `up to ${max} collections`] },
  );
  return withEtag(201, await collectionView(deps, item));
}

async function collectionsOf(deps: Deps, publisherId: string): Promise<Item[]> {
  const out = await deps.db.send(
    new QueryCommand({ TableName: deps.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :c)', ExpressionAttributeValues: { ':pk': `PUB#${publisherId}`, ':c': 'COL#' } }),
  );
  return out.Items ?? [];
}

export async function listMyCollections(deps: Deps, req: Request): Promise<Response> {
  const account = await myProducer(deps, req);
  return json(200, { items: await Promise.all((await collectionsOf(deps, String(account.publisherId))).map((c) => collectionView(deps, c))) });
}

export async function listPublisherCollections(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  await loadPublisher(deps, req.params.publisherId!);
  return json(200, { items: await Promise.all((await collectionsOf(deps, req.params.publisherId!)).map((c) => collectionView(deps, c))) });
}

export async function getCollection(deps: Deps, req: Request): Promise<Response> {
  const { collection, account } = await visibleCollection(deps, req, req.params.collectionId!);
  // The draft is the owner's alone (DES-014 R-6).
  const draft = account ? { draft: await draftSummary(deps, `COL#${String(collection.collectionId)}`) } : {};
  return withEtag(200, { ...(await collectionView(deps, collection)), ...draft });
}

/**
 * The channels that use a collection (C-18, DES-008 K-12): its records of use, with the names a
 * listed channel shows. A revoked channel or a departed publisher has no name to show.
 */
export async function listCollectionUsers(deps: Deps, req: Request): Promise<Response> {
  const collectionId = req.params.collectionId!;
  await visibleCollection(deps, req, collectionId);
  const uses = (
    await deps.db.send(
      new QueryCommand({ TableName: deps.table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :u)', ExpressionAttributeValues: { ':pk': `COL#${collectionId}`, ':u': 'USEDBY#' } }),
    )
  ).Items ?? [];
  const items = await Promise.all(
    uses.map(async (u) => {
      const channel = await get(deps, `CH#${String(u.channelId)}`, 'CH');
      const publisher = await get(deps, `PUB#${String(u.publisherId)}`, 'PUB');
      const name = channel?.status === 'active' ? (channel.latestApproved as { name?: string } | undefined)?.name : undefined;
      return {
        channelId: String(u.channelId),
        ...(name ? { channelName: name } : {}),
        channelVersion: Number(u.channelVersion),
        publisherName: publisher && publisher.status !== 'deleted' ? String(publisher.displayName) : '',
        resources: Object.keys((u.resources as Record<string, string> | undefined) ?? {}),
      };
    }),
  );
  return json(200, { items });
}

// ---- submissions ----

/**
 * Starts a collection submission and hands out where to upload the package (no icon, M-19). One
 * pending submission per collection, and the day's uploads counted with the channels' (M-19).
 */
export async function createCollectionSubmission(deps: Deps, req: Request): Promise<Response> {
  const collectionId = req.params.collectionId!;
  const { collection, account } = await visibleCollection(deps, req, collectionId);
  if (!account) return fail('forbidden', 'only the collection’s producer submits');
  requireActive(account);
  if (account.pendingTransferId) fail('transfer_pending', 'a key transfer is pending');
  const body = object(req.body ?? {});
  const note = text(body, 'note', { max: 2000, optional: true, min: 0 });

  const now = deps.now();
  let stale: string | undefined;
  if (collection.pendingSubmissionId) {
    const pending = await get(deps, `COL#${collectionId}`, `SUB#${String(collection.pendingSubmissionId)}`);
    const abandoned = !pending || (pending.state === 'uploading' && Date.parse(String(pending.createdAt)) < now.getTime() - UPLOAD_EXPIRY_MS);
    if (!abandoned) fail('pending_submission_exists', `submission ${String(collection.pendingSubmissionId)} is still pending`);
    stale = String(collection.pendingSubmissionId);
  }
  const publisherId = String(account.publisherId);
  const max = Number((account.limits as { uploadsPerDay?: number } | undefined)?.uploadsPerDay ?? DEFAULT_LIMITS.uploadsPerDay);
  const submissionId = ulid(now.getTime());
  const intakeKey = `intake-col/${collectionId}/${submissionId}.zip`;
  const at = now.toISOString();
  const item = {
    PK: `COL#${collectionId}`, SK: `SUB#${submissionId}`, type: 'submission', kind: 'collection', submissionId, collectionId, publisherId,
    accountId: String(account.activeAccountId), state: 'uploading', intakeKey, ...(note ? { note } : {}),
    rev: 1, createdAt: at, updatedAt: at, ttl: Math.floor((now.getTime() + UPLOAD_EXPIRY_MS) / 1000) + 24 * 3600,
  };
  const items: TransactItems = [
    {
      Update: {
        TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `QUOTA#${jstDate(now)}` },
        UpdateExpression: 'ADD uploads :one SET #ttl = :ttl', ConditionExpression: 'attribute_not_exists(uploads) OR uploads < :max',
        ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':one': 1, ':max': max, ':ttl': Math.floor(now.getTime() / 1000) + 3 * 24 * 3600 },
      },
    },
    {
      Update: {
        TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: 'COL' },
        UpdateExpression: 'SET pendingSubmissionId = :sid, updatedAt = :now, rev = rev + :one',
        ConditionExpression: stale ? 'pendingSubmissionId = :stale' : 'attribute_not_exists(pendingSubmissionId)',
        ExpressionAttributeValues: { ':sid': submissionId, ':now': at, ':one': 1, ...(stale ? { ':stale': stale } : {}) },
      },
    },
    { Put: { TableName: deps.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
    auditItem(deps, req.caller, { action: 'collection.submission.create', target: `COL#${collectionId}`, detail: { submissionId } }),
  ];
  if (stale && (await get(deps, `COL#${collectionId}`, `SUB#${stale}`))) {
    items.push({
      Update: {
        TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: `SUB#${stale}` },
        UpdateExpression: 'SET #s = :expired, updatedAt = :now, rev = rev + :one', ConditionExpression: '#s = :uploading',
        ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':expired': 'expired', ':uploading': 'uploading', ':now': at, ':one': 1 },
      },
    });
  }
  await transact(deps, items, {
    0: ['quota_exceeded', `uploads per day: ${max} (resets at midnight in Japan)`],
    1: ['pending_submission_exists', 'another submission started meanwhile'],
  });
  const pkg = await deps.presignUpload(intakeKey, 'application/zip', MAX_PACKAGE);
  return json(
    201,
    { submission: collectionSubmissionView(item), uploads: { package: { ...pkg, maxBytes: MAX_PACKAGE } }, uploadExpiresAt: new Date(now.getTime() + UPLOAD_WINDOW_MS).toISOString() },
    { etag: '"1"' },
  );
}

export async function listCollectionSubmissions(deps: Deps, req: Request): Promise<Response> {
  const collectionId = req.params.collectionId!;
  await visibleCollection(deps, req, collectionId);
  const { items, nextCursor } = await page(deps, req, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
    // Reviews share the SUB# prefix; keep the submissions.
    FilterExpression: '#type = :submission',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: { ':pk': `COL#${collectionId}`, ':s': 'SUB#', ':submission': 'submission' },
    ScanIndexForward: false,
  });
  return json(200, { items: items.map(collectionSubmissionView), nextCursor });
}

export async function getCollectionSubmission(deps: Deps, req: Request): Promise<Response> {
  await visibleCollection(deps, req, req.params.collectionId!);
  return withEtag(200, collectionSubmissionView(await loadCollectionSubmission(deps, req.params.collectionId!, req.params.submissionId!)));
}

/** The producer takes back a submission waiting for or in review. */
export async function withdrawCollectionSubmission(deps: Deps, req: Request): Promise<Response> {
  const collectionId = req.params.collectionId!;
  const submissionId = req.params.submissionId!;
  const { account } = await visibleCollection(deps, req, collectionId);
  if (!account) return fail('forbidden', 'only the collection’s producer withdraws');
  const rev = ifMatch(req);
  const sub = await loadCollectionSubmission(deps, collectionId, submissionId);
  if (sub.rev !== rev) fail('precondition_failed', `the submission is at rev ${String(sub.rev)}`);
  if (sub.state !== 'awaiting_review' && sub.state !== 'in_review') fail('invalid_state', `the submission is ${String(sub.state)}`);
  const now = deps.now().toISOString();
  await transact(
    deps,
    [
      {
        Update: {
          TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: `SUB#${submissionId}` },
          UpdateExpression: 'SET #s = :withdrawn, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK',
          ConditionExpression: 'rev = :rev AND #s = :from', ExpressionAttributeNames: { '#s': 'state' },
          ExpressionAttributeValues: { ':withdrawn': 'withdrawn', ':now': now, ':one': 1, ':rev': rev, ':from': sub.state },
        },
      },
      {
        Update: {
          TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: 'COL' },
          UpdateExpression: 'SET updatedAt = :now, rev = rev + :one REMOVE pendingSubmissionId',
          ConditionExpression: 'pendingSubmissionId = :sid', ExpressionAttributeValues: { ':now': now, ':one': 1, ':sid': submissionId },
        },
      },
      auditItem(deps, req.caller, { action: 'collection.submission.withdraw', target: `COL#${collectionId}`, detail: { submissionId } }),
    ],
    { 0: ['precondition_failed', 'changed by someone else; read it again'] },
  );
  await deps.archiveUpload(String(sub.intakeKey)).catch(() => undefined);
  return withEtag(200, collectionSubmissionView(await loadCollectionSubmission(deps, collectionId, submissionId)));
}
