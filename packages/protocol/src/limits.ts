/** Limits of API-CHANNEL-LIST (and the KMS limit behind P-8). */
export const LIMITS = {
  listBytes: 1024 * 1024,
  packageBytes: 2 * 1024 * 1024,
  iconBytes: 100 * 1024,
  /** AWS KMS signs at most 4,096 bytes; the digest must stay below (V-15). */
  digestPayloadBytes: 4096,
  listLifetimeMs: 14 * 24 * 60 * 60 * 1000,
  signingKeyLifetimeMs: 366 * 24 * 60 * 60 * 1000,
  ticketLifetimeMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export const CHANNEL_ID = /^[a-z0-9-]{3,40}$/;
