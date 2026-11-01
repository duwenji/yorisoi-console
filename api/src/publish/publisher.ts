import {
  b64url,
  payloadBytes,
  providerId,
  signChannelList,
  verifyChannelList,
  verifyDiscovery,
  type ChannelEntry,
  type CollectionEntry,
  type Discovery,
  type SigningKeyEntry,
} from '@yorisoi-console/protocol';
import type { Cdn, DocumentStorage, ListedChannel, PublicationRecord, PublicationStore, SignerFor, Trigger } from './ports.js';

export const DISCOVERY_PATH = '.well-known/sanpo-channels';
export const LIST_PATH = 'v1/channels.json';

const DAY = 24 * 3600_000;

export interface ProviderConfig {
  /** The root public key pinned in the configuration (ARCH-001 A-9); everything published must chain to it. */
  rootPublicKey: Uint8Array;
  name: string;
  reviewPolicyUrl?: string;
  termsUrl?: string;
  contact?: string;
  /** How long a list stays valid; at most 14 days (API-CHANNEL-LIST). */
  listLifetimeDays?: number;
  /** How long a revocation stays in `revoked` (DM-001 M-9). */
  revokedDays?: number;
}

export interface PublishDeps {
  store: PublicationStore;
  storage: DocumentStorage;
  cdn: Cdn;
  signerFor: SignerFor;
  config: ProviderConfig;
  now?: () => Date;
}

/** The signing key to use now: in the keyset, in its validity, not revoked, and active in the store. */
async function pickSigningKey(deps: PublishDeps, keys: SigningKeyEntry[], revoked: string[], now: Date) {
  const candidates = keys
    .filter((k) => !revoked.includes(k.keyId) && Date.parse(k.notBefore) <= now.getTime() && now.getTime() < Date.parse(k.notAfter))
    .sort((a, b) => Date.parse(b.notBefore) - Date.parse(a.notBefore));
  for (const key of candidates) {
    const record = await deps.store.signingKey(key.keyId);
    if (record?.status === 'active') return { entry: key, record };
  }
  throw new Error('no active signing key in the current keyset');
}

/**
 * A channel's entry with what its collections add (DES-009 M-4): its media and theirs, its prefetch
 * and theirs. A collection not listed now adds nothing (the app can't use it either).
 */
export function withMaterial(listed: ListedChannel, collections: Map<string, CollectionEntry>): ChannelEntry {
  const { entry, material } = listed;
  const used = material.collections.map((id) => collections.get(id)).filter((c): c is CollectionEntry => c !== undefined);
  return {
    ...entry,
    media: [...new Set([...material.ownMedia, ...used.flatMap((c) => c.media)])].sort(),
    resourcesSize: material.ownPrefetchBytes + used.reduce((sum, c) => sum + c.resourcesSize, 0),
  };
}

/**
 * Builds the channel list from the store, signs its digest, checks the result as an app would,
 * and puts it out (ARCH-001 A-10). Safe to run at any time: each run takes the next `seq`.
 */
export async function publish(deps: PublishDeps, trigger: Trigger): Promise<PublicationRecord> {
  const now = (deps.now ?? (() => new Date()))();
  const { config, store } = deps;

  const provider = providerId(config.rootPublicKey);
  const keysetDoc = (await store.currentKeyset()) ?? fail('no keyset has been registered');
  const discovery: Discovery = {
    provider,
    name: config.name,
    versions: ['v1'],
    list: `/${LIST_PATH}`,
    rootKey: b64url.encode(config.rootPublicKey),
    keyset: keysetDoc,
    ...(config.reviewPolicyUrl ? { reviewPolicyUrl: config.reviewPolicyUrl } : {}),
    ...(config.termsUrl ? { termsUrl: config.termsUrl } : {}),
    ...(config.contact ? { contact: config.contact } : {}),
  };
  // The keyset must be signed by the pinned root key.
  const { keyset } = verifyDiscovery(discovery, { expectedProvider: provider });

  const { entry, record: keyRecord } = await pickSigningKey(deps, keyset.keys, keyset.revokedKeys, now);
  const signer = deps.signerFor(keyRecord);
  if (signer.keyId !== entry.keyId) fail(`signer for ${entry.keyId} says it is ${signer.keyId}`);

  const previousSeq = await store.headSeq();
  const seq = (previousSeq ?? 0) + 1;
  const lifetimeDays = Math.min(config.listLifetimeDays ?? 14, 14);
  const since = new Date(now.getTime() - (config.revokedDays ?? 7) * DAY);
  const [listed, collections, revoked, revokedCollections] = await Promise.all([
    store.listedChannels(now),
    store.listedCollections(now),
    store.revocations(since),
    store.collectionRevocations(since),
  ]);
  const byId = new Map(collections.map((c) => [c.id, c]));
  const channels = listed.map((c) => withMaterial(c, byId));
  const { document, digest } = await signChannelList(
    { provider: keyset.provider, seq, issuedAt: now, expiresAt: new Date(now.getTime() + lifetimeDays * DAY), channels, revoked, collections, revokedCollections },
    signer,
  );

  // Never put out what an app would reject (e.g. a KMS key that isn't the one in the keyset).
  const verified = verifyChannelList(document, keyset, { now, minSeq: seq });
  if (verified.signingKey.keyId !== entry.keyId) fail('signed with an unexpected key');

  const listBytes = payloadBytes(document);
  const record: PublicationRecord = {
    seq,
    issuedAt: digest.issuedAt,
    expiresAt: digest.expiresAt,
    sha256: digest.sha256,
    size: digest.size,
    keyId: entry.keyId,
    archiveKey: `published/${seq}.json`,
    trigger,
    channelCount: channels.length,
    revokedCount: revoked.length,
    collectionCount: collections.length,
    revokedCollectionCount: revokedCollections.length,
  };
  await store.recordPublication(previousSeq, record);
  await deps.storage.putArchive(record.archiveKey, listBytes, 'application/json');
  await deps.storage.putPublic(LIST_PATH, listBytes, 'application/json', 'public, max-age=300');
  await deps.storage.putPublic(DISCOVERY_PATH, payloadBytes(discovery), 'application/json', 'public, max-age=300');
  await deps.cdn.invalidate([`/${LIST_PATH}`, `/${DISCOVERY_PATH}`]);
  await store.expireRevocations(new Date(now.getTime() - (config.revokedDays ?? 7) * DAY));
  return record;
}

function fail(message: string): never {
  throw new Error(message);
}
