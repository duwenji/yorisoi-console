/** Settings of the operator's AI relay in one account (platform ADR-AI-RELAY, API-AI-RELAY). */
export interface RelayConfig {
  name: 'dev' | 'prod';
  /** Optional: when set, the stack is pinned to this account. */
  account?: string;
  region: 'ap-northeast-1';
  /** The Bedrock inference profile (ADR-AI-RELAY R-5) and its foundation model. */
  modelId: string;
  foundationModel: string;
  /** USD per million tokens of the profile, for the month's spend (R-10). */
  price: { inputPerMTok: number; outputPerMTok: number };
  /** Apps that may open a session. */
  packages: string[];
  /**
   * The Secrets Manager secret with the Google service account (JSON) that decodes Play Integrity
   * tokens. Absent on the development relay, which doesn't check them (API-AI-RELAY AR-4).
   */
  integritySecretName?: string;
  /** The first value of the daily limit (5–100; the operator changes it in Parameter Store, R-14). */
  dailyLimit: number;
  /** The first value of the month's budget in USD (T-7), and the one used when the parameter is bad. */
  monthlyBudgetUsd: number;
  /** AWS WAF on the API, limiting requests per source address (R-9 ③; about 7 USD a month). */
  waf: boolean;
  /** Where the key for install hashes comes from: a secret, or a value made at synthesis (AR-2). */
  installKey: 'secret' | 'environment';
  /** Where alarms go. */
  alarmEmail?: string;
}

const HAIKU_5_5_JP = {
  modelId: 'jp.anthropic.claude-haiku-5-5',
  foundationModel: 'anthropic.claude-haiku-5-5',
  // Bedrock's price for the jp profile (ADR-AI-RELAY 注意点).
  price: { inputPerMTok: 0.11, outputPerMTok: 0.55 },
} as const;

export const relayConfigs: Record<RelayConfig['name'], RelayConfig> = {
  dev: {
    name: 'dev',
    region: 'ap-northeast-1',
    ...HAIKU_5_5_JP,
    packages: ['io.github.duwenji.yorisoi.sanpoguide'],
    dailyLimit: 30,
    monthlyBudgetUsd: 5,
    // Development keeps cost to the minimum: no WAF, and a key that changes with each deploy.
    waf: false,
    installKey: 'environment',
    alarmEmail: 'tofumiyoshi@gmail.com',
  },
  prod: {
    name: 'prod',
    region: 'ap-northeast-1',
    ...HAIKU_5_5_JP,
    packages: ['io.github.duwenji.yorisoi.sanpoguide'],
    integritySecretName: 'yorisoi-ai-relay/prod/play-integrity',
    dailyLimit: 30,
    // Decided before production (ADR-AI-RELAY T-7).
    monthlyBudgetUsd: 20,
    waf: true,
    installKey: 'secret',
  },
};
