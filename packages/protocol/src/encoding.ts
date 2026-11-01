import { createHash } from 'node:crypto';

/** base64url without padding (API-CHANNEL-LIST 「共通の決まり」). */
export const b64url = {
  encode: (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url'),
  /** Rejects anything that isn't strict base64url, rather than decoding it loosely. */
  decode: (text: string): Uint8Array => {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
    return new Uint8Array(Buffer.from(text, 'base64url'));
  },
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const utf8 = {
  encode: (text: string): Uint8Array => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
};

/** An id that is also a key fingerprint: prefix + base32(SHA-256(public key)), first 32 characters. */
function fingerprintId(prefix: string, publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return prefix + base32(sha256(publicKey)).slice(0, 32);
}

/** Provider id from the root public key (API-CHANNEL-LIST P-2). */
export const providerId = (rootPublicKey: Uint8Array): string => fingerprintId('sc1', rootPublicKey);

/** Publisher account id from the publisher's public key (API-001, API-CHANNEL-PACKAGE F-6). */
export const accountId = (publicKey: Uint8Array): string => fingerprintId('sg1', publicKey);

export const PROVIDER_ID = /^sc1[a-z2-7]{32}$/;
export const ACCOUNT_ID = /^sg1[a-z2-7]{32}$/;
