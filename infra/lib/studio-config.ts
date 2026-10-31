import { MODELS, relayConfigs, type RelayModel } from './relay-config.js';

/** Settings of the studio in one account (platform API-STUDIO, console DES-013). */
export interface StudioConfig {
  name: 'dev' | 'prod';
  /** Optional: when set, the stack is pinned to this account. */
  account?: string;
  region: 'ap-northeast-1';
  /** The relay's models: the studio checks notes with the one the relay's parameter names (K-3). */
  models: RelayModel[];
  /** The model used when the relay's parameter names none of `models`. */
  model: string;
  /** The month's budget used when the relay's parameter is bad. */
  monthlyBudgetUsd: number;
  /** The first version and address of the note terms (K-19; the operator changes them in Parameter Store). */
  termsVersion: number;
  termsUrl: string;
  /** AWS WAF on the API, limiting requests per source address. */
  waf: boolean;
  /** Keep the table and the served audio when the stack is deleted. */
  retainData: boolean;
  /** Where alarms go. */
  alarmEmail?: string;
}

const TERMS_URL = 'https://github.com/duwenji/yorisoi-platform/blob/main/docs/policies/studio-note-terms.md';

export const studioConfigs: Record<StudioConfig['name'], StudioConfig> = {
  dev: {
    name: 'dev',
    region: 'ap-northeast-1',
    models: MODELS,
    model: relayConfigs.dev.model,
    monthlyBudgetUsd: relayConfigs.dev.monthlyBudgetUsd,
    termsVersion: 1,
    termsUrl: TERMS_URL,
    // Development keeps cost to the minimum, and starts over when it's torn down.
    waf: false,
    retainData: false,
    alarmEmail: 'tofumiyoshi@gmail.com',
  },
  prod: {
    name: 'prod',
    region: 'ap-northeast-1',
    models: MODELS,
    model: relayConfigs.prod.model,
    monthlyBudgetUsd: relayConfigs.prod.monthlyBudgetUsd,
    termsVersion: 1,
    termsUrl: TERMS_URL,
    waf: true,
    retainData: true,
  },
};
