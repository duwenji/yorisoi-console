import { randomBytes } from 'node:crypto';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PlayIntegrity, type ServiceAccount } from './integrity.js';
import { MAX_OUTPUT_TOKENS, type ModelReply, type RelayPorts, type Settings } from './relay.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

/** The daily limit the operator may set (ADR-AI-RELAY R-14), and what is used otherwise. */
export const LIMIT_RANGE = { min: 5, max: 100, fallback: 30 } as const;
const SETTINGS_SECONDS = 300;

/** Checks the operator's values; a bad one is replaced and reported (R-14). */
export function readSettings(raw: { dailyLimit?: string; monthlyBudgetUsd?: string }, defaultBudgetUsd: number, metric: (name: string, value: number) => void): Settings {
  const limit = Number(raw.dailyLimit);
  const limitOk = Number.isInteger(limit) && limit >= LIMIT_RANGE.min && limit <= LIMIT_RANGE.max;
  const budget = Number(raw.monthlyBudgetUsd);
  const budgetOk = Number.isFinite(budget) && budget > 0;
  metric('InvalidSetting', limitOk && budgetOk ? 0 : 1);
  return { dailyLimit: limitOk ? limit : LIMIT_RANGE.fallback, monthlyBudgetUsd: budgetOk ? budget : defaultBudgetUsd };
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
  const bedrock = new AnthropicBedrock({ awsRegion: region });
  const model = env('MODEL_ID');
  const limitParam = env('PARAM_DAILY_LIMIT');
  const budgetParam = env('PARAM_MONTHLY_BUDGET');
  const defaultBudgetUsd = Number(env('DEFAULT_MONTHLY_BUDGET_USD'));

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
      const out = await ssm.send(new GetParametersCommand({ Names: [limitParam, budgetParam] }));
      const value = (name: string) => out.Parameters?.find((p) => p.Name === name)?.Value;
      const read = readSettings({ dailyLimit: value(limitParam), monthlyBudgetUsd: value(budgetParam) }, defaultBudgetUsd, emitMetric);
      settings = { value: read, until: Date.now() + SETTINGS_SECONDS * 1000 };
      return read;
    },
    ...(integrity ? { verifyIntegrity: (token, expect) => integrity.verify(token, expect) } : {}),
    generate: async (system, user): Promise<ModelReply> => {
      const message = await bedrock.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // A short narration on the move: no thinking, so the output tokens are the words spoken.
        thinking: { type: 'disabled' },
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
        .trim();
      const stop = message.stop_reason === 'refusal' ? 'refusal' : message.stop_reason === 'max_tokens' ? 'max_tokens' : 'end';
      return { text, stop, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
    },
    price: { inputPerMTok: Number(env('PRICE_INPUT_PER_MTOK')), outputPerMTok: Number(env('PRICE_OUTPUT_PER_MTOK')) },
    metric: emitMetric,
  };
}
