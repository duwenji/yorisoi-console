import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Deps } from './deps.js';
import { ApiError, fail, json, problem, type Caller, type Request, type Response } from './http.js';
import * as col from './collections.js';
import * as op from './operator.js';
import * as pub from './publisher.js';
import * as review from './review.js';
import * as studio from './studio.js';
import * as local from './local-ops.js';
import * as notes from './notes-ops.js';
import * as ops from './studio-ops.js';
import type { Request as Req } from './http.js';
import * as transfer from './transfer.js';

type Handler = (deps: Deps, req: Request) => Promise<Response>;

/** The logged-in user, their roles, and their publisher if they have one (API-001 `/api/me`). */
async function me(deps: Deps, req: Request): Promise<Response> {
  const user = (await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: `USER#${req.caller.sub}`, SK: 'USER' } }))).Item;
  let publisher = null;
  if (user?.publisherId) {
    const pub = (await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: `PUB#${String(user.publisherId)}`, SK: 'PUB' } }))).Item;
    if (pub) publisher = { publisherId: pub.publisherId, displayName: pub.displayName, status: pub.status, rev: pub.rev };
  }
  return json(200, { sub: req.caller.sub, roles: req.caller.roles, publisher });
}

/** A studio's appeal is answered with publish or reject; a report with restore or remove. */
function studioDecision(deps: Deps, req: Req): Promise<Response> {
  const d = req.params.decision;
  return d === 'restore' || d === 'remove' ? ops.decideReportedStudio(deps, req, d) : studio.decideAppeal(deps, req);
}

const ROUTES: [string, string, Handler][] = [
  ['GET', '/api/me', me],
  // The publisher (implementation stage 3a).
  ['POST', '/api/publisher', pub.registerPublisher],
  ['GET', '/api/publisher', pub.getMyPublisher],
  ['PATCH', '/api/publisher', pub.updateMyPublisher],
  ['DELETE', '/api/publisher', pub.deleteMyPublisher],
  ['POST', '/api/publisher/keys/challenge', pub.createKeyChallenge],
  ['POST', '/api/publisher/keys', pub.bindFirstKey],
  ['GET', '/api/publisher/keys', pub.listMyKeys],
  // Key transfers (implementation stage 3d).
  ['POST', '/api/publisher/key-transfers', transfer.requestKeyTransfer],
  ['GET', '/api/publisher/key-transfers', transfer.listMyKeyTransfers],
  ['POST', '/api/publisher/key-transfers/{transferId}/cancel', transfer.cancelKeyTransfer],
  // The producer (API-001, DES-008).
  ['POST', '/api/publisher/roles/producer', col.enableProducerRole],
  ['POST', '/api/collections', col.registerCollection],
  ['GET', '/api/collections', col.listMyCollections],
  ['GET', '/api/collections/{collectionId}', col.getCollection],
  ['GET', '/api/collections/{collectionId}/used-by', col.listCollectionUsers],
  ['POST', '/api/collections/{collectionId}/submissions', col.createCollectionSubmission],
  ['GET', '/api/collections/{collectionId}/submissions', col.listCollectionSubmissions],
  ['GET', '/api/collections/{collectionId}/submissions/{submissionId}', col.getCollectionSubmission],
  ['POST', '/api/collections/{collectionId}/submissions/{submissionId}/withdraw', col.withdrawCollectionSubmission],
  ['POST', '/api/channels', pub.registerChannel],
  ['GET', '/api/channels', pub.listMyChannels],
  ['GET', '/api/channels/{channelId}', pub.getChannel],
  ['POST', '/api/channels/{channelId}/submissions', pub.createSubmission],
  ['GET', '/api/channels/{channelId}/submissions', pub.listSubmissions],
  ['GET', '/api/channels/{channelId}/submissions/{submissionId}', pub.getSubmission],
  ['POST', '/api/channels/{channelId}/submissions/{submissionId}/withdraw', pub.withdrawSubmission],
  ['POST', '/api/channels/{channelId}/submissions/{submissionId}/test-tickets', pub.issueTestTicket],
  ['GET', '/api/channels/{channelId}/submissions/{submissionId}/test-tickets', pub.listTestTickets],
  // The operator.
  ['POST', '/api/admin/channels/{channelId}/revoke', op.revokeChannel],
  // Review (implementation stage 3c).
  ['GET', '/api/admin/review-queue', review.listReviewQueue],
  ['GET', '/api/admin/channels/{channelId}/submissions/{submissionId}/package', review.getSubmissionPackage],
  ['GET', '/api/admin/channels/{channelId}/submissions/{submissionId}/sample-prompts', review.getSamplePrompts],
  ['POST', '/api/admin/channels/{channelId}/submissions/{submissionId}/samples', review.saveSamples],
  ['GET', '/api/admin/channels/{channelId}/submissions/{submissionId}/reviews', review.listReviews],
  ['POST', '/api/admin/channels/{channelId}/submissions/{submissionId}/start', review.startReview],
  ['POST', '/api/admin/channels/{channelId}/submissions/{submissionId}/release', review.releaseReview],
  ['POST', '/api/admin/channels/{channelId}/submissions/{submissionId}/approve', review.approveSubmission],
  ['POST', '/api/admin/channels/{channelId}/submissions/{submissionId}/return', review.returnSubmission],
  ['POST', '/api/admin/channels/{channelId}/submissions/{submissionId}/reject', review.rejectSubmission],
  // Collections (DES-008).
  ['GET', '/api/admin/collections/{collectionId}/submissions/{submissionId}/package', review.getCollectionSubmissionPackage],
  ['GET', '/api/admin/collections/{collectionId}/submissions/{submissionId}/reviews', review.listCollectionReviews],
  ['POST', '/api/admin/collections/{collectionId}/submissions/{submissionId}/start', review.startCollectionReview],
  ['POST', '/api/admin/collections/{collectionId}/submissions/{submissionId}/release', review.releaseCollectionReview],
  ['POST', '/api/admin/collections/{collectionId}/submissions/{submissionId}/approve', review.approveCollectionSubmission],
  ['POST', '/api/admin/collections/{collectionId}/submissions/{submissionId}/return', review.returnCollectionSubmission],
  ['POST', '/api/admin/collections/{collectionId}/submissions/{submissionId}/reject', review.rejectCollectionSubmission],
  ['POST', '/api/admin/collections/{collectionId}/revoke', review.revokeCollection],
  ['GET', '/api/admin/publishers/{publisherId}/collections', col.listPublisherCollections],
  ['GET', '/api/admin/publishers', op.listPublishers],
  ['GET', '/api/admin/publishers/{publisherId}', op.getPublisher],
  ['GET', '/api/admin/publishers/{publisherId}/channels', op.listPublisherChannels],
  ['POST', '/api/admin/publishers/{publisherId}/suspend', op.setPublisherSuspended(true)],
  ['POST', '/api/admin/publishers/{publisherId}/resume', op.setPublisherSuspended(false)],
  ['PUT', '/api/admin/publishers/{publisherId}/limits', op.setPublisherLimits],
  ['GET', '/api/admin/key-transfers', transfer.listKeyTransfers],
  ['POST', '/api/admin/publishers/{publisherId}/key-transfers/{transferId}/approve', transfer.approveKeyTransfer],
  ['POST', '/api/admin/publishers/{publisherId}/key-transfers/{transferId}/reject', transfer.rejectKeyTransfer],
  ['GET', '/api/admin/signing-keys', op.listSigningKeys],
  ['POST', '/api/admin/signing-keys', op.registerSigningKey],
  ['GET', '/api/admin/keysets', op.listKeysets],
  ['POST', '/api/admin/keysets', op.registerKeyset],
  ['GET', '/api/admin/publications', op.listPublications],
  ['POST', '/api/admin/publications', op.republish],
  ['GET', '/api/admin/audit', op.listAudit],
  // The studio (DES-013 K-14〜K-17).
  ['GET', '/api/studio', studio.getMyStudio],
  ['POST', '/api/studio/application', studio.applyForStudio],
  ['GET', '/api/studio/studios', studio.listMyStudios],
  ['POST', '/api/studio/studios', studio.createStudio],
  ['POST', '/api/studio/studios/{studioId}/{action}', studio.actOnStudio],
  ['GET', '/api/admin/studio/applications', studio.listStudioApplications],
  ['GET', '/api/admin/publishers/{publisherId}/studio', studio.getPublisherStudio],
  ['POST', '/api/admin/publishers/{publisherId}/studio/{decision}', studio.decideStudio],
  ['GET', '/api/admin/studio/appeals', studio.listStudioAppeals],
  ['POST', '/api/admin/studio/studios/{studioId}/{decision}', studioDecision],
  // The studio after things are up (DES-013 K-17, K-18).
  ['GET', '/api/studio/studios/{studioId}/stats', ops.studioStats],
  ['GET', '/api/admin/studio/reported', ops.listReportedStudios],
  // The notes (DES-013 K-17): reported ones and the devices banned from putting them.
  ['GET', '/api/admin/notes/reported', notes.listReportedNotes],
  ['POST', '/api/admin/notes/{noteId}/{decision}', notes.decideReportedNote],
  ['GET', '/api/admin/notes/bans', notes.listBans],
  ['DELETE', '/api/admin/notes/bans/{noteId}', notes.liftBan],
  // Closed areas, for studios and notes alike (REQ-STUDIO・REQ-NOTES F-15).
  ['GET', '/api/admin/local/areas', local.listAreas],
  ['POST', '/api/admin/local/areas', local.closeArea],
  ['DELETE', '/api/admin/local/areas/{cell}', local.openArea],
];

const PARAM: Record<string, RegExp> = {
  channelId: /^[a-z0-9-]{3,40}$/,
  collectionId: /^[a-z0-9-]{3,40}$/,
  publisherId: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  submissionId: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  transferId: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  studioId: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  action: /^(submit|stop|appeal)$/,
  decision: /^(approve|decline|suspend|resume|revoke|publish|reject|restore|remove)$/,
  noteId: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  cell: /^[0123456789bcdefghjkmnpqrstuvwxyz]{5,7}$/,
};

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = decodeURIComponent(got[i]!);
    if (w.startsWith('{')) {
      const name = w.slice(1, -1);
      // A malformed id can't name anything: 404 rather than a lookup with it.
      if (PARAM[name] && !PARAM[name].test(g)) return null;
      params[name] = g;
    } else if (w !== g) {
      return null;
    }
  }
  return params;
}

export async function route(deps: Deps, input: Omit<Request, 'params'>): Promise<Response> {
  try {
    for (const [method, pattern, handler] of ROUTES) {
      const params = match(pattern, input.path);
      if (params && method === input.method) return await handler(deps, { ...input, params });
    }
    return fail('not_found', `${input.method} ${input.path}`);
  } catch (e) {
    if (e instanceof ApiError) return problem(e, input.requestId);
    console.error(JSON.stringify({ requestId: input.requestId, error: e instanceof Error ? e.stack : String(e) }));
    return problem(new ApiError('internal', 'internal error'), input.requestId);
  }
}

/** Roles from the `cognito:groups` claim, which an HTTP API passes as `[a b]` text or an array. */
export function callerFrom(claims: Record<string, unknown>): Caller {
  const raw = claims['cognito:groups'];
  const groups = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean) : [];
  return {
    sub: String(claims.sub ?? fail('unauthorized', 'no subject')),
    roles: groups.filter((g): g is 'operator' | 'publisher' => g === 'operator' || g === 'publisher'),
  };
}
