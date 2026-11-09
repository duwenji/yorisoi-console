import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * A draft as the console keeps it (DES-014 R-3): one ZIP with the package's files under
 * `package/`, the submission's other inputs in `draft.json`, and the channel's `icon.png`.
 * The manifest stays a plain JSON object, so fields the screens don't edit are kept (R-11).
 */

export type Kind = 'channel' | 'collection';
export type Json = Record<string, unknown>;

/** What a submission takes besides the package (API-001 `SubmissionInput`). */
export interface Listing {
  description?: string;
  tags?: string[];
  regions?: string[];
  note?: string;
}

export interface Draft {
  kind: Kind;
  manifest: Json;
  /** The package's other files, by their path in the package (prompts/…, resources/…). */
  files: Record<string, Uint8Array>;
  listing: Listing;
  icon?: Uint8Array;
}

export const MANIFEST: Record<Kind, string> = { channel: 'channel.json', collection: 'collection.json' };
const PACKAGE = 'package/';

const text = (value: unknown) => strToU8(`${JSON.stringify(value, null, 2)}\n`);

function readJson(bytes: Uint8Array | undefined, name: string): Json {
  if (!bytes) throw new Error(`${name} がありません`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${name} が UTF-8 の JSON として読めません`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} が JSON のオブジェクトではありません`);
  return value as Json;
}

function unzip(zip: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(zip);
  } catch {
    throw new Error('ZIP として読めません');
  }
}

/** The draft as the console stores it. */
export function packDraft(d: Draft): Uint8Array {
  const entries: Record<string, Uint8Array> = { [PACKAGE + MANIFEST[d.kind]]: text(d.manifest), 'draft.json': text(d.listing) };
  for (const [path, bytes] of Object.entries(d.files)) entries[PACKAGE + path] = bytes;
  if (d.icon) entries['icon.png'] = d.icon;
  return zipSync(entries, { level: 6 });
}

export function unpackDraft(zip: Uint8Array, kind: Kind): Draft {
  const entries = unzip(zip);
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.startsWith(PACKAGE) || name.endsWith('/')) continue;
    const path = name.slice(PACKAGE.length);
    if (path !== MANIFEST[kind] && path !== 'signature.json') files[path] = bytes;
  }
  const listing = entries['draft.json'] ? (readJson(entries['draft.json'], 'draft.json') as Listing) : {};
  return { kind, manifest: readJson(entries[PACKAGE + MANIFEST[kind]], MANIFEST[kind]), files, listing, ...(entries['icon.png'] ? { icon: entries['icon.png'] } : {}) };
}

/** A draft from a package (a past submission or a local ZIP): its signature is dropped (R-2). */
export function fromPackage(zip: Uint8Array, kind: Kind, extra: { listing?: Listing; icon?: Uint8Array } = {}): Draft {
  const entries = unzip(zip);
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/') || name === 'signature.json' || name === MANIFEST[kind]) continue;
    files[name] = bytes;
  }
  return { kind, manifest: readJson(entries[MANIFEST[kind]], MANIFEST[kind]), files, listing: extra.listing ?? {}, ...(extra.icon ? { icon: extra.icon } : {}) };
}

/** The package to sign, export or show the AI: the manifest and the files, unsigned. */
export function packageZip(d: Draft): Uint8Array {
  return zipSync({ [MANIFEST[d.kind]]: text(d.manifest), ...d.files }, { level: 6 });
}

/** A new channel with every required field (platform API-CHANNEL-PACKAGE `channel.json`). */
export function blankChannel(id: string, publisher: string, version: number): Draft {
  return {
    kind: 'channel',
    manifest: {
      format: 1, id, version, publisher, name: '', summary: '', lang: 'ja', activities: ['walk'], genres: [], greeting: '',
      talk: { level: 'normal', events: { spot: true, revisit: true, milestone: true, rest: true, start: true, finish: true, preview: true, chat: true, song: true } },
      spots: { prefer: [], skip: [] }, guide: { length: 'normal' }, mood: { tone: true, sound: 'auto' },
    },
    files: {},
    listing: {},
  };
}

/** A new collection (platform API-MATERIALS「素材集の形式」). */
export function blankCollection(id: string, producer: string, version: number): Draft {
  return {
    kind: 'collection',
    manifest: { format: 1, id, version, producer, name: '', summary: '', lang: 'ja', grants: { publishers: '*' }, resources: [] },
    files: {},
    listing: {},
  };
}

// ---- reading and changing ----

export const fileText = (d: Draft, path: string): string => (d.files[path] ? strFromU8(d.files[path]!) : '');

/** Sets a text file; an empty one is removed (an empty slot takes the standard text). */
export function withFileText(d: Draft, path: string, value: string): Draft {
  const files = { ...d.files };
  if (value === '') delete files[path];
  else files[path] = strToU8(value);
  return { ...d, files };
}

export function withFile(d: Draft, path: string, bytes: Uint8Array | undefined): Draft {
  const files = { ...d.files };
  if (bytes) files[path] = bytes;
  else delete files[path];
  return { ...d, files };
}

/** The value at [path] in [obj], or undefined. */
export function getIn(obj: unknown, path: (string | number)[]): unknown {
  let at: unknown = obj;
  for (const key of path) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
}

/** A copy of [obj] with [value] at [path]; `undefined` removes the field. Missing objects are made. */
export function setIn<T>(obj: T, path: (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [key, ...rest] = path;
  const base = (typeof obj === 'object' && obj !== null ? obj : typeof key === 'number' ? [] : {}) as Record<string | number, unknown> | unknown[];
  const copy = (Array.isArray(base) ? [...base] : { ...base }) as Record<string | number, unknown>;
  const next = setIn(copy[key!], rest, value);
  if (next === undefined && !Array.isArray(copy)) delete copy[key!];
  else copy[key!] = next;
  return copy as T;
}

export const withManifest = (d: Draft, path: (string | number)[], value: unknown): Draft => ({ ...d, manifest: setIn(d.manifest, path, value) });

export type Resource = Json & { id: string; type: string };
export const resourcesOf = (d: Draft): Resource[] => (Array.isArray(d.manifest.resources) ? (d.manifest.resources as Resource[]) : []);
export const cuesOf = (d: Draft): Json[] => (Array.isArray(d.manifest.cues) ? (d.manifest.cues as Json[]) : []);
export const collectionsOf = (d: Draft): Json[] => (Array.isArray(d.manifest.collections) ? (d.manifest.collections as Json[]) : []);

/** Replaces the resources; files no resource points at any more go with them. */
export function withResources(d: Draft, resources: Resource[]): Draft {
  const used = new Set(resources.map((r) => r.file).filter((f): f is string => typeof f === 'string'));
  const files = Object.fromEntries(Object.entries(d.files).filter(([path]) => !path.startsWith('resources/') || used.has(path)));
  return { ...d, files, manifest: { ...d.manifest, resources } };
}

/** A copy of [d] with [field] as a list, removed when empty and the format allows leaving it out. */
export function withList(d: Draft, field: string, list: unknown[]): Draft {
  const manifest = { ...d.manifest };
  if (list.length === 0 && field !== 'resources') delete manifest[field];
  else manifest[field] = list;
  return { ...d, manifest };
}
