/** A model the operator may switch to (ADR-AI-RELAY R-5): a Bedrock inference profile in Japan. */
export interface RelayModel {
  id: string;
  profile: string;
  /** The foundation model behind the profile, which the role must also be allowed to call. */
  foundationModel: string;
  /** Bedrock's price for the profile, USD per million tokens, for the month's spend (R-10). */
  price: { inputPerMTok: number; outputPerMTok: number };
}

/** Settings of the operator's AI relay in one account (platform ADR-AI-RELAY, API-AI-RELAY). */
export interface RelayConfig {
  name: 'dev' | 'prod';
  /** Optional: when set, the stack is pinned to this account. */
  account?: string;
  region: 'ap-northeast-1';
  /** The models the operator may switch to in Parameter Store; the role may call only these. */
  models: RelayModel[];
  /** The model the relay starts with, and uses when the parameter names no model in `models`. */
  model: string;
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

/** Claude Haiku on the jp profiles: 4.5 until the account gets a quota for 5.5 (ADR-AI-RELAY T-6). */
const MODELS: RelayModel[] = [
  {
    id: 'haiku-4-5',
    profile: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
    foundationModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    price: { inputPerMTok: 1.1, outputPerMTok: 5.5 },
  },
  {
    id: 'haiku-5-5',
    profile: 'jp.anthropic.claude-haiku-5-5',
    foundationModel: 'anthropic.claude-haiku-5-5',
    price: { inputPerMTok: 0.11, outputPerMTok: 0.55 },
  },
];

export const relayConfigs: Record<RelayConfig['name'], RelayConfig> = {
  dev: {
    name: 'dev',
    region: 'ap-northeast-1',
    models: MODELS,
    model: 'haiku-4-5',
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
    models: MODELS,
    model: 'haiku-4-5',
    packages: ['io.github.duwenji.yorisoi.sanpoguide'],
    integritySecretName: 'yorisoi-ai-relay/prod/play-integrity',
    dailyLimit: 30,
    // Decided before production (ADR-AI-RELAY T-7).
    monthlyBudgetUsd: 20,
    waf: true,
    installKey: 'secret',
  },
};
