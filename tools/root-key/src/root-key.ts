import {
  LIMITS,
  b64url,
  generateEd25519,
  localSigner,
  privateKeyFromPem,
  providerId,
  rawPublicKey,
  signDocument,
  verifyDiscovery,
  type Keyset,
  type SignedDocument,
  type SigningKeyEntry,
} from '@yorisoi-console/protocol';
import { createPublicKey } from 'node:crypto';

/** The passphrase guards the root key at rest; the machine is offline, but files get copied. */
export const MIN_PASSPHRASE = 16;

export interface RootKeyFiles {
  /** PKCS#8 PEM, encrypted with the passphrase. */
  privatePem: string;
  publicKey: string;
  provider: string;
}

export function generateRootKey(passphrase: string): RootKeyFiles {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const { privateKey, publicKey } = generateEd25519();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }).toString();
  return { privatePem, publicKey: b64url.encode(publicKey), provider: providerId(publicKey) };
}

export function openRootKey(privatePem: string, passphrase: string) {
  const privateKey = privateKeyFromPem(privatePem, passphrase);
  const publicKey = rawPublicKey(createPublicKey(privateKey));
  const provider = providerId(publicKey);
  return { provider, publicKey, signer: localSigner(provider, privateKey) };
}

/** What the operator writes: the parts of a keyset that aren't derived from the root key. */
export interface KeysetInput {
  seq: number;
  keys: SigningKeyEntry[];
  revokedKeys?: string[];
}

/** Checks the keyset against API-CHANNEL-LIST before signing, so a mistake never gets the root key's signature. */
export function buildKeyset(input: KeysetInput, provider: string, now: Date): Keyset {
  if (!Number.isInteger(input.seq) || input.seq < 1) throw new Error('seq must be a positive integer');
  if (!Array.isArray(input.keys) || input.keys.length === 0) throw new Error('a keyset needs at least one key');
  const revokedKeys = input.revokedKeys ?? [];
  const ids = new Set<string>();
  for (const key of input.keys) {
    if (!/^k-[0-9]{4}-[0-9]{2}$|^k-[a-z0-9-]{1,40}$/.test(key.keyId)) throw new Error(`bad keyId ${key.keyId}`);
    if (ids.has(key.keyId)) throw new Error(`keyId ${key.keyId} appears twice`);
    ids.add(key.keyId);
    if (b64url.decode(key.publicKey).length !== 32) throw new Error(`${key.keyId}: publicKey is not a 32-byte Ed25519 key`);
    const from = Date.parse(key.notBefore);
    const to = Date.parse(key.notAfter);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) throw new Error(`${key.keyId}: bad validity`);
    if (to - from > LIMITS.signingKeyLifetimeMs) throw new Error(`${key.keyId}: valid for more than a year`);
    if (revokedKeys.includes(key.keyId)) throw new Error(`${key.keyId} is both listed and revoked`);
  }
  return {
    type: 'keyset',
    provider,
    seq: input.seq,
    issuedAt: now.toISOString(),
    keys: input.keys.map(({ keyId, publicKey, notBefore, notAfter }) => ({ keyId, publicKey, notBefore, notAfter })),
    revokedKeys,
  };
}

export async function signKeyset(input: KeysetInput, privatePem: string, passphrase: string, now = new Date()): Promise<SignedDocument> {
  const root = openRootKey(privatePem, passphrase);
  const keyset = buildKeyset(input, root.provider, now);
  const signed = await signDocument(keyset, root.signer);
  // Check the result the way the app will.
  verifyKeyset(signed, b64url.encode(root.publicKey));
  return signed;
}

/** Verifies a signed keyset against a root public key, as the app does through the discovery document. */
export function verifyKeyset(signed: SignedDocument, rootPublicKey: string, expectedProvider?: string): Keyset {
  const provider = providerId(b64url.decode(rootPublicKey));
  return verifyDiscovery(
    { provider, name: '-', versions: ['v1'], list: '/v1/channels.json', rootKey: rootPublicKey, keyset: signed },
    expectedProvider ? { expectedProvider } : {},
  ).keyset;
}
