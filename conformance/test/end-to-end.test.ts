import { MemoryStorage, MemoryStore, noCdn, publish, LIST_PATH } from '@yorisoi-console/api/publish';
import { b64url, sha256Hex, utf8 } from '@yorisoi-console/protocol';
import { makeTestProvider, sampleChannel, type TestProvider } from '@yorisoi-console/protocol/testing';
import { zipSync } from 'fflate';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkProvider, type CheckId, type CheckOptions } from '../src/check.js';
import { serveFiles } from '../src/serve.js';

const now = new Date('2026-10-03T03:00:00.000Z');

let p: TestProvider;
let storage: MemoryStorage;
let files: Map<string, Uint8Array>;
let server: Server;
let base: string;
let store: MemoryStore;

/** The collection the channel uses (API-MATERIALS): one text resource about a spot in Kamakura. */
function collectionJson(change: Record<string, unknown> = {}) {
  return {
    format: 1, id: 'kamakura-audio-guide', version: 2, producer: 'sg1' + 'c'.repeat(32), name: '鎌倉音声ガイド', summary: '寺社の音声ガイド', lang: 'ja',
    grants: { publishers: '*' },
    resources: [{ id: 'intro', type: 'text', file: 'resources/text/intro.md', tags: ['history'], about: { type: 'spot', osm: 'way/1', lat: 35.326, lon: 139.5565 } }],
    ...change,
  };
}

/** Puts the collection package out and lists it, as the console does once it's approved. */
function listCollection(json: Record<string, unknown>, listed: Record<string, unknown> = {}) {
  const zip = zipSync({ 'collection.json': utf8.encode(JSON.stringify(json)), 'resources/text/intro.md': utf8.encode('鶴岡八幡宮の話\n') });
  files.set(`col/${sha256Hex(zip)}.zip`, zip);
  store.collections = [{
    entry: {
      id: 'kamakura-audio-guide', version: 2, producer: 'sg1' + 'c'.repeat(32), producerName: '鎌倉市観光協会', name: '鎌倉音声ガイド', summary: '寺社の音声ガイド',
      media: ['text'], resourcesSize: zip.length, tags: ['history'], regions: ['xn7'], grants: { publishers: '*' },
      package: { url: `${base}/col/${sha256Hex(zip)}.zip`, sha256: sha256Hex(zip), size: zip.length, format: 1 },
      minAppVersions: { sanpoguide: 9999 }, approvedAt: now.toISOString(), ...listed,
    } as never,
  }];
}

const republish = () => publish({ store, storage, cdn: noCdn, signerFor: () => p.signing, config: { rootPublicKey: p.rootKey, name: 'Local' }, now: () => now }, 'manual');

/** Publishes one channel with the publisher of the app, and serves the public site plus the files. */
beforeEach(async () => {
  p = await makeTestProvider({ now });
  storage = new MemoryStorage();
  files = new Map();
  ({ server, url: base } = await serveFiles(async (path) => storage.public.get(path) ?? files.get(path)));

  const pkg = zipSync({ 'channel.json': utf8.encode(JSON.stringify({ format: 1, activities: ['walk'], id: 'kamakura-history', version: 3, collections: [{ as: 'kamakura', id: 'kamakura-audio-guide', minVersion: 2 }] })) });
  const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  files.set(`pkg/${sha256Hex(pkg)}.zip`, pkg);
  files.set(`icons/${sha256Hex(icon)}.png`, icon);
  store = new MemoryStore();
  store.keyset = p.discovery.keyset;
  store.keys.set('k-test', { keyId: 'k-test', kmsKeyArn: 'local', status: 'active' });
  store.channels = [
    {
      entry: sampleChannel({
        package: { url: `${base}/pkg/${sha256Hex(pkg)}.zip`, sha256: sha256Hex(pkg), size: pkg.length, format: 1 },
        icon: { url: `${base}/icons/${sha256Hex(icon)}.png`, sha256: sha256Hex(icon) },
      }),
    },
  ];
  store.channels[0]!.material = { ownPrefetchBytes: 0, ownMedia: [], collections: ['kamakura-audio-guide'] };
  listCollection(collectionJson());
  await republish();
});

afterEach(() => new Promise<void>((done) => server.close(() => done())));

async function statuses(options: Partial<CheckOptions> = {}) {
  const results = await checkProvider(base, { expectedProvider: p.provider, allowLocalHttp: true, now, ...options });
  return Object.fromEntries(results.map((r) => [r.id, r.status])) as Record<CheckId, string>;
}

const failed = (s: Record<CheckId, string>) => Object.entries(s).filter(([, v]) => v === 'fail').map(([k]) => k);

describe('a provider published by this system', () => {
  it('passes every check', async () => {
    const s = await statuses({ minSeq: 1 });
    expect(failed(s)).toEqual([]);
    expect(Object.values(s).every((v) => v === 'pass')).toBe(true);
  });
});

describe('the checks catch a broken provider (API-CHANNEL-LIST)', () => {
  it('V-19: a collection package changed after approval', async () => {
    const [col] = store.collections;
    store.collections = [{ entry: { ...col!.entry, package: { ...col!.entry.package, size: col!.entry.package.size + 1 } } }];
    await republish();
    expect(failed(await statuses())).toEqual(['V-19']);
  });

  it('V-20: a channel using a collection that is not listed, or not granted to it', async () => {
    store.collections = [];
    await republish();
    expect(failed(await statuses())).toEqual(['V-20']);
    listCollection(collectionJson({ grants: { publishers: ['sg1' + 'z'.repeat(32)] } }), { grants: { publishers: ['sg1' + 'z'.repeat(32)] } });
    await republish();
    expect(failed(await statuses())).toEqual(['V-20']);
  });

  it('V-21: media of an unknown kind', async () => {
    listCollection(collectionJson(), { media: ['hologram'] });
    await republish();
    expect(failed(await statuses())).toEqual(['V-21']);
  });

  it('V-25: tags, regions or grants that differ from the package', async () => {
    listCollection(collectionJson(), { tags: ['food'] });
    await republish();
    expect(failed(await statuses())).toEqual(['V-25']);
    listCollection(collectionJson(), { regions: ['xn8'] });
    await republish();
    expect(failed(await statuses())).toEqual(['V-25']);
  });

  it('V-25: the apps a collection is granted to, in any order (API-MATERIALS)', async () => {
    listCollection(collectionJson({ grants: { publishers: '*', apps: ['sanpoguide', 'cycle'] } }), { grants: { publishers: '*', apps: ['cycle', 'sanpoguide'] } });
    await republish();
    expect(failed(await statuses())).toEqual([]);
    listCollection(collectionJson({ grants: { publishers: '*', apps: ['sanpoguide'] } }));
    await republish();
    expect(failed(await statuses())).toEqual(['V-25']);
  });

  it('V-25: whether the AI may take the texts as grounds (API-MATERIALS I-13)', async () => {
    listCollection(collectionJson({ grants: { publishers: '*', grounding: true } }), { grants: { publishers: '*', grounding: true } });
    await republish();
    expect(failed(await statuses())).toEqual([]);
    // A list that drops it would leave the collection unusable in the app.
    listCollection(collectionJson({ grants: { publishers: '*', grounding: true } }));
    await republish();
    expect(failed(await statuses())).toEqual(['V-25']);
  });

  it('V-27: activities, genres or requires that differ from the package (API-CHANNEL-LIST)', async () => {
    store.channels[0]!.entry = { ...store.channels[0]!.entry, activities: ['cycle'] };
    await republish();
    expect(failed(await statuses())).toEqual(['V-27']);
  });

  it('V-29: minAppVersions with a version no app has written badly', async () => {
    listCollection(collectionJson(), { minAppVersions: { sanpoguide: 0 } });
    await republish();
    expect(failed(await statuses())).toEqual(['V-29']);
  });
});

describe('the checks catch a broken provider', () => {
  it('V-01: a provider id given by another route that does not match', async () => {
    const other = await makeTestProvider({ now });
    expect(failed(await statuses({ expectedProvider: other.provider }))).toContain('V-01');
  });

  it('V-03: a list body swapped after signing', async () => {
    const doc = JSON.parse(utf8.decode(storage.public.get(LIST_PATH)!));
    doc.payload = b64url.encode(utf8.encode(JSON.stringify({ ...JSON.parse(utf8.decode(b64url.decode(doc.payload))), channels: [] })));
    storage.public.set(LIST_PATH, utf8.encode(JSON.stringify(doc)));
    expect(failed(await statuses())).toEqual(['V-03']);
  });

  it('V-04: an expired list', async () => {
    expect(failed(await statuses({ now: new Date(now.getTime() + 15 * 24 * 3600_000) }))).toEqual(['V-04']);
  });

  it('V-05: a seq older than one seen before', async () => {
    expect(failed(await statuses({ minSeq: 2 }))).toEqual(['V-05']);
  });

  it('V-07: a package changed after approval', async () => {
    const [path] = [...files.keys()].filter((k) => k.startsWith('pkg/'));
    files.set(path!, utf8.encode('PK… something else'));
    expect(failed(await statuses())).toEqual(['V-07']);
  });

  it('V-08: a package over 2MB', async () => {
    const [path] = [...files.keys()].filter((k) => k.startsWith('pkg/'));
    files.set(path!, new Uint8Array(2 * 1024 * 1024 + 1));
    expect(failed(await statuses())).toEqual(['V-08']);
  });

  it('V-09: plain HTTP outside a local test', async () => {
    expect(failed(await statuses({ allowLocalHttp: false }))).toContain('V-09');
  });
});
