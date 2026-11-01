import { b64url, providerId, sha256Hex, utf8 } from './encoding.js';
import { verifyEd25519 } from './ed25519.js';
import { LIMITS } from './limits.js';
import type { ChannelList, ChannelListDigest, Discovery, Keyset, SignedDocument, SigningKeyEntry } from './types.js';

/** The reasons of API-CHANNEL-LIST's error table, plus `bad_document` for a malformed document. */
export type ErrorCode =
  | 'provider_mismatch'
  | 'unsupported_version'
  | 'bad_signature'
  | 'unknown_key'
  | 'key_not_valid'
  | 'rollback'
  | 'expired'
  | 'too_large'
  | 'hash_mismatch'
  | 'bad_document';

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

const fail = (code: ErrorCode, detail: string): never => {
  throw new ProtocolError(code, detail);
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBytes(text: unknown, what: string): Uint8Array {
  if (typeof text !== 'string') return fail('bad_document', `${what} is not a string`);
  try {
    return b64url.decode(text);
  } catch {
    return fail('bad_document', `${what} is not base64url`);
  }
}

function parseJson(bytes: Uint8Array, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(bytes));
  } catch {
    return fail('bad_document', `${what} is not UTF-8 JSON`);
  }
  return isObject(value) ? value : fail('bad_document', `${what} is not an object`);
}

function signedDocument(value: unknown, what: string): SignedDocument {
  if (!isObject(value) || typeof value.payload !== 'string' || typeof value.keyId !== 'string' || typeof value.sig !== 'string') {
    return fail('bad_document', `${what} is not a signed document`);
  }
  return { payload: value.payload, keyId: value.keyId, sig: value.sig };
}

/** Checks a signature and the payload's `type`, which keeps a document from passing for another kind (P-3). */
function openSigned(
  doc: SignedDocument,
  publicKey: Uint8Array,
  type: string,
  what: string,
): { json: Record<string, unknown>; bytes: Uint8Array } {
  const bytes = decodeBytes(doc.payload, `${what}.payload`);
  if (!verifyEd25519(publicKey, bytes, decodeBytes(doc.sig, `${what}.sig`))) fail('bad_signature', `${what}: signature does not verify`);
  const json = parseJson(bytes, `${what}.payload`);
  if (json.type !== type) fail('bad_signature', `${what}: type is ${String(json.type)}, not ${type}`);
  return { json, bytes };
}

function date(value: unknown, what: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? fail('bad_document', `${what} is not a date`) : ms;
}

export interface VerifiedProvider {
  discovery: Discovery;
  rootKey: Uint8Array;
  keyset: Keyset;
}

/** `/.well-known/sanpo-channels` and its keyset (V-01, V-02). */
export function verifyDiscovery(
  value: unknown,
  options: { expectedProvider?: string; minKeysetSeq?: number } = {},
): VerifiedProvider {
  if (!isObject(value)) return fail('bad_document', 'discovery is not an object');
  const versions = value.versions;
  if (!Array.isArray(versions) || !versions.includes('v1')) fail('unsupported_version', 'versions has no v1');
  if (typeof value.list !== 'string' || typeof value.provider !== 'string' || typeof value.name !== 'string') {
    fail('bad_document', 'discovery lacks provider, name or list');
  }
  const rootKey = decodeBytes(value.rootKey, 'rootKey');
  if (rootKey.length !== 32) fail('bad_document', 'rootKey is not 32 bytes');
  const provider = providerId(rootKey);
  if (provider !== value.provider) fail('provider_mismatch', `rootKey gives ${provider}, discovery says ${String(value.provider)}`);
  if (options.expectedProvider !== undefined && provider !== options.expectedProvider) {
    fail('provider_mismatch', `rootKey gives ${provider}, expected ${options.expectedProvider}`);
  }

  const keysetDoc = signedDocument(value.keyset, 'keyset');
  if (keysetDoc.keyId !== provider) fail('unknown_key', `keyset is signed by ${keysetDoc.keyId}, not the root key`);
  const { json } = openSigned(keysetDoc, rootKey, 'keyset', 'keyset');
  if (json.provider !== provider) fail('provider_mismatch', `keyset is for ${String(json.provider)}`);
  const seq = json.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq)) return fail('bad_document', 'keyset.seq is not an integer');
  if (options.minKeysetSeq !== undefined && seq < options.minKeysetSeq) fail('rollback', `keyset seq ${seq} < ${options.minKeysetSeq}`);
  if (!Array.isArray(json.keys) || !Array.isArray(json.revokedKeys)) fail('bad_document', 'keyset lacks keys or revokedKeys');

  const keys = (json.keys as unknown[]).map((k, i): SigningKeyEntry => {
    if (!isObject(k) || typeof k.keyId !== 'string') return fail('bad_document', `keyset.keys[${i}] is malformed`);
    if (decodeBytes(k.publicKey, `keyset.keys[${i}].publicKey`).length !== 32) {
      fail('bad_document', `keyset.keys[${i}].publicKey is not 32 bytes`);
    }
    const from = date(k.notBefore, `keyset.keys[${i}].notBefore`);
    const to = date(k.notAfter, `keyset.keys[${i}].notAfter`);
    if (to <= from || to - from > LIMITS.signingKeyLifetimeMs) fail('bad_document', `keyset.keys[${i}] is valid for more than a year`);
    return { keyId: k.keyId, publicKey: k.publicKey as string, notBefore: k.notBefore as string, notAfter: k.notAfter as string };
  });
  const keyset: Keyset = {
    type: 'keyset',
    provider,
    seq,
    issuedAt: String(json.issuedAt),
    keys,
    revokedKeys: (json.revokedKeys as unknown[]).map(String),
  };
  return { discovery: value as unknown as Discovery, rootKey, keyset };
}

export interface VerifiedList {
  body: ChannelList;
  digest: ChannelListDigest;
  signingKey: SigningKeyEntry;
  digestPayloadBytes: number;
}

/** The channel list: its digest's signature, the body against the digest, and dates (V-03, V-04, P-6). */
export function verifyChannelList(value: unknown, keyset: Keyset, options: { now?: Date; minSeq?: number } = {}): VerifiedList {
  const now = (options.now ?? new Date()).getTime();
  if (!isObject(value) || typeof value.payload !== 'string') return fail('bad_document', 'list is not a document with a payload');
  const digestDoc = signedDocument(value.digest, 'digest');
  const key = keyset.keys.find((k) => k.keyId === digestDoc.keyId) ?? fail('unknown_key', `${digestDoc.keyId} is not in the keyset`);
  if (keyset.revokedKeys.includes(key.keyId)) fail('key_not_valid', `${key.keyId} is revoked`);

  const opened = openSigned(digestDoc, b64url.decode(key.publicKey), 'channel-list-digest', 'digest');
  const digest = opened.json as unknown as ChannelListDigest;
  const issuedAt = date(digest.issuedAt, 'digest.issuedAt');
  if (issuedAt < Date.parse(key.notBefore) || issuedAt > Date.parse(key.notAfter)) {
    fail('key_not_valid', `${key.keyId} was not valid at ${digest.issuedAt}`);
  }

  const bytes = decodeBytes(value.payload, 'payload');
  if (bytes.length !== digest.size || sha256Hex(bytes) !== digest.sha256) fail('bad_signature', 'body does not match the digest');
  const body = parseJson(bytes, 'payload') as unknown as ChannelList;
  if (body.type !== 'channel-list') fail('bad_signature', `body type is ${String(body.type)}`);
  if (body.format !== 1) fail('unsupported_version', `list format ${String(body.format)}`);
  for (const field of ['provider', 'seq', 'issuedAt', 'expiresAt'] as const) {
    if (body[field] !== digest[field]) fail('bad_signature', `body ${field} differs from the digest`);
  }
  if (body.provider !== keyset.provider) fail('provider_mismatch', `list is for ${body.provider}`);
  for (const field of ['channels', 'revoked', 'collections', 'revokedCollections'] as const) {
    if (!Array.isArray(body[field])) fail('bad_document', `list lacks ${field}`);
  }

  const expiresAt = date(body.expiresAt, 'expiresAt');
  if (expiresAt - issuedAt > LIMITS.listLifetimeMs) fail('expired', 'expiresAt is more than 14 days after issuedAt');
  if (now >= expiresAt) fail('expired', `expired at ${body.expiresAt}`);
  if (options.minSeq !== undefined && body.seq < options.minSeq) fail('rollback', `seq ${body.seq} < ${options.minSeq}`);
  return { body, digest, signingKey: key, digestPayloadBytes: opened.bytes.length };
}
