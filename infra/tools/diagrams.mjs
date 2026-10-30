// Draws docs/diagrams/*.png from the three CDK apps with cdk-dia (needs Graphviz's dot on PATH):
//   npm run diagrams -w infra
// Each stack gets two pictures: <name>.png keeps the parts worth reading, labelled in Japanese,
// and <name>-all.png is cdk-dia's own drawing with every resource.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const infraDir = fileURLToPath(new URL('../', import.meta.url));
const outDir = fileURLToPath(new URL('../../docs/diagrams/', import.meta.url));
const workDir = join(tmpdir(), 'yorisoi-console-diagrams');

// The console needs a root public key to synth; any 32 bytes draw the same picture.
const dummyRootKey = 'A'.repeat(43);

// Parts left out of <name>.png, matched against the icon file and the construct path.
const hiddenIcons = [/Cloudwatch_Logs/, /Identity-and-Access-Management/, /Amazon-CloudWatch_64/, /AWS-Budgets/, /AWS-CloudFormation/, /security_group/];
const hiddenPaths = [/^Custom__CDKBucketDeployment/, /^BucketNotificationsHandler/, /\/DeployWeb\//, /\/(OperatorGroup|PublisherGroup|LoginBranding|ConsoleHeaders|SpaRoutes)$/];

const stacks = [
  {
    name: 'console',
    app: 'npx tsx bin/app.ts',
    context: { rootPublicKey: dummyRootKey },
    title: 'チャンネル管理システム（YorisoiConsole）',
    clusters: { Console: '管理の面（ログインが要る）' },
    labels: {
      Table: '申請・審査・公開の状態',
      PublicBucket: '公開用（リスト・パッケージ）',
      RecordsBucket: '記録用（公開の履歴・見本）',
      PublicDistribution: '公開の面（アプリが読む）',
      'SigningKey-*': '署名鍵（Ed25519）',
      PublishFunction: '公開の Lambda',
      DailyPublish: '毎日 03:00 に公開し直す',
      OperatorAlarms: '運営への警報（メール）',
      'Console/UserPool': 'ログイン・MFA\n運営と提供者のグループ',
      'Console/PostConfirmation': '登録した人を提供者に',
      'Console/IntakeBucket': '受付用（申請のパッケージ）',
      'Console/WebBucket': '画面（SPA）のファイル',
      'Console/ConsoleApi': '管理 API の Lambda',
      'Console/HttpApi': '管理 API（JWT の確認）',
      'Console/ConsoleDistribution': '画面と /api/* の入口',
      'Console/MachineReview': '機械審査の Lambda',
      'Console/NotifyQueue': '提供者への知らせ',
      'Console/NotifyDeadLetters': '送れなかった知らせ',
      'Console/Notify': '知らせをメールする',
    },
  },
  {
    name: 'relay',
    app: 'npx tsx bin/relay.ts',
    context: {},
    title: '運営による AI の中継（YorisoiAiRelay）',
    clusters: {},
    labels: {
      Table: '回数・nonce・トークン',
      DailyLimit: '1 日の上限（運営が変える）',
      MonthlyBudget: '月の予算（運営が変える）',
      Model: '使うモデル（運営が変える）',
      Relay: '中継の Lambda\n（Bedrock を呼ぶ）',
      Api: '中継の API（アプリが呼ぶ）',
      Alarms: '運営への警報（メール）',
    },
  },
  {
    name: 'tiles',
    app: 'npx tsx bin/tiles.ts',
    context: {},
    title: 'スポットのタイル配信（YorisoiSpotTiles）',
    clusters: {},
    labels: {
      Tiles: 'タイルの置き場',
      Cdn: 'タイルの配信（アプリが読む）',
      Vpc: 'バッチの網（外向きだけ）',
      Cluster: 'バッチを動かす ECS',
      Batch: 'タイルを作るバッチ\n（Fargate）',
      Weekly: '毎週バッチを動かす',
      Alarms: '運営への警報（メール）',
      BatchFailed: 'バッチの失敗を拾う',
    },
  },
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

function labelFor(labels, rel) {
  if (labels[rel]) return labels[rel];
  const wildcard = Object.keys(labels).find((k) => k.endsWith('*') && rel.startsWith(k.slice(0, -1)));
  return wildcard ? labels[wildcard] : undefined;
}

// cdk-dia writes one statement per block: `"id" [` ... `];`, edges as `"a" -> "b" [` ... `];`.
function simplify(dot, stack, stackId, iconDir) {
  const lines = dot.split(/\r?\n/);
  const hidden = new Set();
  // First pass: find the nodes to leave out.
  for (let i = 0; i < lines.length; i++) {
    const node = lines[i].match(/^\s*"([^"]+)" \[$/);
    if (!node) continue;
    const rel = node[1].slice(stackId.length + 1);
    let image = '';
    for (let j = i + 1; !/^\s*\];$/.test(lines[j]); j++) if (/image = /.test(lines[j])) image = lines[j];
    if (hiddenIcons.some((r) => r.test(image)) || hiddenPaths.some((r) => r.test(rel))) hidden.add(node[1]);
  }

  const out = [];
  const seenPairs = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const edge = line.match(/^(\s*)"([^"]+)" -> "([^"]+)" \[$/);
    const node = line.match(/^(\s*)"([^"]+)" \[$/);
    if (edge || node) {
      let end = i;
      while (!/^\s*\];$/.test(lines[end])) end++;
      const block = lines.slice(i, end + 1);
      i = end;
      if (edge) {
        const [, indent, a, b] = edge;
        const pair = [a, b].sort().join('\n');
        if (hidden.has(a) || hidden.has(b) || a === b || seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        out.push(`${indent}"${a}" -> "${b}" [`, `${indent}  dir = "none";`, `${indent}];`);
        continue;
      }
      const [, indent, id] = node;
      if (hidden.has(id)) continue;
      const rel = id.slice(stackId.length + 1);
      const short = rel.split('/').pop();
      const ja = labelFor(stack.labels, rel);
      const label = ja ? `${short}\\n${ja.replace(/\n/g, '\\n')}` : short;
      const extraLines = ja ? ja.split('\n').length : 0;
      const body = block.slice(1, -1).filter((l) => !/^\s*(label|height) = /.test(l));
      // Schedules have no icon in cdk-dia; give them EventBridge's.
      if (!body.some((l) => /image = /.test(l))) {
        const icon = join(iconDir, 'Arch_App-Integration', 'Arch_64', 'Arch_Amazon-EventBridge_64@5x.png');
        body.push(`${indent}  image = "${icon}";`, `${indent}  imagescale = "true";`, `${indent}  imagepos = "tc";`, `${indent}  penwidth = 0;`, `${indent}  shape = "node";`, `${indent}  fixedsize = "true";`, `${indent}  labelloc = "b";`, `${indent}  width = 2;`);
      }
      out.push(block[0], `${indent}  label = "${label}";`, `${indent}  height = ${(2.266 + 0.22 * extraLines).toFixed(3)};`, ...body, block.at(-1));
      continue;
    }
    // Cluster titles: the stack and its constructs.
    const cluster = line.match(/^(\s*)label = "([^"]+)";$/);
    if (cluster && cluster[2] === stackId) out.push(`${cluster[1]}label = "${stack.title}";`);
    else if (cluster && stack.clusters[cluster[2]]) out.push(`${cluster[1]}label = "${stack.clusters[cluster[2]]}";`);
    else out.push(line);
  }
  return out.join('\n');
}

// <name>.png reads left to right: the way in on the left, what the app reads on the right.
function render(dot, dpi, target, rankdir) {
  const source = `${target}.dot`;
  let text = dot.replace(/fontname = "Sans-Serif"/g, 'fontname = "Meiryo"').replace(/dpi = \d+;/, `dpi = ${dpi};`);
  if (rankdir) text = text.replace(/rankdir = "\w+";/, `rankdir = "${rankdir}";`);
  writeFileSync(source, text);
  run('dot', ['-Tpng', '-o', target, source]);
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const cdk = fileURLToPath(new URL('../../node_modules/aws-cdk/bin/cdk', import.meta.url));
const cdkDia = fileURLToPath(new URL('../../node_modules/cdk-dia/dist/bin/cli.js', import.meta.url));
const iconDir = fileURLToPath(new URL('../../node_modules/cdk-dia/icons/aws/Service/', import.meta.url));

for (const stack of stacks) {
  const cdkOut = join(workDir, stack.name);
  const context = Object.entries({ env: 'dev', ...stack.context }).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
  run('node', [cdk, 'synth', '--quiet', '-a', stack.app, '-o', cdkOut, ...context], infraDir);
  // cdk-dia joins its paths to the working directory, so they stay relative.
  run('node', [cdkDia, '--tree', `${stack.name}/tree.json`, '--target', `${stack.name}-cdk-dia.png`], workDir);
  const dot = readFileSync(join(workDir, `${stack.name}-cdk-dia.dot`), 'utf8');
  const stackId = dot.match(/subgraph "([^"]+)" \{/)[1];
  render(dot, 90, join(workDir, `${stack.name}-all.png`));
  render(simplify(dot, stack, stackId, iconDir), 110, join(workDir, `${stack.name}.png`), 'LR');
  for (const file of [`${stack.name}.png`, `${stack.name}-all.png`]) copyFileSync(join(workDir, file), join(outDir, file));
  console.log(`drew ${stack.name}.png and ${stack.name}-all.png`);
}
