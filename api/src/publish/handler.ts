import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { b64url } from '@yorisoi-console/protocol';
import type { Notice } from '../console/deps.js';
import { ulid } from '../console/util.js';
import { CloudFrontCdn, DynamoStore, S3Storage, kmsSigner } from './aws.js';
import { checkExternalResources } from './external.js';
import { SeqConflictError, type Trigger } from './ports.js';
import { publish, type ProviderConfig } from './publisher.js';

const TRIGGERS: readonly Trigger[] = ['approve', 'revoke', 'transfer', 'keyset', 'daily', 'manual'];

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

const config: ProviderConfig = {
  rootPublicKey: b64url.decode(env('ROOT_PUBLIC_KEY')),
  name: env('PROVIDER_NAME'),
  ...(optional('REVIEW_POLICY_URL') ? { reviewPolicyUrl: optional('REVIEW_POLICY_URL')! } : {}),
  ...(optional('TERMS_URL') ? { termsUrl: optional('TERMS_URL')! } : {}),
  ...(optional('CONTACT') ? { contact: optional('CONTACT')! } : {}),
};

const store = new DynamoStore(env('TABLE_NAME'));
const sqs = new SQSClient({});

const deps = {
  store,
  storage: new S3Storage(env('PUBLIC_BUCKET'), env('ARCHIVE_BUCKET')),
  cdn: new CloudFrontCdn(env('DISTRIBUTION_ID')),
  signerFor: kmsSigner,
  config,
};

/**
 * The publishing Lambda (ARCH-001 A-10). Invoked asynchronously by the API after an approval,
 * revocation, key transfer or keyset registration, and daily by EventBridge Scheduler.
 * Reserved concurrency 1 keeps runs apart; the conditional write on `seq` guards the rest.
 */
export async function handler(event: { trigger?: string } = {}) {
  const trigger = TRIGGERS.includes(event.trigger as Trigger) ? (event.trigger as Trigger) : 'manual';
  let record;
  try {
    record = await publish(deps, trigger);
  } catch (e) {
    // Another run took the next seq in between: build again on top of it, once.
    if (!(e instanceof SeqConflictError)) throw e;
    record = await publish(deps, trigger);
  }
  if (trigger === 'daily') await dailyExternalCheck();
  return record;
}

/** The daily check of outside resources (DES-009 M-7), after the list is out: it never fails the run. */
async function dailyExternalCheck() {
  try {
    const result = await checkExternalResources({
      targets: () => store.externalTargets(),
      record: (id, check) => store.recordExternalCheck(id, check),
      now: () => new Date(),
      notifyFailures: async (target, failures) => {
        const notice: Notice = {
          noticeId: ulid(Date.now()), event: 'collection.external_failed', publisherId: target.publisherId, collectionId: target.collectionId,
          message: failures.map((f) => `${f.resourceId}: ${f.status}`).join('\n'),
        };
        await sqs.send(new SendMessageCommand({ QueueUrl: env('NOTIFY_QUEUE_URL'), MessageBody: JSON.stringify(notice) }));
      },
    });
    console.log(JSON.stringify({ externalCheck: result }));
  } catch (e) {
    console.error(JSON.stringify({ externalCheck: 'failed', error: e instanceof Error ? e.stack : String(e) }));
  }
}
