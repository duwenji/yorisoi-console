import { QueryCommand, type TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@yorisoi-console/api-types';
import { sha256Hex, utf8 } from '@yorisoi-console/protocol';
import { unzipSync } from 'fflate';
import { auditItem, channelMinVersions, collectionMinVersions, notifyAfter, type Deps, type Notice } from './deps.js';
import { fail, ifMatch, json, object, requireOperator, requiredText, text, withEtag, type Request, type Response } from './http.js';
import { loadSubmission, submissionView, transact } from './publisher.js';
import { collectionSubmissionView, collectionView, get, loadChannel, loadCollection, loadCollectionSubmission, loadPublisher, page, type Item } from './shared.js';
import { PUBLISHER_CHANGE_DAYS } from './transfer.js';
import { accountIdsOf, granted, notifyUsers, usesOfChannel, usesOfCollection } from './uses.js';
import { ulid } from './util.js';

type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

const MAX_SAMPLES = 1024 * 1024;
const FINDING_ITEM = /^[0-9]+(\.[0-9]+)*$/;

/** Where an upload is now: under intake/ while pending, archive/ once settled (DM-001 M-4; -col/ for collections). */
function uploadKey(sub: Item, key: 'intakeKey' | 'iconIntakeKey'): string {
  const intake = String(sub[key]);
  if (['awaiting_review', 'in_review', 'uploading', 'validating'].includes(String(sub.state))) return intake;
  return intake.replace(/^intake-col\//, 'archive-col/').replace(/^intake\//, 'archive/');
}

/**
 * What differs between reviewing a channel and a collection (DES-008 K-1): the keys, the files a
 * submission has (a collection has no icon), the view and the notices. The steps are shared.
 */
interface ReviewKind {
  param: 'channelId' | 'collectionId';
  pk: (id: string) => string;
  head: 'CH' | 'COL';
  load: (deps: Deps, id: string, submissionId: string) => Promise<Item>;
  view: (item: Item) => Schemas['Submission'] | Schemas['CollectionSubmission'];
  idOf: (sub: Item) => string;
  uploads: (sub: Item) => string[];
  notice: (sub: Item) => Pick<Notice, 'channelId' | 'collectionId'>;
  events: { returned: Notice['event']; rejected: Notice['event'] };
  action: (what: string) => string;
}

const CHANNEL: ReviewKind = {
  param: 'channelId', pk: (id) => `CH#${id}`, head: 'CH',
  load: (deps, id, sid) => loadSubmission(deps, id, sid), view: (i) => submissionView(i), idOf: (sub) => String(sub.channelId),
  uploads: (sub) => [String(sub.intakeKey), String(sub.iconIntakeKey)], notice: (sub) => ({ channelId: String(sub.channelId) }),
  events: { returned: 'submission.returned', rejected: 'submission.rejected' }, action: (what) => `submission.${what}`,
};

const COLLECTION: ReviewKind = {
  param: 'collectionId', pk: (id) => `COL#${id}`, head: 'COL',
  load: (deps, id, sid) => loadCollectionSubmission(deps, id, sid), view: (i) => collectionSubmissionView(i), idOf: (sub) => String(sub.collectionId),
  uploads: (sub) => [String(sub.intakeKey)], notice: (sub) => ({ collectionId: String(sub.collectionId) }),
  events: { returned: 'collection.returned', rejected: 'collection.rejected' }, action: (what) => `collection.submission.${what}`,
};

// ---- reading ----

/** Submissions waiting for or in review, oldest first (DM-001 AP-09). */
export async function listReviewQueue(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const { items, nextCursor } = await page(deps, req, {
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :q',
    ExpressionAttributeValues: { ':q': 'QUEUE#REVIEW' },
    ScanIndexForward: true,
  });
  // Channels and collections share the queue (DM-001 M-18); the kind tells them apart.
  return json(200, { items: items.map((i) => (i.kind === 'collection' ? collectionSubmissionView(i) : submissionView(i))), nextCursor });
}

export async function getSubmissionPackage(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const sub = await loadSubmission(deps, req.params.channelId!, req.params.submissionId!);
  const [packageUrl, iconUrl] = await Promise.all([deps.presignDownload(uploadKey(sub, 'intakeKey')), deps.presignDownload(uploadKey(sub, 'iconIntakeKey'))]);
  return json(200, { packageUrl, iconUrl, expiresAt: new Date(deps.now().getTime() + 5 * 60_000).toISOString() });
}

/** The prompts the machine review rendered for the review samples (API-001 C-1). */
export async function getSamplePrompts(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const sub = await loadSubmission(deps, req.params.channelId!, req.params.submissionId!);
  const body = sub.samplesKey ? await deps.readRecord(String(sub.samplesKey)) : undefined;
  if (!body) return fail('not_found', 'no sample prompts: the submission did not pass the machine review');
  return json(200, JSON.parse(body));
}

/** Keeps the AI's replies (never the operator's API key, API-001 C-13) for the review record. */
export async function saveSamples(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const sub = await loadSubmission(deps, req.params.channelId!, req.params.submissionId!);
  const body = object(req.body);
  const service = text(body, 'service', { max: 40 })!;
  const model = text(body, 'model', { max: 100 })!;
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every((i) => typeof i === 'object' && i && typeof i.scenarioId === 'string' && typeof i.output === 'string' && i.output.length <= 20000)) {
    return fail('invalid_request', 'items must be { scenarioId, output } with outputs up to 20,000 characters');
  }
  const samplesId = ulid(deps.now().getTime());
  const record = JSON.stringify({ samplesId, service, model, items, savedBy: req.caller.sub, savedAt: deps.now().toISOString() });
  if (record.length > MAX_SAMPLES) fail('payload_too_large', 'samples over 1MB');
  await deps.writeRecord(`reviews/${String(sub.submissionId)}/${samplesId}.json`, record);
  return json(201, { samplesId });
}

function reviews(kind: ReviewKind) {
  return async (deps: Deps, req: Request): Promise<Response> => {
    requireOperator(req);
    const id = req.params[kind.param]!;
    const submissionId = req.params.submissionId!;
    await kind.load(deps, id, submissionId);
    const out = await deps.db.send(
      new QueryCommand({
        TableName: deps.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :r)',
        ExpressionAttributeValues: { ':pk': kind.pk(id), ':r': `SUB#${submissionId}#REVIEW#` },
      }),
    );
    const items = await Promise.all(
      (out.Items ?? []).map(async (r) => ({
        reviewerSub: String(r.reviewerSub),
        action: r.action as Schemas['Review']['action'],
        ...(r.findings ? { findings: r.findings as Schemas['Finding'][] } : {}),
        ...(r.message ? { message: String(r.message) } : {}),
        samples: await Promise.all(
          ((r.samplesIds as string[] | undefined) ?? []).map(async (id) => {
            const saved = await deps.readRecord(`reviews/${submissionId}/${id}.json`);
            return saved ? (JSON.parse(saved) as { samplesId: string; service: string; model: string; items: unknown[] }) : { samplesId: id, service: '?', model: '?', items: [] };
          }),
        ),
        at: String(r.at),
      })),
    );
    return json(200, { items });
  };
}

export const listReviews = reviews(CHANNEL);
export const listCollectionReviews = reviews(COLLECTION);

// ---- deciding ----

function reviewItem(deps: Deps, req: Request, sub: Item, at: string, entry: { action: string; findings?: unknown[]; message?: string; samplesIds?: string[] }, kind: ReviewKind = CHANNEL) {
  return {
    Put: {
      TableName: deps.table,
      Item: {
        PK: kind.pk(kind.idOf(sub)), SK: `SUB#${String(sub.submissionId)}#REVIEW#${at}`, type: 'review', submissionId: sub.submissionId,
        reviewerSub: req.caller.sub, at, action: entry.action,
        ...(entry.findings?.length ? { findings: entry.findings } : {}), ...(entry.message ? { message: entry.message } : {}),
        ...(entry.samplesIds?.length ? { samplesIds: entry.samplesIds } : {}),
      },
    },
  };
}

async function loadForDecision(deps: Deps, req: Request, from: string, kind: ReviewKind = CHANNEL) {
  requireOperator(req);
  const rev = ifMatch(req);
  const sub = await kind.load(deps, req.params[kind.param]!, req.params.submissionId!);
  if (sub.rev !== rev) fail('precondition_failed', `the submission is at rev ${String(sub.rev)}`);
  if (sub.state !== from) fail('invalid_state', `the submission is ${String(sub.state)}`);
  return { sub, rev };
}

/** Moves a submission between `awaiting_review` and `in_review` (an operator takes or puts back a review). */
function move(from: 'awaiting_review' | 'in_review', to: 'awaiting_review' | 'in_review', action: 'start' | 'release', kind: ReviewKind = CHANNEL) {
  return async (deps: Deps, req: Request): Promise<Response> => {
    const { sub, rev } = await loadForDecision(deps, req, from, kind);
    const at = deps.now().toISOString();
    const id = kind.idOf(sub);
    await transact(
      deps,
      [
        {
          Update: {
            TableName: deps.table, Key: { PK: kind.pk(id), SK: `SUB#${String(sub.submissionId)}` },
            UpdateExpression: 'SET #s = :to, updatedAt = :now, rev = rev + :one', ConditionExpression: 'rev = :rev AND #s = :from',
            ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':to': to, ':from': from, ':now': at, ':one': 1, ':rev': rev },
          },
        },
        reviewItem(deps, req, sub, at, { action }, kind),
        auditItem(deps, req.caller, { action: kind.action(action), target: kind.pk(id), detail: { submissionId: sub.submissionId } }),
      ],
      { 0: ['precondition_failed', 'changed by someone else; read it again'] },
    );
    return withEtag(200, kind.view(await kind.load(deps, id, String(sub.submissionId))));
  };
}

export const startReview = move('awaiting_review', 'in_review', 'start');
export const releaseReview = move('in_review', 'awaiting_review', 'release');
export const startCollectionReview = move('awaiting_review', 'in_review', 'start', COLLECTION);
export const releaseCollectionReview = move('in_review', 'awaiting_review', 'release', COLLECTION);

function samplesIdsOf(body: Record<string, unknown>): string[] | undefined {
  const ids = body.samplesIds;
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(i))) return fail('invalid_request', 'samplesIds must be the ids of saved samples');
  return ids as string[];
}

function findingsOf(body: Record<string, unknown>): Schemas['Finding'][] {
  const findings = body.findings;
  if (!Array.isArray(findings) || findings.length === 0) return fail('invalid_request', 'give at least one finding with the review policy item', [{ path: '/findings', message: 'at least one' }]);
  return findings.map((f, i) => {
    if (typeof f !== 'object' || !f || typeof f.item !== 'string' || !FINDING_ITEM.test(f.item) || typeof f.detail !== 'string' || f.detail.length === 0 || f.detail.length > 2000) {
      return fail('invalid_request', `findings[${i}] needs an item like 2.2 and a detail`, [{ path: `/findings/${i}`, message: 'item and detail' }]);
    }
    return { item: f.item as string, detail: f.detail as string };
  });
}

/** What the machine review recorded about a channel's material for approval (DES-007 J-10). */
interface ChannelListing {
  appStage: number;
  collections: { as: string; id: string; minVersion: number }[];
  ownPrefetchBytes: number;
  ownMedia: string[];
  /** By collection id: the resources the channel names in it, with their types. */
  uses: Record<string, Record<string, string>>;
  /** As the package writes them (DES-011 N-3). */
  activities: string[];
  genres: string[];
  requires: string[];
}

/**
 * The collections a channel declares, checked once more at approval (DES-008 K-7): still listed,
 * new enough, granted to the publisher (by any of its ids), and holding what the channel names
 * with the same types. Returns them with the `rev` the approval's write is conditional on (K-5).
 */
async function recheckCollections(deps: Deps, publisherId: string, listing: ChannelListing): Promise<Item[]> {
  if (listing.collections.length === 0) return [];
  const ids = await accountIdsOf(deps, publisherId);
  const problems: string[] = [];
  const found: Item[] = [];
  for (const use of listing.collections) {
    const col = await get(deps, `COL#${use.id}`, 'COL');
    const la = col?.latestApproved as { version: number; grants?: { publishers?: '*' | string[] }; resourceTypes?: Record<string, string> } | undefined;
    if (!col || col.status !== 'active' || col.GSI2PK !== 'LISTED' || !la) { problems.push(`${use.as}: ${use.id} is not listed`); continue; }
    if (la.version < use.minVersion) { problems.push(`${use.as}: ${use.id}@${la.version} is older than ${use.minVersion}`); continue; }
    if (!granted(la.grants, ids)) { problems.push(`${use.as}: ${use.id} is not granted to this publisher`); continue; }
    for (const [id, type] of Object.entries(listing.uses[use.id] ?? {})) {
      const now = la.resourceTypes?.[id];
      if (now === undefined) problems.push(`${use.as}: ${use.id} has no ${id}`);
      else if (type !== '' && now !== type) problems.push(`${use.as}: ${id} is ${now}, not ${type}`);
    }
    found.push(col);
  }
  if (problems.length > 0) fail('invalid_state', `the collections changed since the machine review: ${problems.join('; ')}`);
  return found;
}

/**
 * The approval's writes for the records of use (DM-001 M-22, DES-008 K-5・K-7): each used
 * collection must be unchanged since it was read, the channel's records are written (each one's
 * `rev` raised, so a collection approval that read the old one fails), and those of collections it
 * no longer uses are deleted.
 */
async function usesItems(deps: Deps, channelId: string, publisherId: string, version: number, listing: ChannelListing, used: Item[]): Promise<TransactItems> {
  const existing = new Map((await usesOfChannel(deps, channelId)).map((u) => [String(u.collectionId), u]));
  const items: TransactItems = used.map((col) => ({
    ConditionCheck: { TableName: deps.table, Key: { PK: `COL#${String(col.collectionId)}`, SK: 'COL' }, ConditionExpression: 'rev = :r', ExpressionAttributeValues: { ':r': col.rev } },
  }));
  for (const [collectionId, resources] of Object.entries(listing.uses)) {
    const before = existing.get(collectionId);
    items.push({
      Put: {
        TableName: deps.table,
        Item: {
          PK: `COL#${collectionId}`, SK: `USEDBY#${channelId}`, type: 'used-by', collectionId, channelId, publisherId, channelVersion: version, resources,
          rev: Number(before?.rev ?? 0) + 1, GSI1PK: `CH#${channelId}`, GSI1SK: `USES#${collectionId}`,
        },
        ConditionExpression: before ? 'rev = :r' : 'attribute_not_exists(PK)',
        ...(before ? { ExpressionAttributeValues: { ':r': before.rev } } : {}),
      },
    });
  }
  for (const [collectionId, u] of existing) {
    if (!(collectionId in listing.uses)) items.push({ Delete: { TableName: deps.table, Key: { PK: String(u.PK), SK: String(u.SK) } } });
  }
  return items;
}

/**
 * Approves a submission (API-001): the package and icon go public, the channel is listed with this
 * version, the previous approved version is superseded, and the list is published again. The
 * package is read back and checked against the SHA-256 the machine review recorded.
 */
export async function approveSubmission(deps: Deps, req: Request): Promise<Response> {
  const { sub, rev } = await loadForDecision(deps, req, 'in_review');
  const body = object(req.body ?? {});
  const message = text(body, 'message', { max: 2000, optional: true, min: 0 });
  const samplesIds = samplesIdsOf(body);
  const channelId = String(sub.channelId);
  const channel = await loadChannel(deps, channelId);
  const previous = channel.latestApproved as { submissionId?: string; version?: number } | undefined;
  if (previous?.version !== undefined && Number(sub.version) <= previous.version) fail('version_not_newer', `version ${String(sub.version)} is not after the approved ${previous.version}`);

  const zip = await deps.readUpload(String(sub.intakeKey));
  if (sha256Hex(zip) !== sub.sha256) fail('invalid_state', 'the uploaded package differs from what the machine review checked');
  const listing = (sub.listing as ChannelListing | undefined) ?? fail('invalid_state', 'the machine review recorded nothing to list');
  const used = await recheckCollections(deps, String(sub.publisherId), listing);
  const manifest = JSON.parse(utf8.decode(unzipSync(zip, { filter: (f) => f.name === 'channel.json' })['channel.json']!)) as {
    format: number; name: string; summary: string; lang: string;
  };
  // What the list copies for the apps to choose by (API-CHANNEL-LIST P-19).
  const { activities, genres, requires } = listing;
  const minAppVersions = channelMinVersions(deps, listing.appStage, activities, requires);
  const { packageUrl, iconUrl } = await deps.publishApproved({
    packageKey: String(sub.intakeKey), packageSha256: String(sub.sha256), iconKey: String(sub.iconIntakeKey), iconSha256: String(sub.iconSha256),
  });

  const at = deps.now().toISOString();
  const latestApproved = {
    submissionId: String(sub.submissionId), version: Number(sub.version), publisher: String(sub.accountId),
    name: manifest.name, summary: manifest.summary, lang: [manifest.lang],
    ...(sub.description ? { description: String(sub.description) } : {}),
    ...(sub.tags ? { tags: sub.tags } : {}), ...(sub.regions ? { regions: sub.regions } : {}),
    icon: { url: iconUrl, sha256: String(sub.iconSha256) },
    package: { url: packageUrl, sha256: String(sub.sha256), size: Number(sub.size), format: manifest.format },
    activities, genres, requires, minAppVersions, approvedAt: at,
    // What the publisher adds up each time it lists the channel (DM-001 M-24).
    appStage: listing.appStage, collections: listing.collections, ownPrefetchBytes: listing.ownPrefetchBytes, ownMedia: listing.ownMedia,
  };
  const decision = { action: 'approve', at, ...(message ? { message } : {}) };
  // The first version with a transferred key starts the 90 days the list shows the change (API-CHANNEL-LIST P-9).
  const pending = channel.publisherChange as { from: string; at: string; reason: string; until?: string } | undefined;
  const change = pending && !pending.until && pending.from !== sub.accountId
    ? { ...pending, until: new Date(Date.parse(at) + PUBLISHER_CHANGE_DAYS * 86_400_000).toISOString() }
    : undefined;
  const items: TransactItems = [
    {
      Update: {
        TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${String(sub.submissionId)}` },
        UpdateExpression: 'SET #s = :approved, decision = :d, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK',
        ConditionExpression: 'rev = :rev AND #s = :review', ExpressionAttributeNames: { '#s': 'state' },
        ExpressionAttributeValues: { ':approved': 'approved', ':review': 'in_review', ':d': decision, ':now': at, ':one': 1, ':rev': rev },
      },
    },
    {
      Update: {
        TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: 'CH' },
        UpdateExpression: `SET latestApproved = :la, #s = :active, GSI2PK = :listed, GSI2SK = :order, updatedAt = :now, rev = rev + :one${change ? ', publisherChange = :pc' : ''} REMOVE pendingSubmissionId`,
        ConditionExpression: 'pendingSubmissionId = :sid', ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':la': latestApproved, ':active': 'active', ':listed': 'LISTED', ':order': `CH#${channelId}`, ':now': at, ':one': 1, ':sid': sub.submissionId,
          ...(change ? { ':pc': change } : {}),
        },
      },
    },
    reviewItem(deps, req, sub, at, { action: 'approve', ...(message ? { message } : {}), ...(samplesIds ? { samplesIds } : {}) }),
    auditItem(deps, req.caller, { action: 'submission.approve', target: `CH#${channelId}`, detail: { submissionId: sub.submissionId, version: sub.version } }),
  ];
  items.push(...(await usesItems(deps, channelId, String(sub.publisherId), Number(sub.version), listing, used)));
  if (previous?.submissionId && previous.submissionId !== sub.submissionId) {
    items.push({
      Update: {
        TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${previous.submissionId}` },
        UpdateExpression: 'SET #s = :superseded, updatedAt = :now, rev = rev + :one', ConditionExpression: '#s = :approved',
        ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':superseded': 'superseded', ':approved': 'approved', ':now': at, ':one': 1 },
      },
    });
  }
  await transact(deps, items, { 0: ['precondition_failed', 'changed by someone else; read it again'] });
  await deps.requestPublish('approve');
  await Promise.all([deps.archiveUpload(String(sub.intakeKey)), deps.archiveUpload(String(sub.iconIntakeKey))]).catch(() => undefined);
  await notifyAfter(deps, {
    event: 'submission.approved', publisherId: String(sub.publisherId), channelId, submissionId: String(sub.submissionId), version: Number(sub.version), ...(message ? { message } : {}),
  });
  const updated = submissionView(await loadSubmission(deps, channelId, String(sub.submissionId)));
  return json(200, { submission: updated, publication: 'pending' }, { etag: `"${updated.rev}"` });
}

/** Returns (can be fixed) or rejects (can't) a submission, with the review policy's item numbers (審査基準 3). */
function decline(action: 'return' | 'reject', kind: ReviewKind = CHANNEL) {
  return async (deps: Deps, req: Request): Promise<Response> => {
    const { sub, rev } = await loadForDecision(deps, req, 'in_review', kind);
    const body = object(req.body);
    const findings = findingsOf(body);
    const message = text(body, 'message', { max: 2000, optional: true, min: 0 });
    const samplesIds = samplesIdsOf(body);
    const id = kind.idOf(sub);
    const at = deps.now().toISOString();
    const state = action === 'return' ? 'returned' : 'rejected';
    await transact(
      deps,
      [
        {
          Update: {
            TableName: deps.table, Key: { PK: kind.pk(id), SK: `SUB#${String(sub.submissionId)}` },
            UpdateExpression: 'SET #s = :to, decision = :d, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK',
            ConditionExpression: 'rev = :rev AND #s = :review', ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: { ':to': state, ':review': 'in_review', ':d': { action, findings, at, ...(message ? { message } : {}) }, ':now': at, ':one': 1, ':rev': rev },
          },
        },
        {
          Update: {
            TableName: deps.table, Key: { PK: kind.pk(id), SK: kind.head },
            UpdateExpression: 'SET updatedAt = :now, rev = rev + :one REMOVE pendingSubmissionId', ConditionExpression: 'pendingSubmissionId = :sid',
            ExpressionAttributeValues: { ':now': at, ':one': 1, ':sid': sub.submissionId },
          },
        },
        reviewItem(deps, req, sub, at, { action, findings, ...(message ? { message } : {}), ...(samplesIds ? { samplesIds } : {}) }, kind),
        auditItem(deps, req.caller, { action: kind.action(action), target: kind.pk(id), detail: { submissionId: sub.submissionId, items: findings.map((f) => f.item) } }),
      ],
      { 0: ['precondition_failed', 'changed by someone else; read it again'] },
    );
    await Promise.all(kind.uploads(sub).map((k) => deps.archiveUpload(k))).catch(() => undefined);
    await notifyAfter(deps, {
      event: action === 'return' ? kind.events.returned : kind.events.rejected, publisherId: String(sub.publisherId), ...kind.notice(sub),
      submissionId: String(sub.submissionId), ...(sub.version !== undefined ? { version: Number(sub.version) } : {}), findings, ...(message ? { message } : {}),
    });
    const updated = kind.view(await kind.load(deps, id, String(sub.submissionId)));
    return json(200, { submission: updated, publication: 'none' }, { etag: `"${updated.rev}"` });
  };
}

export const returnSubmission = decline('return');
export const rejectSubmission = decline('reject');
export const returnCollectionSubmission = decline('return', COLLECTION);
export const rejectCollectionSubmission = decline('reject', COLLECTION);

// ---- collections (DES-008 K-3〜K-5・K-8) ----

export async function getCollectionSubmissionPackage(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const sub = await loadCollectionSubmission(deps, req.params.collectionId!, req.params.submissionId!);
  const packageUrl = await deps.presignDownload(uploadKey(sub, 'intakeKey'));
  return json(200, { packageUrl, expiresAt: new Date(deps.now().getTime() + 5 * 60_000).toISOString() });
}

/** What the machine review recorded for approval to copy (DES-007 J-8). */
interface CollectionListing {
  appStage: number; name: string; summary: string; media: string[]; resourcesSize: number; tags: string[]; regions: string[];
  grants: { publishers: '*' | string[]; apps?: string[]; grounding?: boolean }; resourceTypes: Record<string, string>; externalResources: { resourceId: string; url: string; size: number }[];
}

function verificationOf(body: Record<string, unknown>): Schemas['Verification'] | undefined {
  if (body.verification === undefined) return undefined;
  const v = object(body.verification);
  return { method: requiredText(v, 'method', { max: 100 }), detail: requiredText(v, 'detail', { max: 2000 }) };
}

/**
 * Approves a collection (API-001 C-17, DES-008 K-3〜K-5): the identity check is required for the
 * account's first, the package goes public under `col/`, `latestApproved` is copied from what the
 * machine review recorded, and the resources listed channels name are checked once more against
 * the records of use, whose `rev`s are conditions of the write (D-8).
 */
export async function approveCollectionSubmission(deps: Deps, req: Request): Promise<Response> {
  const { sub, rev } = await loadForDecision(deps, req, 'in_review', COLLECTION);
  const body = object(req.body ?? {});
  const message = text(body, 'message', { max: 2000, optional: true, min: 0 });
  const given = verificationOf(body);
  const collectionId = String(sub.collectionId);
  const collection = await loadCollection(deps, collectionId);
  const account = await loadPublisher(deps, String(sub.publisherId));
  if (!account.producerVerification && !given) fail('producer_not_verified', 'the account’s identity has not been checked: give verification');
  const previous = collection.latestApproved as { submissionId?: string; version?: number } | undefined;
  if (previous?.version !== undefined && Number(sub.version) <= previous.version) fail('version_not_newer', `version ${String(sub.version)} is not after the approved ${previous.version}`);
  const listing = sub.listing as CollectionListing | undefined;
  if (!listing) return fail('invalid_state', 'the submission has no record from the machine review');

  // D-8 once more: what listed channels name must still be there, with its type (DES-008 K-5).
  const uses = await usesOfCollection(deps, collectionId);
  const broken = uses.flatMap((u) =>
    Object.entries((u.resources as Record<string, string> | undefined) ?? {})
      .filter(([id, type]) => listing.resourceTypes[id] === undefined || (type !== '' && listing.resourceTypes[id] !== type))
      .map(([id]) => `${String(u.channelId)} uses ${id}`),
  );
  if (broken.length > 0) fail('resource_in_use', broken.join('; '));

  const at = deps.now().toISOString();
  const packageUrl = await deps.publishCollection(String(sub.intakeKey), String(sub.sha256));
  const minAppVersions = collectionMinVersions(deps, listing.appStage, listing.grants.apps);
  const latestApproved = {
    submissionId: String(sub.submissionId), version: Number(sub.version), producer: String(sub.accountId),
    name: listing.name, summary: listing.summary, media: listing.media, resourcesSize: listing.resourcesSize,
    tags: listing.tags, regions: listing.regions, grants: listing.grants,
    package: { url: packageUrl, sha256: String(sub.sha256), size: Number(sub.size), format: 1 },
    resourceTypes: listing.resourceTypes, externalResources: listing.externalResources,
    appStage: listing.appStage, minAppVersions, approvedAt: at,
  };
  const decision = { action: 'approve', at, ...(message ? { message } : {}) };
  // The first version with a transferred key starts the 90 days the list shows the change (API-CHANNEL-LIST P-13, as P-9).
  const pending = collection.producerChange as { from: string; at: string; reason: string; until?: string } | undefined;
  const change = pending && !pending.until && pending.from !== sub.accountId
    ? { ...pending, until: new Date(Date.parse(at) + PUBLISHER_CHANGE_DAYS * 86_400_000).toISOString() }
    : undefined;
  const items: TransactItems = [
    {
      Update: {
        TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: `SUB#${String(sub.submissionId)}` },
        UpdateExpression: 'SET #s = :approved, decision = :d, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK',
        ConditionExpression: 'rev = :rev AND #s = :review', ExpressionAttributeNames: { '#s': 'state' },
        ExpressionAttributeValues: { ':approved': 'approved', ':review': 'in_review', ':d': decision, ':now': at, ':one': 1, ':rev': rev },
      },
    },
    {
      Update: {
        TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: 'COL' },
        UpdateExpression: `SET latestApproved = :la, #s = :active, GSI2PK = :listed, GSI2SK = :order, updatedAt = :now, rev = rev + :one${change ? ', producerChange = :pc' : ''} REMOVE pendingSubmissionId`,
        ConditionExpression: 'pendingSubmissionId = :sid', ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':la': latestApproved, ':active': 'active', ':listed': 'LISTED', ':order': `COL#${collectionId}`, ':now': at, ':one': 1, ':sid': sub.submissionId,
          ...(change ? { ':pc': change } : {}),
        },
      },
    },
    reviewItem(deps, req, sub, at, { action: 'approve', ...(message ? { message } : {}) }, COLLECTION),
    auditItem(deps, req.caller, { action: 'collection.submission.approve', target: `COL#${collectionId}`, detail: { submissionId: sub.submissionId, version: sub.version } }),
    // A channel approved meanwhile changes a record of use: then this fails and is read again (K-5).
    ...uses.map((u) => ({
      ConditionCheck: {
        TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: String(u.SK) },
        ConditionExpression: u.rev !== undefined ? 'rev = :r' : 'attribute_not_exists(rev)',
        ...(u.rev !== undefined ? { ExpressionAttributeValues: { ':r': u.rev } } : {}),
      },
    })),
  ];
  if (given && !account.producerVerification) {
    items.push({
      Update: {
        TableName: deps.table, Key: { PK: `PUB#${String(account.publisherId)}`, SK: 'PUB' },
        UpdateExpression: 'SET producerVerification = :v, updatedAt = :now, rev = rev + :one', ConditionExpression: 'attribute_not_exists(producerVerification)',
        ExpressionAttributeValues: { ':v': { ...given, verifiedAt: at, operatorSub: req.caller.sub }, ':now': at, ':one': 1 },
      },
    });
  }
  if (previous?.submissionId && previous.submissionId !== sub.submissionId) {
    items.push({
      Update: {
        TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: `SUB#${previous.submissionId}` },
        UpdateExpression: 'SET #s = :superseded, updatedAt = :now, rev = rev + :one', ConditionExpression: '#s = :approved',
        ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':superseded': 'superseded', ':approved': 'approved', ':now': at, ':one': 1 },
      },
    });
  }
  await transact(deps, items, { 0: ['precondition_failed', 'changed by someone else; read it again'] });
  await deps.requestPublish('approve');
  await deps.archiveUpload(String(sub.intakeKey)).catch(() => undefined);
  await notifyAfter(deps, {
    event: 'collection.approved', publisherId: String(sub.publisherId), collectionId, submissionId: String(sub.submissionId), version: Number(sub.version), ...(message ? { message } : {}),
  });
  // The channels that use it hear of the new version, or that they can no longer use it (D-18, K-11).
  if (previous?.version !== undefined && uses.length > 0) {
    const still: Item[] = [];
    const lost: Item[] = [];
    for (const u of uses) (granted(listing.grants, await accountIdsOf(deps, String(u.publisherId))) ? still : lost).push(u);
    await notifyUsers(deps, still, 'collection.updated', collectionId, { version: Number(sub.version) });
    await notifyUsers(deps, lost, 'collection.grants_narrowed', collectionId, { version: Number(sub.version) });
  }
  const updated = collectionSubmissionView(await loadCollectionSubmission(deps, collectionId, String(sub.submissionId)));
  return json(200, { submission: updated, publication: 'pending' }, { etag: `"${updated.rev}"` });
}

/** Takes a collection off the list (DES-008 K-8); its records of use stay, to tell the channels that used it. */
export async function revokeCollection(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const rev = ifMatch(req);
  const body = object(req.body);
  const reason = requiredText(body, 'reason', { max: 200 });
  const severity = body.severity;
  if (severity !== 'high' && severity !== 'low') fail('invalid_request', 'severity must be high or low', [{ path: '/severity', message: 'high or low' }]);
  const versions = body.versions;
  if (versions !== undefined && (!Array.isArray(versions) || versions.length === 0 || !versions.every((v) => Number.isInteger(v) && v >= 1))) {
    fail('invalid_request', 'versions must be positive integers', [{ path: '/versions', message: 'positive integers' }]);
  }
  const collectionId = req.params.collectionId!;
  const collection = await loadCollection(deps, collectionId);
  if (collection.rev !== rev) fail('precondition_failed', `the collection is at rev ${String(collection.rev)}`);
  if (collection.status !== 'active') fail('invalid_state', `the collection is ${String(collection.status)}`);
  const now = deps.now().toISOString();
  const approved = (collection.latestApproved as { submissionId?: string } | undefined)?.submissionId;
  const items: TransactItems = [
    {
      Put: {
        TableName: deps.table,
        Item: {
          PK: `COL#${collectionId}`, SK: `REVOKE#${now}`, type: 'revocation', kind: 'collection', collectionId, ...(versions ? { versions } : {}),
          reason, severity, operatorSub: req.caller.sub, revokedAt: now, GSI2PK: 'REVOKED', GSI2SK: `${now}#col:${collectionId}`,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Update: {
        TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: 'COL' },
        UpdateExpression: 'SET #s = :revoked, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK',
        ConditionExpression: 'rev = :rev AND #s = :active', ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':revoked': 'revoked', ':active': 'active', ':now': now, ':one': 1, ':rev': rev },
      },
    },
    auditItem(deps, req.caller, { action: 'collection.revoke', target: `COL#${collectionId}`, reason, detail: { severity, ...(versions ? { versions } : {}) } }),
  ];
  if (approved) {
    items.push({
      Update: {
        TableName: deps.table, Key: { PK: `COL#${collectionId}`, SK: `SUB#${approved}` },
        UpdateExpression: 'SET #s = :revoked, updatedAt = :now, rev = rev + :one', ConditionExpression: '#s = :approved',
        ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':revoked': 'revoked', ':approved': 'approved', ':now': now, ':one': 1 },
      },
    });
  }
  await transact(deps, items, { 1: ['precondition_failed', 'changed by someone else; read it again'] });
  await deps.requestPublish('revoke');
  await notifyAfter(deps, { event: 'collection.revoked', publisherId: String(collection.publisherId), collectionId, message: reason });
  await notifyUsers(deps, await usesOfCollection(deps, collectionId), 'collection.revoked_used', collectionId, { message: reason });
  return withEtag(200, await collectionView(deps, await loadCollection(deps, collectionId)));
}
