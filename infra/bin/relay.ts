import { App, Tags } from 'aws-cdk-lib';
import { relayConfigs, type RelayConfig } from '../lib/relay-config.js';
import { RelayStack } from '../lib/relay-stack.js';

// The relay is its own CDK app, so it deploys without the console's builds and keys:
// npx cdk -a "npx tsx bin/relay.ts" deploy -c env=dev
const app = new App();
const name = (app.node.tryGetContext('env') ?? 'dev') as RelayConfig['name'];
const base = relayConfigs[name];
if (!base) throw new Error(`unknown env ${name}; use dev or prod`);
const alarmEmail = app.node.tryGetContext('alarmEmail') as string | undefined;
const config: RelayConfig = { ...base, ...(alarmEmail ? { alarmEmail } : {}) };

const stack = new RelayStack(app, `YorisoiAiRelay-${name}`, {
  config,
  env: { region: config.region, ...(config.account ? { account: config.account } : {}) },
  description: `The operator's AI relay (${name})`,
});

Tags.of(stack).add('project', 'yorisoi-ai-relay');
Tags.of(stack).add('environment', name);
