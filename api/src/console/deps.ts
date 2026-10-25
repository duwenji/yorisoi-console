import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { appsFor, KNOWN_APPS, NO_APP_VERSION, type KnownApp, type SignedDocument } from '@yorisoi-console/protocol';
import type { Trigger } from '../publish/ports.js';
import { fail, type Caller } from './http.js';
import { ulid, type CursorCodec } from './util.js';

/** Everything the console API needs from outside; tests give DynamoDB Local and fakes. */
export interface Deps {
  db: DynamoDBDocumentClient;
  table: string;
  now: () => Date;
  cursors: CursorCodec;
  /** The provider's root public key (base64url), pinned in the configuration (ADR-001 A-9). */
  rootPublicKey: string;
  /** Reads a KMS key's public key (DER SubjectPublicKeyInfo) and key spec. */
  kmsPublicKey: (keyArn: string) => Promise<{ keySpec: string | undefined; publicKey: Uint8Array }>;
  /** Starts the publisher without waiting for it (ADR-001 A-10). */
  requestPublish: (trigger: Trigger) => Promise<void>;
  /** A presigned S3 POST into the intake bucket; S3 enforces the size (API-001 C-10). */
  presignUpload: (key: string, contentType: string, maxBytes: number) => Promise<{ url: string; fields: Record<string, string> }>;
  /** Moves an intake object under `archive/`, where it expires after 90 days (DM-001 M-4). */
  archiveUpload: (key: string) => Promise<void>;
  /** Deletes the Cognito user (API-001 C-4, leaving). */
  deleteUser: (sub: string) => Promise<void>;
  /** Copies a package from the intake bucket to the public `trial/{sha256}.zip` (7 days) and returns its URL (ADR-001 A-13). */
  publishTrial: (intakeKey: string, sha256: string) => Promise<string>;
  /** The public URL of an approved package. */
  packageUrl: (sha256: string) => string;
  /** Signs a document with the active signing key in KMS (ADR-001 A-8). */
  signDocument: (content: object) => Promise<SignedDocument>;
  /** Reads an uploaded file from the intake bucket. */
  readUpload: (key: string) => Promise<Uint8Array>;
  /** A short-lived URL to download an uploaded file (5 minutes). */
  presignDownload: (key: string) => Promise<string>;
  /** Reads and writes the records bucket (review samples, DM-001 M-13). */
  readRecord: (key: string) => Promise<string | undefined>;
  writeRecord: (key: string, body: string) => Promise<void>;
  /** Copies an approved package and icon to the public bucket (`pkg/`, `icons/`) and returns their URLs. */
  publishApproved: (files: { packageKey: string; packageSha256: string; iconKey: string; iconSha256: string }) => Promise<{ packageUrl: string; iconUrl: string }>;
  /** Queues an email to the publisher (ADR-001 A-19); the notification Lambda sends it. */
  notify: (notice: Notice) => Promise<void>;
  /** Copies an approved collection package to the public `col/{sha256}.zip` and returns its URL (DES-008 K-4). */
  publishCollection: (packageKey: string, sha256: string) => Promise<string>;
  /** The apps of the ecosystem the console knows (DES-011 N-4), by app id. */
  apps: Record<string, AppEntry>;
}

/**
 * An app of the ecosystem (DES-011 N-4): what it is (`KNOWN_APPS`), and the version (versionCode)
 * that first shows each app stage of material (API-001 C-21), from the configuration.
 */
export interface AppEntry extends KnownApp {
  stageVersions: Record<number, number>;
}

/** The versions until configured: SanpoGuide shows stage 0 and 1 (text and images) from versionCode 1. */
export const DEFAULT_STAGE_VERSIONS: Record<string, Record<number, number>> = {
  sanpoguide: { 0: 1, 1: 1, 2: NO_APP_VERSION, 3: NO_APP_VERSION },
  cycleguide: { 0: 1, 1: NO_APP_VERSION, 2: NO_APP_VERSION, 3: NO_APP_VERSION },
};

/** The known apps with their configured versions; an app without them shows no material yet. */
export function appsWith(stageVersions: Record<string, Record<number, number>>): Record<string, AppEntry> {
  return Object.fromEntries(Object.entries(KNOWN_APPS).map(([id, app]) => [id, { ...app, stageVersions: stageVersions[id] ?? { 0: 1 } }]));
}

export const DEFAULT_APPS: Record<string, AppEntry> = appsWith(DEFAULT_STAGE_VERSIONS);

/** The version [app] needs for an app stage; a stage it doesn't show yet needs a version no app has. */
function stageVersion(app: AppEntry, stage: number): number {
  return app.stageVersions[stage] ?? NO_APP_VERSION;
}

/**
 * `minAppVersions` of a channel (DES-011 N-5): the apps it is for (its activities) that implement
 * what it requires, each with the version its stage needs.
 */
export function channelMinVersions(deps: Pick<Deps, 'apps'>, stage: number, activities: string[], requires: string[]): Record<string, number> {
  return Object.fromEntries(appsFor(activities, requires, deps.apps).map((id) => [id, stageVersion(deps.apps[id]!, stage)]));
}

/** `minAppVersions` of a collection (DES-011 N-5): the apps its `grants.apps` names, or every app. */
export function collectionMinVersions(deps: Pick<Deps, 'apps'>, stage: number, apps: string[] | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(deps.apps)
    .filter(([id]) => apps === undefined || apps.includes(id))
    .map(([id, app]) => [id, stageVersion(app, stage)]));
}

/** What happened, for the publisher's email (API-001 C-14). No samples, operator ids or tokens. */
export interface Notice {
  /** Identifies the notice, so a redelivered message is sent only once (CV-13). */
  noticeId: string;
  event:
    | 'submission.approved' | 'submission.returned' | 'submission.rejected' | 'channel.revoked' | 'transfer.approved' | 'transfer.rejected'
    // To the producer (API-001 C-20).
    | 'collection.approved' | 'collection.returned' | 'collection.rejected' | 'collection.revoked' | 'collection.external_failed'
    // To the publishers of the channels that use the collection (API-001 C-20, D-18).
    | 'collection.updated' | 'collection.revoked_used' | 'collection.grants_narrowed';
  publisherId: string;
  channelId?: string;
  collectionId?: string;
  submissionId?: string;
  version?: number;
  transferId?: string;
  /** The operator's message or reason, shown to the publisher. */
  message?: string;
  findings?: { item: string; detail: string }[];
  /** Pending submissions a transfer returned. */
  returned?: number;
}

/**
 * Queues a notice after the change is written. A failure is logged and never fails the operation
 * (API-001 C-14): the change already happened.
 */
export async function notifyAfter(deps: Deps, notice: Omit<Notice, 'noticeId'>): Promise<void> {
  try {
    await deps.notify({ noticeId: ulid(deps.now().getTime()), ...notice });
  } catch (e) {
    console.error(JSON.stringify({ notice: notice.event, publisherId: notice.publisherId, error: e instanceof Error ? e.message : String(e) }));
  }
}

/** One entry of the audit log, written in the same transaction as the change (DM-001 AUDIT, DV-10). */
export function auditItem(
  deps: Pick<Deps, 'table' | 'now'>,
  caller: Caller,
  entry: { action: string; target: string; reason?: string; detail?: Record<string, unknown> },
) {
  const at = deps.now().toISOString();
  const eventId = ulid(deps.now().getTime());
  const actorRole = caller.roles.includes('operator') ? 'operator' : caller.roles.includes('publisher') ? 'publisher' : 'system';
  return {
    Put: {
      TableName: deps.table,
      Item: {
        PK: `AUDIT#${at.slice(0, 7)}`,
        SK: `${at}#${eventId}`,
        GSI1PK: `TARGET#${entry.target}`,
        GSI1SK: at,
        type: 'audit',
        eventId,
        at,
        actorSub: caller.sub,
        actorRole,
        action: entry.action,
        target: entry.target,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      },
    },
  };
}

/** A conditional write lost to a concurrent one: the client should re-read (412). */
export async function guarded<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException || e instanceof TransactionCanceledException) {
      return fail('precondition_failed', 'changed by someone else; read it again');
    }
    throw e;
  }
}
