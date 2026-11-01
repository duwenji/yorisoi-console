import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { ProblemCode, Schemas } from '@yorisoi-console/api-types';
import { CHANNEL_ID, accountId, b64url, providerId, utf8, verifyEd25519 } from '@yorisoi-console/protocol';
import { auditItem, type Deps } from './deps.js';
import { fail, ifMatch, json, noContent, object, requiredText, text, withEtag, type Request, type Response } from './http.js';
import { DEFAULT_LIMITS, channelView, get, loadChannel, loadPublisher, offeredIn, page, publisherView, type Item } from './shared.js';
import { deleteUses, notifyUsers, usesOfChannel, usesOfCollection } from './uses.js';
import { jstDate, ulid } from './util.js';

const CHALLENGE_MS = 10 * 60_000;
const UPLOAD_WINDOW_MS = 15 * 60_000;
/** An upload that never arrived frees its channel after an hour (DM-001 SUBMISSION `expired`). */
const UPLOAD_EXPIRY_MS = 60 * 60_000;
const MAX_PACKAGE = 2 * 1024 * 1024;
const MAX_ICON = 100 * 1024;
const TICKET_MS = 7 * 24 * 3600_000;

// ---- helpers ----

function requirePublisherRole(req: Request) {
  if (!req.caller.roles.includes('publisher')) fail('forbidden', 'publishers only');
}

/** The caller's own publisher (API-001: one user, one publisher). */
export async function myPublisher(deps: Deps, req: Request): Promise<Item> {
  requirePublisherRole(req);
  const user = await get(deps, `USER#${req.caller.sub}`, 'USER');
  if (!user?.publisherId) return fail('not_found', 'register as a publisher first');
  return loadPublisher(deps, String(user.publisherId));
}

function requireActive(pub: Item) {
  if (pub.status !== 'active') fail('publisher_not_active', `the publisher is ${String(pub.status)}`);
}

/** A channel the caller may see: their own, or any for an operator. Others' are 404 (API-001 権限). */
async function visibleChannel(deps: Deps, req: Request, channelId: string): Promise<{ channel: Item; publisher?: Item }> {
  const channel = await loadChannel(deps, channelId);
  if (req.caller.roles.includes('operator')) return { channel };
  const pub = await myPublisher(deps, req);
  if (channel.publisherId !== pub.publisherId) fail('not_found', `no channel ${channelId}`);
  return { channel, publisher: pub };
}

/** Indexes of the transaction items whose condition failed. */
function failedConditions(e: unknown): number[] {
  if (!(e instanceof TransactionCanceledException)) return [];
  return (e.CancellationReasons ?? []).flatMap((r, i) => (r.Code === 'ConditionalCheckFailed' ? [i] : []));
}

/** Runs a transaction, turning a failed condition at a given index into that error. */
export async function transact(deps: Deps, items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>, onFail: Record<number, [ProblemCode, string]>) {
  try {
    await deps.db.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    for (const i of failedConditions(e)) if (onFail[i]) fail(...onFail[i]);
    if (e instanceof TransactionCanceledException) fail('precondition_failed', 'changed by someone else; read it again');
    throw e;
  }
}

export function submissionView(item: Item): Schemas['Submission'] {
  return {
    submissionId: String(item.submissionId),
    channelId: String(item.channelId),
    version: (item.version as number | undefined) ?? null,
    accountId: String(item.accountId),
    state: item.state as Schemas['SubmissionState'],
    ...(item.description !== undefined ? { description: String(item.description) } : {}),
    ...(item.tags ? { tags: item.tags as string[] } : {}),
    ...(item.regions ? { regions: item.regions as string[] } : {}),
    // What the machine review read from the package (DES-011 N-3, N-9); nothing before it ran.
    ...ecosystemOf(item.listing as { activities: string[]; genres: string[]; requires: string[] } | undefined),
    ...(item.note !== undefined ? { note: String(item.note) } : {}),
    sha256: (item.sha256 as string | undefined) ?? null,
    size: (item.size as number | undefined) ?? null,
    validation: (item.validation as Schemas['Validation'] | undefined) ?? null,
    decision: (item.decision as Schemas['Decision'] | undefined) ?? null,
    submittedAt: (item.submittedAt as string | undefined) ?? null,
    decidedAt: (item.decidedAt as string | undefined) ?? null,
    rev: Number(item.rev),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

function ecosystemOf(listing: { activities: string[]; genres: string[]; requires: string[] } | undefined) {
  if (!listing) return {};
  const { activities, genres, requires } = listing;
  return { activities, genres, requires, offeredIn: offeredIn({ activities, requires }) };
}

function textList(o: Record<string, unknown>, key: string, max: number, pattern: RegExp): string[] | undefined {
  const value = o[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || !value.every((v) => typeof v === 'string' && pattern.test(v))) {
    return fail('invalid_request', `${key} is malformed`, [{ path: `/${key}`, message: `up to ${max} items of ${pattern.source}` }]);
  }
  return value as string[];
}

// ---- the publisher ----

export async function registerPublisher(deps: Deps, req: Request): Promise<Response> {
  requirePublisherRole(req);
  const body = object(req.body);
  const displayName = requiredText(body, 'displayName', { max: 40 });
  const contact = requiredText(body, 'contact', { max: 200 });
  const now = deps.now().toISOString();
  const publisherId = ulid(deps.now().getTime());
  const item = {
    PK: `PUB#${publisherId}`, SK: 'PUB', type: 'publisher', publisherId, ownerSub: req.caller.sub, displayName, contact,
    roles: ['publisher'], status: 'pending_key', channelCount: 0, rev: 1, createdAt: now, updatedAt: now, GSI2PK: 'PUBLISHERS', GSI2SK: now,
  };
  await transact(
    deps,
    [
      { Put: { TableName: deps.table, Item: { PK: `USER#${req.caller.sub}`, SK: 'USER', type: 'user', publisherId }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: deps.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      auditItem(deps, req.caller, { action: 'publisher.register', target: `PUB#${publisherId}` }),
    ],
    { 0: ['already_registered', 'you are already a publisher'] },
  );
  return withEtag(201, await publisherView(deps, item));
}

export async function getMyPublisher(deps: Deps, req: Request): Promise<Response> {
  return withEtag(200, await publisherView(deps, await myPublisher(deps, req)));
}

export async function updateMyPublisher(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  const rev = ifMatch(req);
  const body = object(req.body);
  const displayName = text(body, 'displayName', { max: 40, optional: true });
  const contact = text(body, 'contact', { max: 200, optional: true });
  if (displayName === undefined && contact === undefined) fail('invalid_request', 'nothing to change');
  if (pub.rev !== rev) fail('precondition_failed', `the publisher is at rev ${String(pub.rev)}`);
  if (pub.status === 'deleted') fail('invalid_state', 'the publisher has left');
  const sets = [...(displayName !== undefined ? ['displayName = :n'] : []), ...(contact !== undefined ? ['contact = :c'] : [])];
  // A new name is checked again before the next collection is approved (DM-001 M-17, D-20).
  const renamed = displayName !== undefined && displayName !== pub.displayName && pub.producerVerification !== undefined;
  await transact(
    deps,
    [
      {
        Update: {
          TableName: deps.table,
          Key: { PK: `PUB#${String(pub.publisherId)}`, SK: 'PUB' },
          UpdateExpression: `SET ${sets.join(', ')}, updatedAt = :now, rev = rev + :one${renamed ? ' REMOVE producerVerification' : ''}`,
          ConditionExpression: 'rev = :rev',
          ExpressionAttributeValues: {
            ':now': deps.now().toISOString(), ':one': 1, ':rev': rev,
            ...(displayName !== undefined ? { ':n': displayName } : {}), ...(contact !== undefined ? { ':c': contact } : {}),
          },
        },
      },
      auditItem(deps, req.caller, { action: 'publisher.update', target: `PUB#${String(pub.publisherId)}`, detail: { displayName: displayName ?? null, contactChanged: contact !== undefined } }),
    ],
    { 0: ['precondition_failed', 'changed by someone else; read it again'] },
  );
  return withEtag(200, await publisherView(deps, await loadPublisher(deps, String(pub.publisherId))));
}

/**
 * Leaving (API-001 C-4, DM-001 M-15): listed channels are revoked, pending submissions withdrawn,
 * the name and contact removed and the Cognito user deleted. The audit log, the account id and
 * the channel ids stay, so none of them can be reused.
 */
export async function deleteMyPublisher(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  const rev = ifMatch(req);
  const publisherId = String(pub.publisherId);
  if (object(req.body).confirm !== publisherId) fail('invalid_request', 'confirm must be your publisherId', [{ path: '/confirm', message: 'your publisherId' }]);
  if (pub.rev !== rev) fail('precondition_failed', `the publisher is at rev ${String(pub.rev)}`);
  if (pub.status === 'deleted') fail('invalid_state', 'the publisher has already left');

  const now = deps.now().toISOString();
  const channels = (
    await deps.db.send(
      new QueryCommand({ TableName: deps.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :ch)', ExpressionAttributeValues: { ':pk': `PUB#${publisherId}`, ':ch': 'CH#' } }),
    )
  ).Items ?? [];
  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [];
  const archives: string[] = [];
  let revoked = false;
  for (const ch of channels) {
    const channelId = String(ch.channelId);
    const listed = ch.status === 'active' && ch.GSI2PK === 'LISTED';
    if (listed) {
      revoked = true;
      items.push({
        Put: {
          TableName: deps.table,
          Item: { PK: `CH#${channelId}`, SK: `REVOKE#${now}`, type: 'revocation', channelId, reason: 'チャンネル提供者が退会したため', severity: 'low', operatorSub: req.caller.sub, revokedAt: now, GSI2PK: 'REVOKED', GSI2SK: `${now}#${channelId}` },
        },
      });
      const approved = (ch.latestApproved as { submissionId?: string } | undefined)?.submissionId;
      if (approved) {
        items.push({
          Update: {
            TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${approved}` },
            UpdateExpression: 'SET #s = :revoked, updatedAt = :now, rev = rev + :one', ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: { ':revoked': 'revoked', ':now': now, ':one': 1 },
          },
        });
      }
    }
    if (ch.pendingSubmissionId) {
      const sid = String(ch.pendingSubmissionId);
      const sub = await get(deps, `CH#${channelId}`, `SUB#${sid}`);
      if (sub) {
        items.push({
          Update: {
            TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${sid}` },
            UpdateExpression: 'SET #s = :w, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK, #ttl',
            ExpressionAttributeNames: { '#s': 'state', '#ttl': 'ttl' }, ExpressionAttributeValues: { ':w': 'withdrawn', ':now': now, ':one': 1 },
          },
        });
        archives.push(String(sub.intakeKey), String(sub.iconIntakeKey));
      }
    }
    if (listed || ch.pendingSubmissionId) {
      items.push({
        Update: {
          TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: 'CH' },
          UpdateExpression: `SET ${listed ? '#s = :revoked, ' : ''}updatedAt = :now, rev = rev + :one REMOVE pendingSubmissionId${listed ? ', GSI2PK, GSI2SK' : ''}`,
          ...(listed ? { ExpressionAttributeNames: { '#s': 'status' } } : {}),
          ExpressionAttributeValues: { ':now': now, ':one': 1, ...(listed ? { ':revoked': 'revoked' } : {}) },
        },
      });
    }
  }
  // The channels it listed no longer use any collection (DES-008 K-9).
  for (const ch of channels) if (ch.status === 'active' && ch.GSI2PK === 'LISTED') items.push(...deleteUses(deps, await usesOfChannel(deps, String(ch.channelId))));
  // Its collections go too, as its channels do (API-001 C-22, DM-001 M-25).
  const collections = (
    await deps.db.send(
      new QueryCommand({ TableName: deps.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :c)', ExpressionAttributeValues: { ':pk': `PUB#${publisherId}`, ':c': 'COL#' } }),
    )
  ).Items ?? [];
  const revokedCollections: string[] = [];
  for (const col of collections) {
    const collectionId = String(col.collectionId);
    const listed = col.status === 'active' && col.GSI2PK === 'LISTED';
    if (listed) {
      revoked = true;
      revokedCollections.push(collectionId);
      items.push({
        Put: {
          TableName: deps.table,
          Item: {
            PK: `COL#${collectionId}`, SK: `REVOKE#${now}`, type: 'revocation', kind: 'collection', collectionId, reason: '素材提供者が退会したため', severity: 'low',
            operatorSub: req.caller.sub, revokedAt: now, GSI2PK: 'REVOKED', GSI2SK: `${now}#col:${collectionId}`,
          },
        },
      });
      const approved = (col.latestApproved as { submissionId?: string } | undefined)?.submissionId;
      if (approved) {
        items.push({
          Update: {
            TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: `SUB#${approved}` },
            UpdateExpression: 'SET #s = :revoked, updatedAt = :now, rev = rev + :one', ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: { ':revoked': 'revoked', ':now': now, ':one': 1 },
          },
        });
      }
    }
    if (col.pendingSubmissionId) {
      const sid = String(col.pendingSubmissionId);
      const sub = await get(deps, `COL#${collectionId}`, `SUB#${sid}`);
      if (sub) {
        items.push({
          Update: {
            TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: `SUB#${sid}` },
            UpdateExpression: 'SET #s = :w, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK, #ttl',
            ExpressionAttributeNames: { '#s': 'state', '#ttl': 'ttl' }, ExpressionAttributeValues: { ':w': 'withdrawn', ':now': now, ':one': 1 },
          },
        });
        archives.push(String(sub.intakeKey));
      }
    }
    if (listed || col.pendingSubmissionId) {
      items.push({
        Update: {
          TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: 'COL' },
          UpdateExpression: `SET ${listed ? '#s = :revoked, ' : ''}updatedAt = :now, rev = rev + :one REMOVE pendingSubmissionId${listed ? ', GSI2PK, GSI2SK' : ''}`,
          ...(listed ? { ExpressionAttributeNames: { '#s': 'status' } } : {}),
          ExpressionAttributeValues: { ':now': now, ':one': 1, ...(listed ? { ':revoked': 'revoked' } : {}) },
        },
      });
    }
  }
  if (pub.pendingTransferId) {
    const transfer = await get(deps, `PUB#${publisherId}`, `TRANSFER#${String(pub.pendingTransferId)}`);
    if (transfer) {
      items.push(
        {
          Update: {
            TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `TRANSFER#${String(transfer.transferId)}` },
            UpdateExpression: 'SET #s = :c, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK', ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: { ':c': 'cancelled', ':now': now, ':one': 1 },
          },
        },
        {
          Update: {
            TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `KEY#${String(transfer.toAccountId)}` },
            UpdateExpression: 'SET #s = :u, unboundAt = :now, unboundReason = :why', ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':u': 'unbound', ':now': now, ':why': 'transfer_cancelled' },
          },
        },
      );
    }
  }
  items.push(
    {
      Update: {
        TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' },
        UpdateExpression: 'SET #s = :deleted, deletedAt = :now, displayName = :gone, updatedAt = :now, rev = rev + :one REMOVE contact, statusReason, pendingTransferId',
        ConditionExpression: 'rev = :rev', ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':deleted': 'deleted', ':gone': '（退会した提供者）', ':now': now, ':one': 1, ':rev': rev },
      },
    },
    { Delete: { TableName: deps.table, Key: { PK: `USER#${req.caller.sub}`, SK: 'USER' } } },
    auditItem(deps, req.caller, { action: 'publisher.delete', target: `PUB#${publisherId}`, detail: { channels: channels.map((c) => c.channelId), collections: collections.map((c) => c.collectionId) } }),
  );
  // DynamoDB takes at most 100 writes at once: 5 channels and 5 collections need about 50 (DM-001).
  if (items.length > 100) fail('invalid_state', 'too much to remove at once; ask an operator to revoke some channels or collections first');
  await transact(deps, items, {});
  for (const key of archives) await deps.archiveUpload(key).catch(() => undefined);
  await deps.deleteUser(req.caller.sub);
  if (revoked) await deps.requestPublish('revoke');
  // The channels that used its collections hear they are gone (D-18).
  for (const collectionId of revokedCollections) {
    await notifyUsers(deps, await usesOfCollection(deps, collectionId), 'collection.revoked_used', collectionId, { message: '素材提供者が退会したため' });
  }
  return noContent();
}

// ---- keys ----

export async function createKeyChallenge(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  if (pub.status !== 'pending_key' && pub.status !== 'active') fail('publisher_not_active', `the publisher is ${String(pub.status)}`);
  const nonce = ulid(deps.now().getTime());
  const expiresAt = new Date(deps.now().getTime() + CHALLENGE_MS);
  const message = `yorisoi-console:bind-key:${nonce}:${String(pub.publisherId)}`;
  await deps.db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: deps.table,
            Item: { PK: `PUB#${String(pub.publisherId)}`, SK: `CHALLENGE#${nonce}`, type: 'challenge', message, expiresAt: expiresAt.toISOString(), ttl: Math.floor(expiresAt.getTime() / 1000) },
          },
        },
      ],
    }),
  );
  return json(201, { nonce, message, expiresAt: expiresAt.toISOString() });
}

/** Proof that the caller holds the key: its signature over a challenge they just got (ARCH-001 A-5). */
export async function provenKey(deps: Deps, pub: Item, body: Record<string, unknown>) {
  const nonce = requiredText(body, 'nonce', { max: 26, pattern: /^[0-9A-HJKMNP-TV-Z]{26}$/ });
  const challenge = await get(deps, `PUB#${String(pub.publisherId)}`, `CHALLENGE#${nonce}`);
  if (!challenge || Date.parse(String(challenge.expiresAt)) <= deps.now().getTime()) fail('challenge_invalid', 'the challenge is unknown, used or expired');
  let publicKey: Uint8Array;
  let signature: Uint8Array;
  try {
    publicKey = b64url.decode(requiredText(body, 'publicKey', { max: 64 }));
    signature = b64url.decode(requiredText(body, 'signature', { max: 128 }));
  } catch {
    return fail('invalid_request', 'publicKey and signature must be base64url');
  }
  if (publicKey.length !== 32) fail('invalid_request', 'publicKey must be a 32-byte Ed25519 key');
  if (!verifyEd25519(publicKey, utf8.encode(String(challenge!.message)), signature)) fail('invalid_signature', 'the signature does not match the challenge');
  return { nonce, publicKey, account: accountId(publicKey) };
}

export async function bindFirstKey(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  const publisherId = String(pub.publisherId);
  if (pub.activeAccountId) fail('key_already_bound', 'you already have a key; use a key transfer to change it');
  if (pub.status !== 'pending_key') fail('publisher_not_active', `the publisher is ${String(pub.status)}`);
  const { nonce, publicKey, account } = await provenKey(deps, pub, object(req.body));
  const now = deps.now().toISOString();
  const key = { PK: `PUB#${publisherId}`, SK: `KEY#${account}`, type: 'publisher-key', accountId: account, publicKey: b64url.encode(publicKey), status: 'active', boundAt: now };
  await transact(
    deps,
    [
      { Delete: { TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `CHALLENGE#${nonce}` }, ConditionExpression: 'attribute_exists(PK)' } },
      { Put: { TableName: deps.table, Item: { PK: `ACCOUNT#${account}`, SK: 'ACCOUNT', type: 'account', publisherId }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: deps.table, Item: key } },
      {
        Update: {
          TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' },
          UpdateExpression: 'SET activeAccountId = :a, #s = :active, updatedAt = :now, rev = rev + :one',
          ConditionExpression: '#s = :pending AND attribute_not_exists(activeAccountId)', ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':a': account, ':active': 'active', ':pending': 'pending_key', ':now': now, ':one': 1 },
        },
      },
      auditItem(deps, req.caller, { action: 'key.bind', target: `PUB#${publisherId}`, detail: { accountId: account } }),
    ],
    { 0: ['challenge_invalid', 'the challenge was already used'], 1: ['account_id_taken', `${account} is or was used by a publisher`], 3: ['key_already_bound', 'a key was bound meanwhile'] },
  );
  return json(201, { accountId: account, publicKey: key.publicKey, status: 'active', boundAt: now });
}

export async function listMyKeys(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  const out = await deps.db.send(
    new QueryCommand({ TableName: deps.table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :k)', ExpressionAttributeValues: { ':pk': `PUB#${String(pub.publisherId)}`, ':k': 'KEY#' } }),
  );
  return json(200, {
    items: (out.Items ?? []).map((k) => ({
      accountId: k.accountId, publicKey: k.publicKey, status: k.status, boundAt: k.boundAt,
      ...(k.unboundAt ? { unboundAt: k.unboundAt } : {}), ...(k.unboundReason ? { unboundReason: k.unboundReason } : {}),
    })),
  });
}

// ---- channels ----

export async function registerChannel(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  requireActive(pub);
  const channelId = requiredText(object(req.body), 'channelId', { min: 3, max: 40, pattern: CHANNEL_ID });
  const publisherId = String(pub.publisherId);
  const max = Number((pub.limits as { channels?: number } | undefined)?.channels ?? DEFAULT_LIMITS.channels);
  const now = deps.now().toISOString();
  const item = {
    PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId, status: 'active', rev: 1, createdAt: now, updatedAt: now,
    GSI1PK: `PUB#${publisherId}`, GSI1SK: `CH#${channelId}`,
  };
  await transact(
    deps,
    [
      { Put: { TableName: deps.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      {
        Update: {
          TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: 'PUB' },
          UpdateExpression: 'SET channelCount = channelCount + :one, updatedAt = :now, rev = rev + :one',
          ConditionExpression: '#s = :active AND channelCount < :max', ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':one': 1, ':now': now, ':active': 'active', ':max': max },
        },
      },
      auditItem(deps, req.caller, { action: 'channel.register', target: `CH#${channelId}` }),
    ],
    { 0: ['channel_id_taken', `${channelId} is taken`], 1: ['limit_reached', `up to ${max} channels`] },
  );
  return withEtag(201, await channelView(deps, item));
}

export async function listMyChannels(deps: Deps, req: Request): Promise<Response> {
  const pub = await myPublisher(deps, req);
  const out = await deps.db.send(
    new QueryCommand({ TableName: deps.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :ch)', ExpressionAttributeValues: { ':pk': `PUB#${String(pub.publisherId)}`, ':ch': 'CH#' } }),
  );
  return json(200, { items: await Promise.all((out.Items ?? []).map((c) => channelView(deps, c))) });
}

export async function getChannel(deps: Deps, req: Request): Promise<Response> {
  const { channel } = await visibleChannel(deps, req, req.params.channelId!);
  return withEtag(200, await channelView(deps, channel));
}

// ---- submissions ----

/**
 * Starts a submission and hands out where to upload the package and the icon (API-001 C-10).
 * One pending submission per channel and the day's quota are enforced in one transaction
 * (DM-001 M-2, DV-03, DV-04). An upload that never arrived frees the channel after an hour.
 */
export async function createSubmission(deps: Deps, req: Request): Promise<Response> {
  const channelId = req.params.channelId!;
  const { channel, publisher } = await visibleChannel(deps, req, channelId);
  if (!publisher) return fail('forbidden', 'only the channel’s publisher submits');
  requireActive(publisher);
  if (publisher.pendingTransferId) fail('transfer_pending', 'a key transfer is pending');
  const body = object(req.body);
  const description = text(body, 'description', { max: 1000, optional: true, min: 0 });
  const tags = textList(body, 'tags', 8, /^[a-z0-9-]{1,20}$/);
  const regions = textList(body, 'regions', 8, /^[0-9b-hjkmnp-z]{1,8}$/);
  const note = text(body, 'note', { max: 2000, optional: true, min: 0 });

  const now = deps.now();
  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [];
  // A pending submission whose upload never came (or that expired away) no longer holds the channel.
  let stale: string | undefined;
  if (channel.pendingSubmissionId) {
    const pending = await get(deps, `CH#${channelId}`, `SUB#${String(channel.pendingSubmissionId)}`);
    const abandoned = !pending || (pending.state === 'uploading' && Date.parse(String(pending.createdAt)) < now.getTime() - UPLOAD_EXPIRY_MS);
    if (!abandoned) fail('pending_submission_exists', `submission ${String(channel.pendingSubmissionId)} is still pending`);
    stale = String(channel.pendingSubmissionId);
  }

  const publisherId = String(publisher.publisherId);
  const max = Number((publisher.limits as { uploadsPerDay?: number } | undefined)?.uploadsPerDay ?? DEFAULT_LIMITS.uploadsPerDay);
  const submissionId = ulid(now.getTime());
  const intakeKey = `intake/${channelId}/${submissionId}.zip`;
  const iconIntakeKey = `intake/${channelId}/${submissionId}.png`;
  const at = now.toISOString();
  const item = {
    PK: `CH#${channelId}`, SK: `SUB#${submissionId}`, type: 'submission', submissionId, channelId, publisherId,
    accountId: String(publisher.activeAccountId), state: 'uploading', intakeKey, iconIntakeKey,
    ...(description ? { description } : {}), ...(tags ? { tags } : {}), ...(regions ? { regions } : {}), ...(note ? { note } : {}),
    rev: 1, createdAt: at, updatedAt: at, ttl: Math.floor((now.getTime() + UPLOAD_EXPIRY_MS) / 1000) + 24 * 3600,
  };
  items.push(
    {
      Update: {
        TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `QUOTA#${jstDate(now)}` },
        UpdateExpression: 'ADD uploads :one SET #ttl = :ttl', ConditionExpression: 'attribute_not_exists(uploads) OR uploads < :max',
        ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':one': 1, ':max': max, ':ttl': Math.floor(now.getTime() / 1000) + 3 * 24 * 3600 },
      },
    },
    {
      Update: {
        TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: 'CH' },
        UpdateExpression: 'SET pendingSubmissionId = :sid, updatedAt = :now, rev = rev + :one',
        ConditionExpression: stale ? 'pendingSubmissionId = :stale' : 'attribute_not_exists(pendingSubmissionId)',
        ExpressionAttributeValues: { ':sid': submissionId, ':now': at, ':one': 1, ...(stale ? { ':stale': stale } : {}) },
      },
    },
    { Put: { TableName: deps.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
    auditItem(deps, req.caller, { action: 'submission.create', target: `CH#${channelId}`, detail: { submissionId } }),
  );
  if (stale && (await get(deps, `CH#${channelId}`, `SUB#${stale}`))) {
    items.push({
      Update: {
        TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${stale}` },
        UpdateExpression: 'SET #s = :expired, updatedAt = :now, rev = rev + :one', ConditionExpression: '#s = :uploading',
        ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':expired': 'expired', ':uploading': 'uploading', ':now': at, ':one': 1 },
      },
    });
  }
  await transact(deps, items, {
    0: ['quota_exceeded', `uploads per day: ${max} (resets at midnight in Japan)`],
    1: ['pending_submission_exists', 'another submission started meanwhile'],
  });

  const [pkg, icon] = await Promise.all([
    deps.presignUpload(intakeKey, 'application/zip', MAX_PACKAGE),
    deps.presignUpload(iconIntakeKey, 'image/png', MAX_ICON),
  ]);
  return json(
    201,
    {
      submission: submissionView(item),
      uploads: { package: { ...pkg, maxBytes: MAX_PACKAGE }, icon: { ...icon, maxBytes: MAX_ICON } },
      uploadExpiresAt: new Date(now.getTime() + UPLOAD_WINDOW_MS).toISOString(),
    },
    { etag: '"1"' },
  );
}

export async function listSubmissions(deps: Deps, req: Request): Promise<Response> {
  const channelId = req.params.channelId!;
  await visibleChannel(deps, req, channelId);
  const { items, nextCursor } = await page(deps, req, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
    // Reviews and tickets share the SUB# prefix; keep the submissions.
    FilterExpression: '#type = :submission',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: { ':pk': `CH#${channelId}`, ':s': 'SUB#', ':submission': 'submission' },
    ScanIndexForward: false,
  });
  return json(200, { items: items.map(submissionView), nextCursor });
}

export async function loadSubmission(deps: Deps, channelId: string, submissionId: string): Promise<Item> {
  const item = await get(deps, `CH#${channelId}`, `SUB#${submissionId}`);
  return item?.type === 'submission' ? item : fail('not_found', `no submission ${submissionId}`);
}

export async function getSubmission(deps: Deps, req: Request): Promise<Response> {
  await visibleChannel(deps, req, req.params.channelId!);
  return withEtag(200, submissionView(await loadSubmission(deps, req.params.channelId!, req.params.submissionId!)));
}

/** The publisher takes back a submission waiting for or in review (DM-001 状態の移り方). */
export async function withdrawSubmission(deps: Deps, req: Request): Promise<Response> {
  const channelId = req.params.channelId!;
  const submissionId = req.params.submissionId!;
  const { publisher } = await visibleChannel(deps, req, channelId);
  if (!publisher) return fail('forbidden', 'only the channel’s publisher withdraws');
  const rev = ifMatch(req);
  const sub = await loadSubmission(deps, channelId, submissionId);
  if (sub.rev !== rev) fail('precondition_failed', `the submission is at rev ${String(sub.rev)}`);
  if (sub.state !== 'awaiting_review' && sub.state !== 'in_review') fail('invalid_state', `the submission is ${String(sub.state)}`);
  const now = deps.now().toISOString();
  await transact(
    deps,
    [
      {
        Update: {
          TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${submissionId}` },
          UpdateExpression: 'SET #s = :withdrawn, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK',
          ConditionExpression: 'rev = :rev AND #s = :from', ExpressionAttributeNames: { '#s': 'state' },
          ExpressionAttributeValues: { ':withdrawn': 'withdrawn', ':now': now, ':one': 1, ':rev': rev, ':from': sub.state },
        },
      },
      {
        Update: {
          TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: 'CH' },
          UpdateExpression: 'SET updatedAt = :now, rev = rev + :one REMOVE pendingSubmissionId',
          ConditionExpression: 'pendingSubmissionId = :sid', ExpressionAttributeValues: { ':now': now, ':one': 1, ':sid': submissionId },
        },
      },
      auditItem(deps, req.caller, { action: 'submission.withdraw', target: `CH#${channelId}`, detail: { submissionId } }),
    ],
    { 0: ['precondition_failed', 'changed by someone else; read it again'] },
  );
  await Promise.all([deps.archiveUpload(String(sub.intakeKey)), deps.archiveUpload(String(sub.iconIntakeKey))]).catch(() => undefined);
  return withEtag(200, submissionView(await loadSubmission(deps, channelId, submissionId)));
}

// ---- test tickets (API-CHANNEL-LIST 試用チケット, ARCH-001 A-13) ----

/** States whose package passed the machine review and still exists to try. */
const TRIABLE = ['awaiting_review', 'in_review', 'returned', 'approved'];

function ticketView(item: Item): Schemas['TestTicket'] {
  return {
    submissionId: String(item.submissionId),
    document: item.document as Schemas['SignedDocument'],
    qr: JSON.stringify(item.document),
    issuedAt: String(item.issuedAt),
    expiresAt: String(item.expiresAt),
  };
}

/**
 * A ticket that lets the publisher try a package on their own phone before it is approved
 * (developer mode only, 7 days, never shared). The package is copied to the public `trial/`
 * path, which forgets it after 7 days; the ticket is signed with the list's signing key.
 */
export async function issueTestTicket(deps: Deps, req: Request): Promise<Response> {
  const channelId = req.params.channelId!;
  const submissionId = req.params.submissionId!;
  const { publisher } = await visibleChannel(deps, req, channelId);
  if (!publisher) return fail('forbidden', 'only the channel’s publisher issues tickets');
  requireActive(publisher);
  const sub = await loadSubmission(deps, channelId, submissionId);
  const validation = sub.validation as { ok?: boolean } | undefined;
  if (!TRIABLE.includes(String(sub.state)) || !validation?.ok) fail('invalid_state', `the submission is ${String(sub.state)}; only a package that passed the machine review can be tried`);

  const now = deps.now();
  const sha256 = String(sub.sha256);
  const url =
    sub.state === 'approved'
      ? deps.packageUrl(sha256)
      : await deps.publishTrial(sub.state === 'returned' ? String(sub.intakeKey).replace(/^intake\//, 'archive/') : String(sub.intakeKey), sha256);
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TICKET_MS).toISOString();
  const document = await deps.signDocument({
    type: 'test-ticket',
    provider: providerId(b64url.decode(deps.rootPublicKey)),
    channel: channelId,
    publisher: String(sub.accountId),
    package: { url, sha256, size: Number(sub.size), format: 1 },
    issuedAt,
    expiresAt,
  });
  const publisherId = String(publisher.publisherId);
  const max = Number((publisher.limits as { ticketsPerDay?: number } | undefined)?.ticketsPerDay ?? DEFAULT_LIMITS.ticketsPerDay);
  const item = { PK: `CH#${channelId}`, SK: `SUB#${submissionId}#TICKET#${issuedAt}`, type: 'ticket', submissionId, document, issuedAt, expiresAt, packageUrl: url };
  await transact(
    deps,
    [
      {
        Update: {
          TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `QUOTA#${jstDate(now)}` },
          UpdateExpression: 'ADD tickets :one SET #ttl = :ttl', ConditionExpression: 'attribute_not_exists(tickets) OR tickets < :max',
          ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':one': 1, ':max': max, ':ttl': Math.floor(now.getTime() / 1000) + 3 * 24 * 3600 },
        },
      },
      { Put: { TableName: deps.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      auditItem(deps, req.caller, { action: 'ticket.issue', target: `CH#${channelId}`, detail: { submissionId, expiresAt } }),
    ],
    { 0: ['quota_exceeded', `test tickets per day: ${max} (resets at midnight in Japan)`] },
  );
  return json(201, ticketView(item));
}

export async function listTestTickets(deps: Deps, req: Request): Promise<Response> {
  const channelId = req.params.channelId!;
  const submissionId = req.params.submissionId!;
  await visibleChannel(deps, req, channelId);
  const out = await deps.db.send(
    new QueryCommand({
      TableName: deps.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :t)',
      ExpressionAttributeValues: { ':pk': `CH#${channelId}`, ':t': `SUB#${submissionId}#TICKET#` },
      ScanIndexForward: false,
    }),
  );
  return json(200, { items: (out.Items ?? []).map(ticketView) });
}
