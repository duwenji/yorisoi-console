import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { notifyAfter, type Deps, type Notice } from './deps.js';
import type { Item } from './shared.js';

// The records of use (DM-001 M-22, `COL#{collectionId}` / `USEDBY#{channelId}`): which listed
// channel names which resources of which collection. Written at a channel's approval, read for
// D-8 and for telling the channels' publishers what happened to a collection (D-18).

/** The records of use a channel holds, by collection (GSI1 `CH#{channelId}` / `USES#`). */
export async function usesOfChannel(deps: Deps, channelId: string): Promise<Item[]> {
  const out = await deps.db.send(
    new QueryCommand({ TableName: deps.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :u)', ExpressionAttributeValues: { ':pk': `CH#${channelId}`, ':u': 'USES#' } }),
  );
  return out.Items ?? [];
}

/** The records of use of a collection: the channels that use it. */
export async function usesOfCollection(deps: Deps, collectionId: string): Promise<Item[]> {
  const out = await deps.db.send(
    new QueryCommand({
      TableName: deps.table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :u)', ExpressionAttributeValues: { ':pk': `COL#${collectionId}`, ':u': 'USEDBY#' }, ConsistentRead: true,
    }),
  );
  return out.Items ?? [];
}

/** Deletes a channel's records of use (revoked or left, DES-008 K-9). */
export function deleteUses(deps: Deps, uses: Item[]) {
  return uses.map((u) => ({ Delete: { TableName: deps.table, Key: { PK: String(u.PK), SK: String(u.SK) } } }));
}

/** Every account id an account has used: its key now and those it moved from (DM-001 KEY). */
export async function accountIdsOf(deps: Deps, publisherId: string): Promise<string[]> {
  const out = await deps.db.send(
    new QueryCommand({ TableName: deps.table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :k)', ExpressionAttributeValues: { ':pk': `PUB#${publisherId}`, ':k': 'KEY#' } }),
  );
  return (out.Items ?? []).map((k) => String(k.accountId));
}

/** Whether a collection's grants let an account (by any of its ids) use it (MATERIALS D-9). */
export function granted(grants: { publishers?: '*' | string[] } | undefined, accountIds: string[]): boolean {
  const publishers = grants?.publishers;
  return publishers === '*' || (Array.isArray(publishers) && accountIds.some((id) => publishers.includes(id)));
}

/**
 * Tells the publishers of the channels that use a collection what happened to it (API-001 C-20,
 * DES-008 K-11), one notice per channel. [only] narrows it to some channels.
 */
export async function notifyUsers(
  deps: Deps,
  uses: Item[],
  event: Extract<Notice['event'], 'collection.updated' | 'collection.revoked_used' | 'collection.grants_narrowed'>,
  collectionId: string,
  extra: Pick<Notice, 'version' | 'message'> = {},
): Promise<void> {
  for (const u of uses) {
    await notifyAfter(deps, { event, publisherId: String(u.publisherId), channelId: String(u.channelId), collectionId, ...extra });
  }
}
