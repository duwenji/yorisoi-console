import { GetCommand, QueryCommand, TransactWriteCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@yorisoi-console/api-types';
import { ProtocolError, b64url, providerId, publicKeyFromRaw, rawPublicKey, verifyDiscovery } from '@yorisoi-console/protocol';
import { createPublicKey } from 'node:crypto';
import { auditItem, guarded, notifyAfter, type Deps } from './deps.js';
import { channelView, get, loadChannel, loadPublisher, page, publisherView, type Item } from './shared.js';
import { deleteUses, usesOfChannel } from './uses.js';
import { fail, ifMatch, json, limit, object, requireOperator, requiredText, text, withEtag, type Request, type Response } from './http.js';

// ---- publishers ----

export async function listPublishers(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const status = req.query.status;
  if (status && !['pending_key', 'active', 'suspended', 'deleted'].includes(status)) fail('invalid_request', `unknown status ${status}`);
  const { items, nextCursor } = await page(deps, req, {
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': 'PUBLISHERS', ...(status ? { ':status': status } : {}) },
    ...(status ? { FilterExpression: '#status = :status', ExpressionAttributeNames: { '#status': 'status' } } : {}),
    ScanIndexForward: false,
  });
  return json(200, { items: await Promise.all(items.map((i) => publisherView(deps, i))), nextCursor });
}

export async function getPublisher(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  return withEtag(200, await publisherView(deps, await loadPublisher(deps, req.params.publisherId!), true));
}

export async function listPublisherChannels(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  await loadPublisher(deps, req.params.publisherId!);
  const out = await deps.db.send(
    new QueryCommand({
      TableName: deps.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :ch)',
      ExpressionAttributeValues: { ':pk': `PUB#${req.params.publisherId}`, ':ch': 'CH#' },
    }),
  );
  return json(200, { items: await Promise.all((out.Items ?? []).map((c) => channelView(deps, c))) });
}

/** Suspends or resumes a publisher (DM-001 M-10): its listed channels stay as they are. */
export function setPublisherSuspended(suspend: boolean) {
  return async (deps: Deps, req: Request): Promise<Response> => {
    requireOperator(req);
    const rev = ifMatch(req);
    const reason = requiredText(object(req.body), 'reason', { max: 500 });
    const item = await loadPublisher(deps, req.params.publisherId!);
    if (item.rev !== rev) fail('precondition_failed', `the publisher is at rev ${String(item.rev)}`);
    const from = item.status;
    if (suspend ? !['active', 'pending_key'].includes(String(from)) : from !== 'suspended') {
      fail('invalid_state', `the publisher is ${String(from)}`);
    }
    const to = suspend ? 'suspended' : item.activeAccountId ? 'active' : 'pending_key';
    const now = deps.now().toISOString();
    await guarded(() =>
      deps.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: deps.table,
                Key: { PK: `PUB#${req.params.publisherId}`, SK: 'PUB' },
                UpdateExpression: suspend
                  ? 'SET #status = :to, statusReason = :reason, updatedAt = :now, rev = rev + :one'
                  : 'SET #status = :to, updatedAt = :now, rev = rev + :one REMOVE statusReason',
                ConditionExpression: 'rev = :rev AND #status = :from',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':to': to, ':now': now, ':one': 1, ':rev': rev, ':from': from, ...(suspend ? { ':reason': reason } : {}) },
              },
            },
            auditItem(deps, req.caller, { action: suspend ? 'publisher.suspend' : 'publisher.resume', target: `PUB#${req.params.publisherId}`, reason }),
          ],
        }),
      ),
    );
    return withEtag(200, await publisherView(deps, await loadPublisher(deps, req.params.publisherId!)));
  };
}

export async function setPublisherLimits(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const rev = ifMatch(req);
  const body = object(req.body);
  const reason = requiredText(body, 'reason', { max: 500 });
  const limits: Record<string, number> = {};
  for (const key of ['channels', 'collections', 'uploadsPerDay', 'ticketsPerDay'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) {
      fail('invalid_request', `${key} must be an integer 0–1000`, [{ path: `/${key}`, message: '0–1000' }]);
    }
    limits[key] = value as number;
  }
  const item = await loadPublisher(deps, req.params.publisherId!);
  if (item.rev !== rev) fail('precondition_failed', `the publisher is at rev ${String(item.rev)}`);
  await guarded(() =>
    deps.db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.table,
              Key: { PK: `PUB#${req.params.publisherId}`, SK: 'PUB' },
              UpdateExpression: Object.keys(limits).length > 0
                ? 'SET limits = :limits, updatedAt = :now, rev = rev + :one'
                : 'SET updatedAt = :now, rev = rev + :one REMOVE limits',
              ConditionExpression: 'rev = :rev',
              ExpressionAttributeValues: { ':now': deps.now().toISOString(), ':one': 1, ':rev': rev, ...(Object.keys(limits).length > 0 ? { ':limits': limits } : {}) },
            },
          },
          auditItem(deps, req.caller, { action: 'limits.update', target: `PUB#${req.params.publisherId}`, reason, detail: { before: item.limits ?? null, after: limits } }),
        ],
      }),
    ),
  );
  return withEtag(200, await publisherView(deps, await loadPublisher(deps, req.params.publisherId!)));
}

// ---- channels ----

/**
 * Takes a channel off the list (DM-001 M-9): it leaves the list at the next publication and shows
 * in `revoked` for 7 days. An earlier approved version is not restored; a new approval is needed.
 */
export async function revokeChannel(deps: Deps, req: Request): Promise<Response> {
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
  const channelId = req.params.channelId!;
  const channel = await loadChannel(deps, channelId);
  if (channel.rev !== rev) fail('precondition_failed', `the channel is at rev ${String(channel.rev)}`);
  if (channel.status !== 'active') fail('invalid_state', `the channel is ${String(channel.status)}`);

  const now = deps.now().toISOString();
  const approved = channel.latestApproved as { submissionId?: string } | undefined;
  // A revoked channel no longer uses its collections (DES-008 K-9).
  const uses = await usesOfChannel(deps, channelId);
  await guarded(() =>
    deps.db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.table,
              Item: {
                PK: `CH#${channelId}`,
                SK: `REVOKE#${now}`,
                type: 'revocation',
                channelId,
                ...(versions ? { versions } : {}),
                reason,
                severity,
                operatorSub: req.caller.sub,
                revokedAt: now,
                GSI2PK: 'REVOKED',
                GSI2SK: `${now}#${channelId}`,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Update: {
              TableName: deps.table,
              Key: { PK: `CH#${channelId}`, SK: 'CH' },
              UpdateExpression: 'SET #status = :revoked, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK',
              ConditionExpression: 'rev = :rev AND #status = :active',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':revoked': 'revoked', ':active': 'active', ':now': now, ':one': 1, ':rev': rev },
            },
          },
          ...(approved?.submissionId
            ? [
                {
                  Update: {
                    TableName: deps.table,
                    Key: { PK: `CH#${channelId}`, SK: `SUB#${approved.submissionId}` },
                    UpdateExpression: 'SET #state = :revoked, updatedAt = :now, rev = rev + :one',
                    ConditionExpression: '#state = :approved',
                    ExpressionAttributeNames: { '#state': 'state' },
                    ExpressionAttributeValues: { ':revoked': 'revoked', ':approved': 'approved', ':now': now, ':one': 1 },
                  },
                },
              ]
            : []),
          auditItem(deps, req.caller, { action: 'channel.revoke', target: `CH#${channelId}`, reason, detail: { severity, versions: versions ?? null } }),
          ...deleteUses(deps, uses),
        ],
      }),
    ),
  );
  await deps.requestPublish('revoke');
  await notifyAfter(deps, { event: 'channel.revoked', publisherId: String(channel.publisherId), channelId, message: reason });
  return withEtag(200, await channelView(deps, await loadChannel(deps, channelId)));
}

// ---- signing keys and keysets ----

function signingKeyView(item: Item): Schemas['SigningKey'] {
  return {
    keyId: String(item.keyId),
    kmsKeyArn: String(item.kmsKeyArn),
    publicKey: String(item.publicKey),
    notBefore: (item.notBefore as string | undefined) ?? null,
    notAfter: (item.notAfter as string | undefined) ?? null,
    status: item.status as Schemas['SigningKey']['status'],
  };
}

export async function listSigningKeys(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const out = await deps.db.send(
    new QueryCommand({ TableName: deps.table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'SIGNKEY' } }),
  );
  return json(200, { items: (out.Items ?? []).map(signingKeyView) });
}

/** Registers a KMS key as a signing key; it signs once a root-signed keyset lists it. */
export async function registerSigningKey(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const body = object(req.body);
  const keyId = requiredText(body, 'keyId', { max: 20, pattern: /^k-[0-9]{4}-[0-9]{2}$/ });
  const kmsKeyArn = requiredText(body, 'kmsKeyArn', { max: 200, pattern: /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]+$/ });
  const key = await deps.kmsPublicKey(kmsKeyArn).catch(() => fail('invalid_request', `cannot read ${kmsKeyArn} from KMS`));
  if (key.keySpec !== 'ECC_NIST_EDWARDS25519') fail('invalid_request', `${kmsKeyArn} is not an Ed25519 key`);
  const raw = rawPublicKey(createPublicKey({ key: Buffer.from(key.publicKey), format: 'der', type: 'spki' }));
  publicKeyFromRaw(raw);
  const item = { PK: 'SIGNKEY', SK: `KEY#${keyId}`, type: 'signing-key', keyId, kmsKeyArn, publicKey: b64url.encode(raw), status: 'registered', createdAt: deps.now().toISOString() };
  await deps.db
    .send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: deps.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
          auditItem(deps, req.caller, { action: 'signing-key.register', target: `SIGNKEY#${keyId}`, detail: { kmsKeyArn } }),
        ],
      }),
    )
    .catch((e: unknown) => {
      if ((e as { name?: string }).name === 'TransactionCanceledException') fail('invalid_state', `${keyId} is already registered`);
      throw e;
    });
  return json(201, signingKeyView(item));
}

function keysetView(item: Item): Schemas['Keyset'] {
  return {
    seq: Number(item.seq),
    document: item.document as Schemas['SignedDocument'],
    keyIds: (item.keyIds as string[] | undefined) ?? [],
    revokedKeyIds: (item.revokedKeyIds as string[] | undefined) ?? [],
    registeredAt: String(item.registeredAt ?? item.verifiedAt),
  };
}

export async function listKeysets(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const { items, nextCursor } = await page(deps, req, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :seq)',
    ExpressionAttributeValues: { ':pk': 'KEYSET', ':seq': 'SEQ#' },
    ScanIndexForward: false,
  });
  return json(200, { items: items.map(keysetView), nextCursor });
}

/**
 * Registers a keyset signed by the root key offline (ARCH-001 A-9). Every key it lists must be a
 * registered signing key with the same public key; listed keys become active, revoked ones revoked,
 * and active keys it drops are retiring. Then the list is published again.
 */
export async function registerKeyset(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const document = object(req.body).document;
  const provider = providerId(b64url.decode(deps.rootPublicKey));
  let keyset;
  try {
    keyset = verifyDiscovery(
      { provider, name: '-', versions: ['v1'], list: '/v1/channels.json', rootKey: deps.rootPublicKey, keyset: document },
      { expectedProvider: provider },
    ).keyset;
  } catch (e) {
    if (e instanceof ProtocolError) {
      return fail(e.code === 'bad_signature' || e.code === 'unknown_key' ? 'invalid_signature' : 'keyset_invalid', e.message);
    }
    throw e;
  }
  const head = await get(deps, 'KEYSET', 'HEAD');
  if (head && keyset.seq <= Number(head.seq)) fail('keyset_invalid', `seq ${keyset.seq} is not after ${String(head.seq)}`);

  const registered = await deps.db.send(
    new QueryCommand({ TableName: deps.table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'SIGNKEY' } }),
  );
  const byId = new Map((registered.Items ?? []).map((k) => [String(k.keyId), k]));
  for (const key of keyset.keys) {
    const known = byId.get(key.keyId) ?? fail('keyset_invalid', `${key.keyId} is not a registered signing key`);
    if (known.publicKey !== key.publicKey) fail('keyset_invalid', `${key.keyId} has another public key in KMS`);
    if (known.status === 'revoked') fail('keyset_invalid', `${key.keyId} was revoked`);
  }

  const now = deps.now().toISOString();
  const record = {
    type: 'keyset',
    seq: keyset.seq,
    document,
    keyIds: keyset.keys.map((k) => k.keyId),
    revokedKeyIds: keyset.revokedKeys,
    registeredBy: req.caller.sub,
    registeredAt: now,
  };
  const keyUpdates = [...byId.values()].flatMap((k) => {
    const listed = keyset.keys.find((e) => e.keyId === k.keyId);
    const status = listed ? 'active' : keyset.revokedKeys.includes(String(k.keyId)) ? 'revoked' : k.status === 'active' ? 'retiring' : k.status;
    if (status === k.status && !listed) return [];
    return [
      {
        Update: {
          TableName: deps.table,
          Key: { PK: 'SIGNKEY', SK: String(k.SK) },
          UpdateExpression: listed ? 'SET #status = :s, notBefore = :nb, notAfter = :na' : 'SET #status = :s',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':s': status, ...(listed ? { ':nb': listed.notBefore, ':na': listed.notAfter } : {}) },
        },
      },
    ];
  });
  await guarded(() =>
    deps.db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.table,
              Item: { PK: 'KEYSET', SK: 'HEAD', ...record },
              ...(head
                ? { ConditionExpression: 'seq = :prev', ExpressionAttributeValues: { ':prev': head.seq } }
                : { ConditionExpression: 'attribute_not_exists(PK)' }),
            },
          },
          { Put: { TableName: deps.table, Item: { PK: 'KEYSET', SK: `SEQ#${String(keyset.seq).padStart(10, '0')}`, ...record }, ConditionExpression: 'attribute_not_exists(PK)' } },
          ...keyUpdates,
          auditItem(deps, req.caller, { action: 'keyset.register', target: 'KEYSET', detail: { seq: keyset.seq, keys: record.keyIds, revoked: record.revokedKeyIds } }),
        ],
      }),
    ),
  );
  await deps.requestPublish('keyset');
  return json(201, keysetView(record));
}

// ---- publications ----

export async function listPublications(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const { items, nextCursor } = await page(deps, req, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :seq)',
    ExpressionAttributeValues: { ':pk': 'PUBLICATION', ':seq': 'SEQ#' },
    ScanIndexForward: false,
  });
  return json(200, {
    items: items.map((i) => ({
      seq: i.seq, issuedAt: i.issuedAt, expiresAt: i.expiresAt, sha256: i.sha256, size: i.size, keyId: i.keyId,
      trigger: i.trigger, channelCount: i.channelCount, revokedCount: i.revokedCount,
    })),
    nextCursor,
  });
}

export async function republish(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const reason = requiredText(object(req.body), 'reason', { max: 500 });
  await deps.db.send(new TransactWriteCommand({ TransactItems: [auditItem(deps, req.caller, { action: 'publication.request', target: 'PUBLICATION', reason })] }));
  await deps.requestPublish('manual');
  return json(202, undefined);
}

// ---- audit ----

export async function listAudit(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const month = text(req.query as Record<string, unknown>, 'month', { optional: true, max: 7, pattern: /^\d{4}-\d{2}$/ });
  const target = text(req.query as Record<string, unknown>, 'target', { optional: true, max: 100, pattern: /^[A-Z]+#[A-Za-z0-9-]+$|^[A-Z]+$/ });
  if ((month === undefined) === (target === undefined)) fail('invalid_request', 'give either month or target');
  const { items, nextCursor } = await page(
    deps,
    req,
    month
      ? { KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `AUDIT#${month}` }, ScanIndexForward: false }
      : { IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': `TARGET#${target}` }, ScanIndexForward: false },
  );
  return json(200, {
    items: items.map((a) => ({
      eventId: a.eventId, at: a.at, actorSub: a.actorSub, actorRole: a.actorRole, action: a.action, target: a.target,
      ...(a.reason ? { reason: a.reason } : {}), ...(a.detail ? { detail: a.detail } : {}),
    })),
    nextCursor,
  });
}
