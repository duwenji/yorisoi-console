/** Settings of one deployment: the development or the production account (ADR-001 A-2). */
export interface EnvConfig {
  name: 'dev' | 'prod';
  /** Optional: when set, the stack is pinned to this account. */
  account?: string;
  region: 'ap-northeast-1';
  providerName: string;
  /**
   * The root public key (base64url, 32 bytes), pinned so the publisher only puts out what chains to it
   * (ADR-001 A-9). The development provider has its own root key and is never built into the app.
   */
  rootPublicKey: string;
  /** Signing keys in KMS, one per period (ADR-001 A-8: a new key every six months). */
  signingKeyIds: string[];
  reviewPolicyUrl?: string;
  termsUrl?: string;
  /** The discovery document's `contact`: where reports and rights claims go (platform ADR-004 H-11, ADR-002 D-21). */
  contact?: string;
  /** Where alarms go; set it before the first deployment. */
  alarmEmail?: string;
  /**
   * The publishers' emails (ADR-001 A-19): sent with SES from a verified domain, or only recorded
   * (`log`) where there is no sending domain yet (T-7) or SES is still in the sandbox (T-8).
   */
  notify: { mode: 'log' } | { mode: 'ses'; from: string; configurationSet?: string };
  /**
   * By app id (`KNOWN_APPS` in packages/protocol; DES-011 N-4): the version (versionCode) that first
   * shows each app stage of material (API-001 C-21, DES-008 K-6): 0 no material, 1 text and
   * images, 2 audio, 3 video. Changed here, through a pull request, as app versions ship; until
   * then material needs a version no app has.
   */
  appStageVersions: Record<string, Record<number, number>>;
  /** What this environment pays for (see docs/operations/cost.md). Production keeps every protection. */
  cost: {
    /** AWS WAF on the user pool (ADR-001 A-18): about 7 USD a month. */
    waf: boolean;
    /** DynamoDB point-in-time recovery. */
    pointInTimeRecovery: boolean;
    /** Days to keep Lambda logs; undefined keeps them forever. */
    logRetentionDays?: 14;
    /**
     * Where the key of list cursors comes from: a Secrets Manager secret (0.4 USD a month), or a
     * random value made at synthesis and passed in the environment (cursors expire on each deploy).
     */
    cursorKey: 'secret' | 'environment';
    /** A monthly AWS Budgets alert on the costs tagged with this project. */
    budget?: { monthlyUsd: number; email: string };
  };
}

export const configs: Record<EnvConfig['name'], Omit<EnvConfig, 'rootPublicKey'>> = {
  dev: {
    name: 'dev',
    region: 'ap-northeast-1',
    providerName: 'SanpoGuide チャンネル（開発）',
    signingKeyIds: ['k-2026-10'],
    contact: 'duwenji@gmail.com',
    // No sending domain in development: the notices are recorded, not sent.
    notify: { mode: 'log' },
    // SanpoGuide versionCode 1 shows stage 0 and 1 (text and images); audio and video wait.
    // CycleGuide shows no images while riding: text only, from versionCode 1.
    appStageVersions: { sanpoguide: { 0: 1, 1: 1, 2: 9999, 3: 9999 }, cycleguide: { 0: 1, 1: 9999, 2: 9999, 3: 9999 } },
    // Development keeps cost to the minimum.
    cost: {
      waf: false,
      pointInTimeRecovery: false,
      logRetentionDays: 14,
      cursorKey: 'environment',
      budget: { monthlyUsd: 5, email: 'tofumiyoshi@gmail.com' },
    },
  },
  prod: {
    name: 'prod',
    region: 'ap-northeast-1',
    providerName: 'SanpoGuide 公式チャンネル',
    signingKeyIds: ['k-2026-10'],
    contact: 'duwenji@gmail.com',
    // Switch to { mode: 'ses', from: … } once the domain (T-7) and SES production access (T-8) are ready.
    notify: { mode: 'log' },
    // SanpoGuide versionCode 1 shows stage 0 and 1 (text and images); audio and video wait.
    // CycleGuide shows no images while riding: text only, from versionCode 1.
    appStageVersions: { sanpoguide: { 0: 1, 1: 1, 2: 9999, 3: 9999 }, cycleguide: { 0: 1, 1: 9999, 2: 9999, 3: 9999 } },
    cost: { waf: true, pointInTimeRecovery: true, cursorKey: 'secret' },
  },
};
