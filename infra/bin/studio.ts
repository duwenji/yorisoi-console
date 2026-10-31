import { App, Tags } from 'aws-cdk-lib';
import { studioConfigs, type StudioConfig } from '../lib/studio-config.js';
import { StudioStack } from '../lib/studio-stack.js';

// The studio is its own CDK app, deployed after the relay (DES-013 K-2):
// npx cdk -a "npx tsx bin/studio.ts" deploy -c env=dev
const app = new App();
const name = (app.node.tryGetContext('env') ?? 'dev') as StudioConfig['name'];
const base = studioConfigs[name];
if (!base) throw new Error(`unknown env ${name}; use dev or prod`);
const alarmEmail = app.node.tryGetContext('alarmEmail') as string | undefined;
const config: StudioConfig = { ...base, ...(alarmEmail ? { alarmEmail } : {}) };

const stack = new StudioStack(app, `YorisoiStudio-${name}`, {
  config,
  env: { region: config.region, ...(config.account ? { account: config.account } : {}) },
  description: `The studio: notes and placements (${name})`,
});

Tags.of(stack).add('project', 'yorisoi-studio');
Tags.of(stack).add('environment', name);
