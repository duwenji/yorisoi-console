import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChannelEntry, CollectionEntry, RevokedEntry, SignedDocument } from '@yorisoi-console/protocol';
import {
  SeqConflictError,
  type Cdn,
  type DocumentStorage,
  type ListedChannel,
  type PublicationRecord,
  type PublicationStore,
  type SigningKeyRecord,
} from './ports.js';

/** A channel as the store keeps it: the list entry plus how long its publisher change is shown. */
export interface StoredChannel {
  entry: Omit<ChannelEntry, 'publisherChange'>;
  publisherChange?: { from: string; at: string; reason: string; until?: string };
  /** What the channel fetches ahead and shows; none when left out. */
  material?: ListedChannel['material'];
}

const NO_MATERIAL: ListedChannel['material'] = { ownPrefetchBytes: 0, ownMedia: [], collections: [] };

export interface StoredCollection {
  entry: Omit<CollectionEntry, 'producerChange'>;
  producerChange?: { from: string; at: string; reason: string; until?: string };
}

function shown<T extends { from: string; at: string; reason: string; until?: string }>(change: T | undefined, listedBy: string, now: Date) {
  if (!change?.until || Date.parse(change.until) <= now.getTime() || change.from === listedBy) return undefined;
  const { until: _until, ...rest } = change;
  return rest;
}

/** The store in memory, for tests and local runs. */
export class MemoryStore implements PublicationStore {
  channels: StoredChannel[] = [];
  revoked: (RevokedEntry & { listed: boolean })[] = [];
  collections: StoredCollection[] = [];
  revokedCollections: (RevokedEntry & { listed: boolean })[] = [];
  keyset: SignedDocument | null = null;
  keys = new Map<string, SigningKeyRecord>();
  history: PublicationRecord[] = [];

  async headSeq() {
    return this.history.at(-1)?.seq ?? null;
  }

  async listedChannels(now: Date): Promise<ListedChannel[]> {
    // As DynamoStore: shown once the listed version is by the new account, until `until` (API-CHANNEL-LIST P-9).
    return this.channels.map(({ entry, publisherChange, material }) => {
      const change = shown(publisherChange, entry.publisher, now);
      return { entry: { ...entry, ...(change ? { publisherChange: change } : {}) }, material: material ?? NO_MATERIAL };
    });
  }

  async listedCollections(now: Date): Promise<CollectionEntry[]> {
    return this.collections.map(({ entry, producerChange }) => {
      const change = shown(producerChange, entry.producer, now);
      return { ...entry, ...(change ? { producerChange: change } : {}) };
    });
  }

  async revocations(since: Date) {
    return this.revoked
      .filter((r) => r.listed && Date.parse(r.revokedAt) >= since.getTime())
      .map(({ listed: _listed, ...r }) => r);
  }

  async collectionRevocations(since: Date) {
    return this.revokedCollections
      .filter((r) => r.listed && Date.parse(r.revokedAt) >= since.getTime())
      .map(({ listed: _listed, ...r }) => r);
  }

  async expireRevocations(before: Date) {
    for (const r of [...this.revoked, ...this.revokedCollections]) if (Date.parse(r.revokedAt) < before.getTime()) r.listed = false;
  }

  async currentKeyset() {
    return this.keyset;
  }

  async signingKey(keyId: string) {
    return this.keys.get(keyId) ?? null;
  }

  async recordPublication(previousSeq: number | null, record: PublicationRecord) {
    if ((this.history.at(-1)?.seq ?? null) !== previousSeq) throw new SeqConflictError(previousSeq);
    this.history.push(record);
  }
}

/** Writes the documents to a folder laid out as the public site (`.well-known/…`, `v1/…`) plus `archive/`. */
export class FolderStorage implements DocumentStorage {
  constructor(private readonly root: string) {}

  async putPublic(path: string, body: Uint8Array) {
    await this.write(join(this.root, 'public', path), body);
  }

  async putArchive(path: string, body: Uint8Array) {
    await this.write(join(this.root, 'archive', path), body);
  }

  private async write(file: string, body: Uint8Array) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
}

/** Keeps the public documents in memory, for tests. */
export class MemoryStorage implements DocumentStorage {
  public = new Map<string, Uint8Array>();
  archive = new Map<string, Uint8Array>();

  async putPublic(path: string, body: Uint8Array) {
    this.public.set(path, body);
  }

  async putArchive(path: string, body: Uint8Array) {
    this.archive.set(path, body);
  }
}

export const noCdn: Cdn = { invalidate: async () => {} };
