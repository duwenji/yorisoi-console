import { App, Tags } from 'aws-cdk-lib';
import { tilesConfigs, type TilesConfig } from '../lib/tiles-config.js';
import { TilesStack } from '../lib/tiles-stack.js';

// The spot tiles are their own CDK app, so they deploy without the console's builds and keys:
// npx cdk -a "npx tsx bin/tiles.ts" deploy -c env=dev
const app = new App();
const name = (app.node.tryGetContext('env') ?? 'dev') as TilesConfig['name'];
const base = tilesConfigs[name];
if (!base) throw new Error(`unknown env ${name}; use dev or prod`);
const alarmEmail = app.node.tryGetContext('alarmEmail') as string | undefined;
const config: TilesConfig = { ...base, ...(alarmEmail ? { alarmEmail } : {}) };

const stack = new TilesStack(app, `YorisoiSpotTiles-${name}`, {
  config,
  env: { region: config.region, ...(config.account ? { account: config.account } : {}) },
  description: `The operator's spot tiles (${name})`,
});

Tags.of(stack).add('project', 'yorisoi-spot-tiles');
Tags.of(stack).add('environment', name);
