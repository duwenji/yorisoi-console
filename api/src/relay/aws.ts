import { randomBytes } from 'node:crypto';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PlayIntegrity, type ServiceAccount } from './integrity.js';
import { MAX_OUTPUT_TOKENS, type ModelChoice, type ModelReply, type RelayPorts, type Settings } from './relay.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

/** The daily limit the operator may set (API-AI-RELAY R-14), and what is used otherwise. */
export const LIMIT_RANGE = { min: 5, max: 100, fallback: 30 } as const;
const SETTINGS_SECONDS = 300;

/** What a bad value falls back to: the configured budget, and the configured models and default. */
export interface SettingDefaults {
  monthlyBudgetUsd: number;
  models: ModelChoice[];
  model: string;
}

/** Checks the operator's values; a bad one is replaced and reported (R-5, R-14). */
export function readSettings(
  raw: { dailyLimit?: string; monthlyBudgetUsd?: string; model?: string },
  defaults: SettingDefaults,
  metric: (name: string, value: number) => void,
): Settings {
  const limit = Number(raw.dailyLimit);
  const limitOk = Number.isInteger(limit) && limit >= LIMIT_RANGE.min && limit <= LIMIT_RANGE.max;
  const budget = Number(raw.monthlyBudgetUsd);
  const budgetOk = Number.isFinite(budget) && budget > 0;
  const chosen = defaults.models.find((m) => m.id === raw.model);
  metric('InvalidSetting', limitOk && budgetOk && chosen ? 0 : 1);
  return {
    dailyLimit: limitOk ? limit : LIMIT_RANGE.fallback,
    monthlyBudgetUsd: budgetOk ? budget : defaults.monthlyBudgetUsd,
    model: chosen ?? defaults.models.find((m) => m.id === defaults.model)!,
  };
}

/** A CloudWatch metric in the embedded metric format, one line in the log. */
export function emitMetric(name: string, value: number) {
  console.log(
    JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'YorisoiAiRelay', Dimensions: [['Env']], Metrics: [{ Name: name, Unit: 'None' }] }] },
      Env: process.env.RELAY_ENV ?? 'dev',
      [name]: value,
    }),
  );
}

async function secret(client: SecretsManagerClient, id: string): Promise<string> {
  const out = await client.send(new GetSecretValueCommand({ SecretId: id }));
  if (!out.SecretString) throw new Error(`secret ${id} is empty`);
  return out.SecretString;
}

let cached: Promise<RelayPorts> | undefined;

/** The ports from the Lambda's environment, made once per container. */
export function awsPorts(): Promise<RelayPorts> {
  cached ??= build();
  return cached;
}

async function build(): Promise<RelayPorts> {
  const region = env('AWS_REGION');
  const secrets = new SecretsManagerClient({ region });
  const ssm = new SSMClient({ region });
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  const installKey = process.env.INSTALL_KEY ?? (await secret(secrets, env('INSTALL_KEY_SECRET_ARN')));
  const integrity = process.env.INTEGRITY_SECRET_ID ? new PlayIntegrity(JSON.parse(await secret(secrets, process.env.INTEGRITY_SECRET_ID)) as ServiceAccount) : undefined;
  const bedrock = new BedrockRuntimeClient({ region });
  const limitParam = env('PARAM_DAILY_LIMIT');
  const budgetParam = env('PARAM_MONTHLY_BUDGET');
  const modelParam = env('PARAM_MODEL');
  const defaults: SettingDefaults = {
    monthlyBudgetUsd: Number(env('DEFAULT_MONTHLY_BUDGET_USD')),
    models: JSON.parse(env('MODELS')) as ModelChoice[],
    model: env('DEFAULT_MODEL'),
  };

  let settings: { value: Settings; until: number } | undefined;
  return {
    db,
    table: env('TABLE_NAME'),
    now: () => new Date(),
    random: (bytes) => randomBytes(bytes).toString('base64url'),
    installKey,
    packages: env('PACKAGES').split(','),
    settings: async () => {
      if (settings && settings.until > Date.now()) return settings.value;
      const out = await ssm.send(new GetParametersCommand({ Names: [limitParam, budgetParam, modelParam] }));
      const value = (name: string) => out.Parameters?.find((p) => p.Name === name)?.Value;
      const read = readSettings({ dailyLimit: value(limitParam), monthlyBudgetUsd: value(budgetParam), model: value(modelParam) }, defaults, emitMetric);
      settings = { value: read, until: Date.now() + SETTINGS_SECONDS * 1000 };
      return read;
    },
    ...(integrity ? { verifyIntegrity: (token, expect) => integrity.verify(token, expect) } : {}),
    // Converse speaks to every model on the list the same way (R-5); thinking stays off, its default.
    generate: async (model, system, user): Promise<ModelReply> => {
      const out = await bedrock.send(
        new ConverseCommand({
          modelId: model.profile,
          system: [{ text: system }],
          messages: [{ role: 'user', content: [{ text: user }] }],
          inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS },
        }),
      );
      const text = (out.output?.message?.content ?? [])
        .flatMap((block) => (block.text !== undefined ? [block.text] : []))
        .join('')
        .trim();
      const reason = out.stopReason;
      const stop =
        reason === 'max_tokens' || reason === 'model_context_window_exceeded'
          ? 'max_tokens'
          : reason === 'content_filtered' || reason === 'guardrail_intervened'
            ? 'refusal'
            : 'end';
      return { text, stop, inputTokens: out.usage?.inputTokens ?? 0, outputTokens: out.usage?.outputTokens ?? 0 };
    },
    metric: emitMetric,
  };
}
