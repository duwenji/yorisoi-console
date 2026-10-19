import { createSign } from 'node:crypto';

/**
 * Play Integrity for the relay (platform API-AI-RELAY AR-3): the app's Standard request token,
 * decoded by Google with the operator's service account, and the verdicts the relay needs.
 */

/** The decoded payload (`tokenPayloadExternal`), as far as the relay reads it. */
export interface IntegrityPayload {
  requestDetails?: { requestPackageName?: string; requestHash?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
}

const MAX_AGE_MS = 5 * 60 * 1000;

/** Why the verdict doesn't pass, or undefined when it does. */
export function checkVerdict(payload: IntegrityPayload, expect: { packageName: string; requestHash: string; now: Date }): string | undefined {
  const request = payload.requestDetails;
  if (request?.requestPackageName !== expect.packageName) return 'package';
  if (request.requestHash !== expect.requestHash) return 'request_hash';
  const age = expect.now.getTime() - Number(request.timestampMillis);
  if (!Number.isFinite(age) || age < -MAX_AGE_MS || age > MAX_AGE_MS) return 'stale';
  if (payload.appIntegrity?.packageName !== expect.packageName) return 'app_package';
  if (payload.appIntegrity.appRecognitionVerdict !== 'PLAY_RECOGNIZED') return 'app';
  if (!payload.deviceIntegrity?.deviceRecognitionVerdict?.includes('MEETS_DEVICE_INTEGRITY')) return 'device';
  return undefined;
}

/** A Google Cloud service account key (the JSON file), as kept in Secrets Manager. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/playintegrity';

/** Decodes tokens with Google's API, signing in as the service account (OAuth 2.0 JWT bearer). */
export class PlayIntegrity {
  private access?: { token: string; until: number };

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.access && this.access.until > now + 60_000) return this.access.token;
    const tokenUri = this.account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(now / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: this.account.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key, 'base64url');
    const res = await this.fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    if (!res.ok) throw new Error(`Google sign-in failed: ${res.status}`);
    const out = (await res.json()) as { access_token: string; expires_in: number };
    this.access = { token: out.access_token, until: now + out.expires_in * 1000 };
    return out.access_token;
  }

  /** The verdict, or why it doesn't pass; a token Google can't decode doesn't pass. */
  async verify(token: string, expect: { packageName: string; requestHash: string; now: Date }): Promise<string | undefined> {
    const res = await this.fetchFn(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(expect.packageName)}:decodeIntegrityToken`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ integrity_token: token }),
    });
    if (res.status === 400) return 'undecodable';
    if (!res.ok) throw new Error(`Play Integrity failed: ${res.status}`);
    const out = (await res.json()) as { tokenPayloadExternal?: IntegrityPayload };
    return checkVerdict(out.tokenPayloadExternal ?? {}, expect);
  }
}
