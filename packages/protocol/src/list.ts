import { b64url, sha256Hex } from './encoding.js';
import { LIMITS } from './limits.js';
import { payloadBytes, signDocument, type Signer } from './signed.js';
import type { ChannelEntry, ChannelList, ChannelListDigest, ChannelListDocument, CollectionEntry, RevokedEntry } from './types.js';

export interface ListContent {
  provider: string;
  seq: number;
  issuedAt: Date;
  expiresAt: Date;
  channels: ChannelEntry[];
  revoked: RevokedEntry[];
  /** API-CHANNEL-LIST: written on every list, empty or not. */
  collections?: CollectionEntry[];
  revokedCollections?: RevokedEntry[];
}

/** Builds the channel list and signs its digest (API-CHANNEL-LIST P-8). */
export async function signChannelList(content: ListContent, signer: Signer): Promise<{
  document: ChannelListDocument;
  body: ChannelList;
  digest: ChannelListDigest;
}> {
  if (content.expiresAt.getTime() - content.issuedAt.getTime() > LIMITS.listLifetimeMs) {
    throw new Error('a list may live 14 days at most');
  }
  const body: ChannelList = {
    type: 'channel-list',
    format: 1,
    provider: content.provider,
    seq: content.seq,
    issuedAt: content.issuedAt.toISOString(),
    expiresAt: content.expiresAt.toISOString(),
    channels: content.channels,
    revoked: content.revoked,
    collections: content.collections ?? [],
    revokedCollections: content.revokedCollections ?? [],
  };
  const bytes = payloadBytes(body);
  if (bytes.length > LIMITS.listBytes) throw new Error(`list is ${bytes.length} bytes (max ${LIMITS.listBytes})`);
  const digest: ChannelListDigest = {
    type: 'channel-list-digest',
    provider: body.provider,
    seq: body.seq,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    sha256: sha256Hex(bytes),
    size: bytes.length,
  };
  if (payloadBytes(digest).length >= LIMITS.digestPayloadBytes) throw new Error('digest too large for KMS');
  return { document: { payload: b64url.encode(bytes), digest: await signDocument(digest, signer) }, body, digest };
}
