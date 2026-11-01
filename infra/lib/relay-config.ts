/**
 * A model the operator may switch to (API-AI-RELAY R-5), processed in Japan: a model Bedrock runs
 * in Tokyo itself, or a jp inference profile (Tokyo and Osaka).
 */
export interface RelayModel {
  id: string;
  /** What the relay passes as `modelId`: the model in Tokyo, or the jp inference profile. */
  profile: string;
  /** The foundation model, which the role must also be allowed to call behind a profile. */
  foundationModel: string;
  inferenceProfile: boolean;
  /** Bedrock's price in Tokyo (or for the jp profile), USD per million tokens, for the month's spend (R-10). */
  price: { inputPerMTok: number; outputPerMTok: number };
}

/** Settings of the operator's AI relay in one account (platform API-AI-RELAY). */
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

/** DeepSeek V3.2 in Tokyo for now, and Claude Haiku 4.5 to switch to (API-AI-RELAY R-5). */
export const MODELS: RelayModel[] = [
  {
    id: 'deepseek-v3-2',
    profile: 'deepseek.v3.2',
    foundationModel: 'deepseek.v3.2',
    inferenceProfile: false,
    price: { inputPerMTok: 0.74, outputPerMTok: 2.22 },
  },
  {
    id: 'haiku-4-5',
    profile: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
    foundationModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    inferenceProfile: true,
    price: { inputPerMTok: 1.1, outputPerMTok: 5.5 },
  },
];

export const relayConfigs: Record<RelayConfig['name'], RelayConfig> = {
  dev: {
    name: 'dev',
    region: 'ap-northeast-1',
    models: MODELS,
    model: 'deepseek-v3-2',
    packages: ['io.github.duwenji.yorisoi.sanpoguide', 'io.github.duwenji.yorisoi.cycleguide'],
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
    model: 'deepseek-v3-2',
    packages: ['io.github.duwenji.yorisoi.sanpoguide', 'io.github.duwenji.yorisoi.cycleguide'],
    integritySecretName: 'yorisoi-ai-relay/prod/play-integrity',
    dailyLimit: 30,
    // Decided before production (API-AI-RELAY 未決事項 No.2).
    monthlyBudgetUsd: 20,
    waf: true,
    installKey: 'secret',
  },
};
