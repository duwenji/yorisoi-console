import {
  ACCOUNT_ID,
  CHANNEL_ID,
  LIMITS,
  ProtocolError,
  geohash,
  sha256Hex,
  utf8,
  verifyChannelList,
  verifyDiscovery,
  type ChannelList,
  type CollectionEntry,
  type Keyset,
} from '@yorisoi-console/protocol';
import { unzipSync } from 'fflate';

/** The checks of API-CHANNEL-LIST 「確認観点」 that a provider is responsible for. */
export type CheckId = 'V-01' | 'V-02' | 'V-03' | 'V-04' | 'V-05' | 'V-06' | 'V-07' | 'V-08' | 'V-09' | 'V-15' | 'V-16' | 'V-19' | 'V-20' | 'V-21' | 'V-25' | 'V-27' | 'V-29';

export interface CheckResult {
  id: CheckId;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface CheckOptions {
  /** The provider id obtained by another route (API-CHANNEL-LIST: never taken from the URL). */
  expectedProvider?: string;
  /** The seq seen last time, to catch a rollback (V-05). */
  minSeq?: number;
  /** Allow `http://localhost` and `http://127.0.0.1`, as the app's debug build does. */
  allowLocalHttp?: boolean;
  now?: Date;
  fetch?: typeof fetch;
}

const TITLES: Record<CheckId, string> = {
  'V-01': 'rootKey gives the provider id',
  'V-02': 'keyset is signed by the root key',
  'V-03': 'list digest is signed by a valid signing key and matches the body',
  'V-04': 'list expires within 14 days and has not expired',
  'V-05': 'seq has not gone back',
  'V-06': 'channel ids are unique and well-formed',
  'V-07': 'packages and icons match their SHA-256 and size',
  'V-08': 'size limits are kept',
  'V-09': 'every URL is HTTPS',
  'V-15': 'digest is small enough for KMS to sign',
  'V-16': 'publisher changes are well-formed',
  'V-19': 'collection ids are unique and well-formed, and their packages match',
  'V-20': 'collections a channel declares are listed, new enough and granted to its publisher',
  'V-21': 'media and resourcesSize are well-formed',
  'V-25': 'collections’ tags, regions and grants match their packages',
  'V-27': 'channels’ activities, genres and requires match their packages (API-CHANNEL-LIST)',
  'V-29': 'minAppVersions name app ids with positive versions (API-CHANNEL-LIST)',
};

const MEDIA = new Set(['text', 'image', 'audio', 'video']);

/** Grants as written and as listed: the same publishers and apps, in any order (API-MATERIALS I-11). */
function sameGrants(a: unknown, b: { publishers: '*' | string[]; apps?: string[]; grounding?: boolean }): boolean {
  if (typeof a !== 'object' || a === null) return false;
  const g = a as { publishers?: unknown; apps?: unknown; grounding?: unknown };
  const publishersMatch = g.publishers === '*' || b.publishers === '*'
    ? g.publishers === b.publishers
    : Array.isArray(g.publishers) && sameList(g.publishers as string[], b.publishers);
  const appsMatch = g.apps === undefined || b.apps === undefined ? g.apps === b.apps : Array.isArray(g.apps) && sameList(g.apps as string[], b.apps);
  // Absent is false on both sides (API-MATERIALS I-13).
  const groundingMatch = (g.grounding === true) === (b.grounding === true);
  return publishersMatch && appsMatch && groundingMatch;
}

/** A JSON file inside a package, or undefined when the package isn't a ZIP or lacks it. */
function jsonIn(zip: Uint8Array, name: string): Record<string, unknown> | undefined {
  try {
    const file = unzipSync(zip, { filter: (f) => f.name === name })[name];
    return file ? (JSON.parse(utf8.decode(file)) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const sameList = (a: unknown[], b: unknown[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export const title = (id: CheckId) => TITLES[id];

class TooLarge extends Error {}

/** Fetches at most [limit] bytes; a larger response is cut off, as the app does (API-CHANNEL-LIST `too_large`). */
async function fetchLimited(fetchImpl: typeof fetch, url: string, limit: number): Promise<Uint8Array> {
  const res = await fetchImpl(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new TooLarge(`${url}: more than ${limit} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function urlProblem(url: string, allowLocalHttp: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} is not a URL`;
  }
  if (parsed.protocol === 'https:') return null;
  if (allowLocalHttp && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) return null;
  return `${url} is not HTTPS`;
}

/** Runs every check against the provider at [baseUrl]; never throws for a failing provider. */
export async function checkProvider(baseUrl: string, options: CheckOptions = {}): Promise<CheckResult[]> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? new Date();
  const results = new Map<CheckId, CheckResult>();
  const set = (id: CheckId, status: CheckResult['status'], detail = '') => {
    if (results.get(id)?.status !== 'fail') results.set(id, { id, status, detail });
  };
  const failWith = (id: CheckId, e: unknown) => set(id, 'fail', e instanceof Error ? e.message : String(e));
  const base = baseUrl.replace(/\/+$/, '');
  const urls: string[] = [];

  // V-01, V-02: discovery and keyset.
  let keyset: Keyset | undefined;
  let listPath = '/v1/channels.json';
  try {
    const discoveryUrl = `${base}/.well-known/sanpo-channels`;
    urls.push(discoveryUrl);
    const discovery: unknown = JSON.parse(utf8.decode(await fetchLimited(fetchImpl, discoveryUrl, LIMITS.listBytes)));
    try {
      const verified = verifyDiscovery(discovery, options.expectedProvider ? { expectedProvider: options.expectedProvider } : {});
      keyset = verified.keyset;
      listPath = verified.discovery.list;
      set('V-01', 'pass', verified.keyset.provider);
      set('V-02', 'pass', `keyset seq ${verified.keyset.seq}, keys ${verified.keyset.keys.map((k) => k.keyId).join(', ')}`);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : '';
      failWith(code === 'provider_mismatch' ? 'V-01' : 'V-02', e);
    }
  } catch (e) {
    failWith(e instanceof TooLarge ? 'V-08' : 'V-01', e);
  }

  // V-03 to V-06, V-15, V-16: the list.
  let list: ChannelList | undefined;
  if (keyset) {
    const listUrl = new URL(listPath, `${base}/`).toString();
    urls.push(listUrl);
    try {
      const doc: unknown = JSON.parse(utf8.decode(await fetchLimited(fetchImpl, listUrl, LIMITS.listBytes)));
      try {
        const verified = verifyChannelList(doc, keyset, { now, ...(options.minSeq !== undefined ? { minSeq: options.minSeq } : {}) });
        list = verified.body;
        set('V-03', 'pass', `seq ${list.seq}, signed by ${verified.signingKey.keyId}`);
        set('V-04', 'pass', `expires ${list.expiresAt}`);
        set('V-05', options.minSeq === undefined ? 'skip' : 'pass', options.minSeq === undefined ? 'no previous seq given' : `seq ${list.seq}`);
        set('V-15', verified.digestPayloadBytes < LIMITS.digestPayloadBytes ? 'pass' : 'fail', `${verified.digestPayloadBytes} bytes`);
      } catch (e) {
        const code = e instanceof ProtocolError ? e.code : '';
        failWith(code === 'expired' ? 'V-04' : code === 'rollback' ? 'V-05' : 'V-03', e);
      }
    } catch (e) {
      failWith(e instanceof TooLarge ? 'V-08' : 'V-03', e);
    }
  }

  if (list) {
    const ids = list.channels.map((c) => c.id);
    const badId = ids.find((id) => !CHANNEL_ID.test(id));
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (badId || duplicate) set('V-06', 'fail', badId ? `bad id ${badId}` : `duplicate id ${duplicate}`);
    else set('V-06', 'pass', `${ids.length} channels`);

    const changes = list.channels.filter((c) => c.publisherChange);
    const badChange = changes.find((c) => !ACCOUNT_ID.test(c.publisherChange!.from) || c.publisherChange!.from === c.publisher);
    if (badChange) set('V-16', 'fail', `${badChange.id}: publisherChange.from is malformed or equals publisher`);
    else set('V-16', 'pass', `${changes.length} changes`);

    // V-07, V-08: every package and icon. The packages are kept for V-20.
    const channelPackages = new Map<string, Uint8Array>();
    for (const channel of list.channels) {
      for (const [what, file, limit] of [
        ['package', channel.package, LIMITS.packageBytes],
        ['icon', channel.icon, LIMITS.iconBytes],
      ] as const) {
        urls.push(file.url);
        if (urlProblem(file.url, options.allowLocalHttp ?? false)) continue;
        try {
          const bytes = await fetchLimited(fetchImpl, file.url, limit);
          const sizeOk = what === 'icon' || bytes.length === (file as { size: number }).size;
          if (sha256Hex(bytes) !== file.sha256 || !sizeOk) set('V-07', 'fail', `${channel.id} ${what}: SHA-256 or size differs`);
          else set('V-07', 'pass', 'all files match');
          if (what === 'package') channelPackages.set(channel.id, bytes);
        } catch (e) {
          failWith(e instanceof TooLarge ? 'V-08' : 'V-07', new Error(`${channel.id} ${what}: ${e instanceof Error ? e.message : e}`));
        }
      }
    }
    if (list.channels.length === 0) set('V-07', 'skip', 'no channels');
    set('V-08', 'pass', 'list ≤ 1MB, packages ≤ 2MB, icons ≤ 100KB');

    // API-CHANNEL-LIST (V-19, V-20, V-21, V-25): collections. A list without collections has none.
    const collections: CollectionEntry[] = list.collections ?? [];
    const colIds = collections.map((c) => c.id);
    const badCol = colIds.find((id) => !CHANNEL_ID.test(id));
    const dupCol = colIds.find((id, i) => colIds.indexOf(id) !== i);
    if (badCol || dupCol) set('V-19', 'fail', badCol ? `bad collection id ${badCol}` : `duplicate collection id ${dupCol}`);
    const collectionPackages = new Map<string, Uint8Array>();
    for (const col of collections) {
      urls.push(col.package.url);
      if (urlProblem(col.package.url, options.allowLocalHttp ?? false)) continue;
      try {
        const bytes = await fetchLimited(fetchImpl, col.package.url, LIMITS.packageBytes);
        if (sha256Hex(bytes) !== col.package.sha256 || bytes.length !== col.package.size) set('V-19', 'fail', `${col.id}: SHA-256 or size differs`);
        else collectionPackages.set(col.id, bytes);
      } catch (e) {
        failWith(e instanceof TooLarge ? 'V-08' : 'V-19', new Error(`${col.id}: ${e instanceof Error ? e.message : e}`));
      }
    }
    set('V-19', 'pass', `${collections.length} collections`);

    // V-20: what each channel declares (channel.json `collections`) is on this list, new enough, and granted.
    const byId = new Map(collections.map((c) => [c.id, c]));
    for (const [channelId, bytes] of channelPackages) {
      const channel = list.channels.find((c) => c.id === channelId)!;
      const declared = (jsonIn(bytes, 'channel.json')?.collections as { id: string; minVersion: number }[] | undefined) ?? [];
      const ids = [channel.publisher, ...(channel.publisherChange ? [channel.publisherChange.from] : [])];
      for (const use of declared) {
        const col = byId.get(use.id);
        const grants = col?.grants.publishers;
        if (!col) set('V-20', 'fail', `${channelId}: ${use.id} is not listed`);
        else if (col.version < use.minVersion) set('V-20', 'fail', `${channelId}: ${use.id}@${col.version} is older than ${use.minVersion}`);
        else if (grants !== '*' && !ids.some((id) => grants?.includes(id))) set('V-20', 'fail', `${channelId}: ${use.id} is not granted to ${channel.publisher}`);
      }
    }
    set('V-20', 'pass', `${channelPackages.size} channels`);

    // V-21: the forms only; the values need the outside resources' sizes, which the list doesn't give (DES-009 M-10).
    for (const entry of [...list.channels, ...collections] as { id: string; media?: string[]; resourcesSize?: number }[]) {
      if (entry.media !== undefined && !entry.media.every((m) => MEDIA.has(m))) set('V-21', 'fail', `${entry.id}: media ${entry.media.join(',')}`);
      if (entry.resourcesSize !== undefined && !(Number.isInteger(entry.resourcesSize) && entry.resourcesSize >= 0)) set('V-21', 'fail', `${entry.id}: resourcesSize ${entry.resourcesSize}`);
    }
    set('V-21', 'pass', 'media and resourcesSize are well-formed');

    // V-25: tags, regions and grants are what the package says.
    for (const [id, bytes] of collectionPackages) {
      const col = byId.get(id)!;
      const manifest = jsonIn(bytes, 'collection.json');
      if (!manifest) { set('V-25', 'fail', `${id}: no collection.json`); continue; }
      const resources = (manifest.resources as { tags?: string[]; about?: { lat?: number; lon?: number } }[] | undefined) ?? [];
      const tags = [...new Set(resources.flatMap((r) => r.tags ?? []))];
      const regions = [...new Set(resources.flatMap((r) => (r.about?.lat !== undefined && r.about?.lon !== undefined ? [geohash(r.about.lat, r.about.lon)] : [])))];
      if (!sameList(tags, col.tags)) set('V-25', 'fail', `${id}: tags ${col.tags.join(',')} but the package has ${tags.join(',')}`);
      if (!sameList(regions, col.regions ?? [])) set('V-25', 'fail', `${id}: regions ${(col.regions ?? []).join(',')} but the package has ${regions.join(',')}`);
      if (!sameGrants(manifest.grants, col.grants)) set('V-25', 'fail', `${id}: grants differ from the package`);
    }
    set('V-25', 'pass', `${collectionPackages.size} collections`);

    // V-27 (API-CHANNEL-LIST P-19): what the list copies for the apps to choose by is what the package says.
    for (const [id, bytes] of channelPackages) {
      const entry = list.channels.find((c) => c.id === id)!;
      // A package that isn't the one listed is V-07's to report.
      if (sha256Hex(bytes) !== entry.package.sha256) continue;
      const manifest = jsonIn(bytes, 'channel.json');
      if (!manifest) { set('V-27', 'fail', `${id}: no channel.json`); continue; }
      const format = manifest.format as number | undefined;
      const written = {
        activities: (manifest.activities as string[] | undefined) ?? [],
        genres: (manifest.genres as string[] | undefined) ?? [],
        requires: (manifest.requires as { features?: string[] } | undefined)?.features ?? [],
      };
      const listed = { activities: entry.activities, genres: entry.genres, requires: entry.requires };
      for (const field of ['activities', 'genres', 'requires'] as const) {
        if (!sameList(written[field], listed[field])) set('V-27', 'fail', `${id}: ${field} ${listed[field].join(',')} but the package has ${written[field].join(',')}`);
      }
      if (entry.package.format !== format) set('V-27', 'fail', `${id}: package.format ${entry.package.format} but the package is format ${String(format)}`);
    }
    set('V-27', channelPackages.size ? 'pass' : 'skip', `${channelPackages.size} channels`);

    // V-29 (P-20): app id → a positive whole number, for channels and collections alike.
    const versioned = [...list.channels, ...collections].filter((e) => e.minAppVersions !== undefined);
    const badVersions = versioned.find((e) => Object.entries(e.minAppVersions!).some(([app, v]) => !CHANNEL_ID.test(app) || !Number.isInteger(v) || v < 1));
    if (badVersions) set('V-29', 'fail', `${badVersions.id}: minAppVersions ${JSON.stringify(badVersions.minAppVersions)}`);
    else set('V-29', 'pass', `${versioned.length} entries with minAppVersions`);
  }

  // V-09: every URL, including those of documents that failed.
  const insecure = urls.map((u) => urlProblem(u, options.allowLocalHttp ?? false)).find((p) => p !== null);
  set('V-09', insecure ? 'fail' : 'pass', insecure ?? `${urls.length} URLs`);

  const order = Object.keys(TITLES) as CheckId[];
  return order.map((id) => results.get(id) ?? { id, status: 'skip', detail: 'not reached' });
}
