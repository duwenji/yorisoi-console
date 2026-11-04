import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@yorisoi-console/api-types';
import { sha256Hex } from '@yorisoi-console/protocol';
import { guarded, type Deps } from './deps.js';
import { binary, fail, ifMatch, json, noContent, withEtag, type Request, type Response } from './http.js';
import { transact } from './publisher.js';
import { get, loadChannel, loadCollection, rolesOf, type Item } from './shared.js';
import { jstDate, ulid } from './util.js';

// DES-014: one draft per channel or collection, kept for its owner. The console never opens it;
// the browser edits it, signs a package from it and submits as before (R-1, R-13).

const MAX_DRAFT = 3 * 1024 * 1024;
const KEEP_MS = 180 * 24 * 3600_000;
/** A check still `running` after this was lost (R-19); a new one may start. */
const CHECK_STALE_MS = 15 * 60_000;
export const DRAFT_CHECKS_PER_DAY = 50;
const URL_MS = 5 * 60_000;

type Kind = 'channel' | 'collection';

interface Target {
  kind: Kind;
  id: string;
  pk: string;
  item: Item;
  account: Item;
}

/**
 * The caller's own channel or collection. Anyone else's, an operator included, is 404: a draft
 * is its owner's alone (R-6, API-001 C-28).
 */
async function ownTarget(deps: Deps, req: Request, kind: Kind): Promise<Target> {
  const id = kind === 'channel' ? req.params.channelId! : req.params.collectionId!;
  const none = (): never => fail('not_found', `no ${kind} ${id}`);
  if (!req.caller.roles.includes('publisher')) return none();
  const user = await get(deps, `USER#${req.caller.sub}`, 'USER');
  if (!user?.publisherId) return none();
  const item = kind === 'channel' ? await loadChannel(deps, id) : await loadCollection(deps, id);
  if (item.publisherId !== user.publisherId) return none();
  const account = (await get(deps, `PUB#${String(user.publisherId)}`, 'PUB')) ?? none();
  if (kind === 'collection' && !rolesOf(account).includes('producer')) fail('role_required', 'turn on the producer role first');
  return { kind, id, pk: kind === 'channel' ? `CH#${id}` : `COL#${id}`, item, account };
}

/** Saving needs an active account and a channel or collection not revoked (R-7). */
function requireWritable(t: Target) {
  if (t.account.status !== 'active') fail('publisher_not_active', `the account is ${String(t.account.status)}`);
  if (t.item.status !== 'active') fail('invalid_state', `the ${t.kind} is ${String(t.item.status)}`);
}

export function draftView(item: Item): Schemas['Draft'] {
  return {
    rev: Number(item.rev),
    size: Number(item.size),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
    expiresAt: String(item.expiresAt),
    check: (item.check as Schemas['Draft']['check']) ?? null,
  };
}

/** The draft's summary for the owner's view of a channel or collection (DES-014), or null. */
export async function draftSummary(deps: Deps, pk: string): Promise<Schemas['Draft'] | null> {
  const item = await get(deps, pk, 'DRAFT');
  return item ? draftView(item) : null;
}

export const getChannelDraft = (deps: Deps, req: Request) => getDraft(deps, req, 'channel');
export const putChannelDraft = (deps: Deps, req: Request) => putDraft(deps, req, 'channel');
export const deleteChannelDraft = (deps: Deps, req: Request) => deleteDraft(deps, req, 'channel');
export const checkChannelDraft = (deps: Deps, req: Request) => checkDraft(deps, req, 'channel');
export const getCollectionDraft = (deps: Deps, req: Request) => getDraft(deps, req, 'collection');
export const putCollectionDraft = (deps: Deps, req: Request) => putDraft(deps, req, 'collection');
export const deleteCollectionDraft = (deps: Deps, req: Request) => deleteDraft(deps, req, 'collection');
export const checkCollectionDraft = (deps: Deps, req: Request) => checkDraft(deps, req, 'collection');

async function getDraft(deps: Deps, req: Request, kind: Kind): Promise<Response> {
  const t = await ownTarget(deps, req, kind);
  const draft = (await get(deps, t.pk, 'DRAFT')) ?? fail('not_found', `no draft for ${t.id}`);
  return binary(200, await deps.drafts.get(String(draft.key)), 'application/zip', { etag: `"${String(draft.rev)}"` });
}

/** A local file header, or the end of an empty archive. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
}

/**
 * Saves a draft (R-4, R-12): the new bytes go to a new key, then the item moves to it on the
 * `rev` the client had, then the old key goes. Losing the race removes the new key, so the item
 * always names one key with its contents.
 */
async function putDraft(deps: Deps, req: Request, kind: Kind): Promise<Response> {
  const t = await ownTarget(deps, req, kind);
  requireWritable(t);
  const bytes = req.rawBody ?? fail('invalid_request', 'the body must be the draft as application/zip');
  if (bytes.length > MAX_DRAFT) fail('payload_too_large', `the draft is ${bytes.length} bytes (max ${MAX_DRAFT})`);
  if (!isZip(bytes)) fail('invalid_request', 'the draft is not a ZIP');
  const first = req.headers['if-none-match'] === '*';
  const rev = first ? undefined : ifMatch(req);

  const existing = await get(deps, t.pk, 'DRAFT');
  if (first && existing) fail('precondition_failed', `a draft exists at rev ${String(existing.rev)}`);
  if (!first && (!existing || existing.rev !== rev)) fail('precondition_failed', existing ? `the draft is at rev ${String(existing.rev)}` : 'there is no draft');

  const now = deps.now();
  const at = now.toISOString();
  const key = `drafts/${kind === 'channel' ? 'ch' : 'col'}/${t.id}/${ulid(now.getTime())}.zip`;
  const expires = now.getTime() + KEEP_MS;
  await deps.drafts.put(key, bytes);
  const item: Item = {
    PK: t.pk, SK: 'DRAFT', type: 'draft', key, size: bytes.length, sha256: sha256Hex(bytes),
    rev: (rev ?? 0) + 1, createdAt: existing?.createdAt ?? at, updatedAt: at,
    expiresAt: new Date(expires).toISOString(), ttl: Math.floor(expires / 1000),
    ...(existing?.check ? { check: existing.check } : {}),
  };
  try {
    await guarded(() => deps.db.send(new PutCommand({
      TableName: deps.table, Item: item,
      ConditionExpression: first ? 'attribute_not_exists(PK)' : 'rev = :rev',
      ...(first ? {} : { ExpressionAttributeValues: { ':rev': rev } }),
    })));
  } catch (e) {
    await deps.drafts.remove(key).catch(() => undefined);
    throw e;
  }
  if (existing) await deps.drafts.remove(String(existing.key)).catch(() => undefined);
  return withEtag(200, draftView(item));
}

async function deleteDraft(deps: Deps, req: Request, kind: Kind): Promise<Response> {
  const t = await ownTarget(deps, req, kind);
  const rev = ifMatch(req);
  const existing = (await get(deps, t.pk, 'DRAFT')) ?? fail('not_found', `no draft for ${t.id}`);
  await guarded(() => deps.db.send(new DeleteCommand({
    TableName: deps.table, Key: { PK: t.pk, SK: 'DRAFT' }, ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev },
  })));
  await deps.drafts.remove(String(existing.key)).catch(() => undefined);
  return noContent();
}

/**
 * Starts the machine review of the saved draft (R-16〜R-19): the day's count (apart from
 * submissions) and the draft's `check` in one transaction, then the Lambda, which writes the result.
 */
async function checkDraft(deps: Deps, req: Request, kind: Kind): Promise<Response> {
  const t = await ownTarget(deps, req, kind);
  requireWritable(t);
  const rev = ifMatch(req);
  const draft = (await get(deps, t.pk, 'DRAFT')) ?? fail('not_found', `no draft for ${t.id}`);
  if (draft.rev !== rev) fail('precondition_failed', `the draft is at rev ${String(draft.rev)}`);
  const now = deps.now();
  const running = draft.check as { state?: string; startedAt?: string } | undefined;
  if (running?.state === 'running' && Date.parse(String(running.startedAt)) > now.getTime() - CHECK_STALE_MS) {
    fail('invalid_state', 'a check of this draft is running');
  }
  const check = { state: 'running', rev, startedAt: now.toISOString() };
  const publisherId = String(t.account.publisherId);
  await transact(deps, [
    {
      Update: {
        TableName: deps.table, Key: { PK: `PUB#${publisherId}`, SK: `QUOTA#${jstDate(now)}` },
        UpdateExpression: 'ADD draftChecks :one SET #ttl = :ttl', ConditionExpression: 'attribute_not_exists(draftChecks) OR draftChecks < :max',
        ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':one': 1, ':max': DRAFT_CHECKS_PER_DAY, ':ttl': Math.floor(now.getTime() / 1000) + 3 * 24 * 3600 },
      },
    },
    {
      Update: {
        TableName: deps.table, Key: { PK: t.pk, SK: 'DRAFT' },
        UpdateExpression: 'SET #c = :check', ConditionExpression: 'rev = :rev',
        ExpressionAttributeNames: { '#c': 'check' }, ExpressionAttributeValues: { ':check': check, ':rev': rev },
      },
    },
  ], {
    0: ['quota_exceeded', `draft checks per day: ${DRAFT_CHECKS_PER_DAY} (resets at midnight in Japan)`],
  });
  await deps.drafts.invokeCheck({ kind, id: t.id });
  return withEtag(202, draftView({ ...draft, check }));
}

// ---- the owner's own submissions, to start a draft from (API-001 C-30) ----

const PENDING = ['awaiting_review', 'in_review', 'uploading', 'validating'];
const APPROVED = ['approved', 'superseded', 'revoked'];

/** Where a submission's file is now: under intake/ while pending, archive/ after (as review.ts reads them). */
function uploadKey(sub: Item, key: 'intakeKey' | 'iconIntakeKey'): string {
  const intake = String(sub[key]);
  if (PENDING.includes(String(sub.state))) return intake;
  return intake.replace(/^intake-col\//, 'archive-col/').replace(/^intake\//, 'archive/');
}

export const getOwnSubmissionPackage = (deps: Deps, req: Request) => ownPackage(deps, req, 'channel');
export const getOwnCollectionSubmissionPackage = (deps: Deps, req: Request) => ownPackage(deps, req, 'collection');

/**
 * A short-lived URL to the owner's submission: from the intake bucket while it is there, else,
 * for a version that was approved, from the public bucket, where it stays (DM-001 S3).
 */
async function ownPackage(deps: Deps, req: Request, kind: Kind): Promise<Response> {
  const t = await ownTarget(deps, req, kind);
  const sid = req.params.submissionId!;
  const sub = (await get(deps, t.pk, `SUB#${sid}`)) ?? fail('not_found', `no submission ${sid}`);
  if (sub.state === 'uploading' || sub.state === 'expired' || !sub.intakeKey) fail('not_found', 'the submission has no package');
  const expiresAt = new Date(deps.now().getTime() + URL_MS).toISOString();
  const packageKey = uploadKey(sub, 'intakeKey');
  if (await deps.drafts.uploadExists(packageKey)) {
    const iconUrl = kind === 'channel' ? await deps.presignDownload(uploadKey(sub, 'iconIntakeKey')) : undefined;
    return json(200, { packageUrl: await deps.presignDownload(packageKey), ...(kind === 'channel' ? { iconUrl } : {}), expiresAt });
  }
  if (!APPROVED.includes(String(sub.state)) || !sub.sha256) fail('not_found', 'the package is no longer kept (90 days after its result)');
  if (kind === 'collection') return json(200, { packageUrl: await deps.drafts.presignPublic(`col/${String(sub.sha256)}.zip`), expiresAt });
  const [packageUrl, iconUrl] = await Promise.all([
    deps.drafts.presignPublic(`pkg/${String(sub.sha256)}.zip`),
    sub.iconSha256 ? deps.drafts.presignPublic(`icons/${String(sub.iconSha256)}.png`) : Promise.resolve(null),
  ]);
  return json(200, { packageUrl, iconUrl, expiresAt });
}
