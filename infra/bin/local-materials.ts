import { App, Tags } from 'aws-cdk-lib';
import { localMaterialsConfigs, type LocalMaterialsConfig } from '../lib/local-materials-config.js';
import { LocalMaterialsStack } from '../lib/local-materials-stack.js';

// The studio is its own CDK app, deployed after the relay (DES-013 K-2):
// npx cdk -a "npx tsx bin/local-materials.ts" deploy -c env=dev
const app = new App();
const name = (app.node.tryGetContext('env') ?? 'dev') as LocalMaterialsConfig['name'];
const base = localMaterialsConfigs[name];
if (!base) throw new Error(`unknown env ${name}; use dev or prod`);
const alarmEmail = app.node.tryGetContext('alarmEmail') as string | undefined;
const config: LocalMaterialsConfig = { ...base, ...(alarmEmail ? { alarmEmail } : {}) };

const stack = new LocalMaterialsStack(app, `YorisoiLocalMaterials-${name}`, {
  config,
  env: { region: config.region, ...(config.account ? { account: config.account } : {}) },
  description: `The studio: notes and studios (${name})`,
});

Tags.of(stack).add('project', 'yorisoi-studio');
Tags.of(stack).add('environment', name);
