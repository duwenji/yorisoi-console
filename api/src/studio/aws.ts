import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ulid } from '../console/util.js';
import type { ModelChoice, StudioPorts, StudioSettings } from './studio.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const SETTINGS_SECONDS = 300;
/** The verdict is a few tokens of JSON. */
const CHECK_MAX_TOKENS = 100;

/** A CloudWatch metric in the embedded metric format, one line in the log. */
export function emitMetric(name: string, value: number) {
  console.log(
    JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'YorisoiStudio', Dimensions: [['Env']], Metrics: [{ Name: name, Unit: 'None' }] }] },
      Env: process.env.STUDIO_ENV ?? 'dev',
      [name]: value,
    }),
  );
}

/** What the operator set, checked: a bad value falls back to the deployed default (K-3, K-19). */
export function readStudioSettings(
  raw: { termsVersion?: string; termsUrl?: string; termsUpdatedAt?: string; paused?: string; monthlyBudgetUsd?: string; model?: string },
  defaults: { termsVersion: number; termsUrl: string; monthlyBudgetUsd: number; models: ModelChoice[]; model: string },
  metric: (name: string, value: number) => void,
): StudioSettings {
  const version = Number(raw.termsVersion);
  const versionOk = Number.isInteger(version) && version >= 1;
  const budget = Number(raw.monthlyBudgetUsd);
  const budgetOk = Number.isFinite(budget) && budget > 0;
  const chosen = defaults.models.find((m) => m.id === raw.model);
  metric('InvalidSetting', versionOk && budgetOk && chosen ? 0 : 1);
  return {
    termsVersion: versionOk ? version : defaults.termsVersion,
    termsUrl: raw.termsUrl || defaults.termsUrl,
    termsUpdatedAt: raw.termsUpdatedAt || '',
    paused: raw.paused === 'true',
    monthlyBudgetUsd: budgetOk ? budget : defaults.monthlyBudgetUsd,
    model: chosen ?? defaults.models.find((m) => m.id === defaults.model)!,
  };
}

let cached: StudioPorts | undefined;

/** The ports from the Lambda's environment, made once per container. */
export function awsPorts(): StudioPorts {
  cached ??= build();
  return cached;
}

function build(): StudioPorts {
  const region = env('AWS_REGION');
  const ssm = new SSMClient({ region });
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  const bedrock = new BedrockRuntimeClient({ region });
  const params = {
    termsVersion: env('PARAM_TERMS_VERSION'),
    termsUrl: env('PARAM_TERMS_URL'),
    termsUpdatedAt: env('PARAM_TERMS_UPDATED_AT'),
    paused: env('PARAM_PAUSED'),
    monthlyBudgetUsd: env('PARAM_RELAY_MONTHLY_BUDGET'),
    model: env('PARAM_RELAY_MODEL'),
  };
  const defaults = {
    termsVersion: Number(env('DEFAULT_TERMS_VERSION')),
    termsUrl: env('DEFAULT_TERMS_URL'),
    monthlyBudgetUsd: Number(env('DEFAULT_MONTHLY_BUDGET_USD')),
    models: JSON.parse(env('MODELS')) as ModelChoice[],
    model: env('DEFAULT_MODEL'),
  };

  let settings: { value: StudioSettings; until: number } | undefined;
  return {
    db,
    table: env('TABLE_NAME'),
    relayTable: env('RELAY_TABLE_NAME'),
    now: () => new Date(),
    id: () => ulid(),
    settings: async () => {
      if (settings && settings.until > Date.now()) return settings.value;
      const names = Object.values(params);
      const out = await ssm.send(new GetParametersCommand({ Names: names }));
      const value = (name: string) => out.Parameters?.find((p) => p.Name === name)?.Value;
      const read = readStudioSettings(
        Object.fromEntries(Object.entries(params).map(([key, name]) => [key, value(name)])) as Parameters<typeof readStudioSettings>[0],
        defaults,
        emitMetric,
      );
      settings = { value: read, until: Date.now() + SETTINGS_SECONDS * 1000 };
      return read;
    },
    check: async (model, system, user) => {
      const out = await bedrock.send(
        new ConverseCommand({
          modelId: model.profile,
          system: [{ text: system }],
          messages: [{ role: 'user', content: [{ text: user }] }],
          inferenceConfig: { maxTokens: CHECK_MAX_TOKENS, temperature: 0 },
        }),
      );
      const text = (out.output?.message?.content ?? []).flatMap((block) => (block.text !== undefined ? [block.text] : [])).join('');
      return { text, inputTokens: out.usage?.inputTokens ?? 0, outputTokens: out.usage?.outputTokens ?? 0 };
    },
    audioBase: env('AUDIO_BASE_URL').replace(/\/$/, ''),
    metric: emitMetric,
  };
}
