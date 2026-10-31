// Draws docs/diagrams/*.png from the four CDK apps with cdk-dia (needs Graphviz's dot on PATH):
//   npm run diagrams -w infra
// Each stack gets two pictures: <name>.png keeps the parts worth reading, labelled in Japanese, with
// arrows from what uses to what is used and the people and services outside the stack; <name>-all.png
// is cdk-dia's own drawing with every resource.
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

// Where a part stands, by its icon: the ways in, what runs, and what is used. Arrows point from the
// first towards the last; a schedule has no icon and counts as a way in.
const entryIcons = /CloudFront|API-Gateway|EventBridge/;
const computeIcons = /AWS-Lambda|Elastic-Container-Service/;
const rankOf = (image) => (!image || entryIcons.test(image) ? 1 : computeIcons.test(image) ? 2 : 3);

const legend =
  '矢印: 矢元が矢先を使う（呼ぶ・読み書きする・見張る）　破線: このスタックの外（利用者・ほかのサービス）\\l' +
  'CDK のコードから cdk-dia で生成。ロググループ・IAM のロール・警報などは省いている\\l';

const stacks = [
  {
    name: 'console',
    app: 'npx tsx bin/app.ts',
    context: { rootPublicKey: dummyRootKey },
    title: 'チャンネル管理システム（YorisoiConsole）',
    clusters: { Console: '管理の面（ログインが要る）' },
    outside: [
      { label: '運営・提供者\n（ブラウザ）', to: ['Console/ConsoleDistribution', 'Console/IntakeBucket'] },
      { label: 'アプリ\n（散策者の端末）', to: ['PublicDistribution'] },
      { label: 'Amazon SES\n（メールを送る）', from: ['Console/Notify'] },
      { label: '運営のメール', from: ['OperatorAlarms'] },
    ],
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
    outside: [
      { label: 'アプリ\n（散策者の端末）', to: ['Api'] },
      { label: 'Amazon Bedrock\n（語りを作る）', from: ['Relay'] },
      { label: 'Google Play Integrity\n（本物のアプリか）', from: ['Relay'] },
      { label: '運営のメール', from: ['Alarms'] },
    ],
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
    name: 'studio',
    app: 'npx tsx bin/studio.ts',
    context: {},
    title: 'スタジオ（YorisoiStudio）',
    clusters: {},
    outside: [
      { label: 'アプリ\n（散策者・走る人の端末）', to: ['Api', 'AudioCdn'] },
      { label: '提供者\n（管理システムの画面から音声を送る）', to: ['Intake'] },
      { label: 'チャンネル管理システム\n（掲載・運営の対応）', to: ['PlacementCheck', 'Table'] },
      { label: '運営の AI の中継\n（トークン・予算・モデル）', from: ['Studio', 'PlacementCheck'] },
      { label: 'Amazon Bedrock\n（一言と掲載の確認）', from: ['Studio', 'PlacementCheck'] },
      { label: 'Amazon Transcribe\n（音声を文字に）', from: ['PlacementCheck'] },
      { label: '運営のメール', from: ['Alarms'] },
    ],
    labels: {
      Table: '一言・掲載・数・ブロック・締め出し',
      Intake: '受け取り用（音声・書き起こし）',
      Audio: '配信用（確かめた音声）',
      AudioCdn: '音声の配信（アプリが読む）',
      Api: 'スタジオの API（アプリが呼ぶ）',
      Studio: 'スタジオの Lambda\n（一言の確認を含む）',
      PlacementCheck: '掲載の確認の Lambda',
      TranscribeDone: '書き起こしの終わりを拾う',
      TermsVersion: '一言の利用規約の版（運営が変える）',
      TermsUrl: '一言の利用規約の URL',
      TermsUpdatedAt: '利用規約を変えた日',
      Paused: 'スタジオを止める（運営が変える）',
      ApiWaf: '送信元ごとの回数の制限（本番）',
      Alarms: '運営への警報（メール）',
      TableNameParameter: '表の名前（管理システムが読む）',
      IntakeBucketParameter: '受け取り用の名前（管理システムが読む）',
      AudioBucketParameter: '配信用の名前（管理システムが読む）',
      CheckFunctionParameter: '確認の Lambda の名前（管理システムが読む）',
    },
  },
  {
    name: 'tiles',
    app: 'npx tsx bin/tiles.ts',
    context: {},
    title: 'スポットのタイル配信（YorisoiSpotTiles）',
    clusters: {},
    outside: [
      { label: 'アプリ\n（散策者の端末）', to: ['Cdn'] },
      { label: 'Geofabrik\n（OSM の日本の抽出）', from: ['Batch'] },
      { label: '運営のメール', from: ['Alarms'] },
    ],
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

const dotLabel = (text) => text.replace(/\n/g, '\\n');

// The arrow between two parts that refer to each other in CloudFormation (`refs` holds "a\nb" when a
// refers to b). What runs points at what it refers to; otherwise the way in points at what it reaches,
// so that a key or bucket policy naming a Lambda still reads "the Lambda uses the key".
function arrow(a, b, refs, ranks) {
  const ab = refs.has(`${a}\n${b}`);
  const ba = refs.has(`${b}\n${a}`);
  if (ab !== ba) {
    const [from, to] = ab ? [a, b] : [b, a];
    if (ranks.get(from) === 2 || ranks.get(from) === ranks.get(to)) return [from, to];
  }
  if (ranks.get(a) !== ranks.get(b)) return ranks.get(a) < ranks.get(b) ? [a, b] : [b, a];
  return [a, b];
}

// cdk-dia writes one statement per block: `"id" [` ... `];`, edges as `"a" -> "b" [` ... `];`.
function simplify(dot, stack, stackId, iconDir) {
  const lines = dot.split(/\r?\n/);
  const hidden = new Set();
  const ranks = new Map();
  const refs = new Set();
  // First pass: find the nodes to leave out, where the others stand, and who refers to whom.
  for (let i = 0; i < lines.length; i++) {
    const edge = lines[i].match(/^\s*"([^"]+)" -> "([^"]+)" \[$/);
    if (edge) refs.add(`${edge[1]}\n${edge[2]}`);
    const node = lines[i].match(/^\s*"([^"]+)" \[$/);
    if (!node) continue;
    const rel = node[1].slice(stackId.length + 1);
    let image = '';
    for (let j = i + 1; !/^\s*\];$/.test(lines[j]); j++) if (/image = /.test(lines[j])) image = lines[j];
    if (hiddenIcons.some((r) => r.test(image)) || hiddenPaths.some((r) => r.test(rel))) hidden.add(node[1]);
    else ranks.set(node[1], rankOf(image));
  }

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const block = line.match(/^(\s*)"([^"]+)"( -> "[^"]+")? \[$/);
    if (block) {
      let end = i;
      while (!/^\s*\];$/.test(lines[end])) end++;
      const body = lines.slice(i + 1, end);
      i = end;
      const [, indent, id, isEdge] = block;
      if (isEdge || hidden.has(id)) continue;
      const rel = id.slice(stackId.length + 1);
      const ja = labelFor(stack.labels, rel);
      const label = rel.split('/').pop() + (ja ? `\\n${dotLabel(ja)}` : '');
      // One size for every icon: cdk-dia draws some smaller, with the label far below.
      let image = body.find((l) => /image = /.test(l));
      // Schedules have no icon in cdk-dia; give them EventBridge's.
      image ??= `${indent}  image = "${join(iconDir, 'Arch_App-Integration', 'Arch_64', 'Arch_Amazon-EventBridge_64@5x.png')}";`;
      // The small resource icons blur when drawn large.
      const width = /Res_/.test(image) ? 1.4 : 1.6;
      const height = width + 0.3 + 0.2 * (ja ? ja.split('\n').length : 0);
      out.push(
        line,
        `${indent}  label = "${label}";`,
        image,
        `${indent}  fontsize = 12;`,
        `${indent}  imagescale = "true";`,
        `${indent}  imagepos = "tc";`,
        `${indent}  labelloc = "b";`,
        `${indent}  penwidth = 0;`,
        `${indent}  shape = "box";`,
        `${indent}  fixedsize = "true";`,
        `${indent}  width = ${width};`,
        `${indent}  height = ${height.toFixed(2)};`,
        lines[end],
      );
      continue;
    }
    // Cluster titles: the stack and its constructs.
    const cluster = line.match(/^(\s*)label = "([^"]+)";$/);
    if (cluster && cluster[2] === stackId) out.push(`${cluster[1]}label = "${stack.title}";`);
    else if (cluster && stack.clusters[cluster[2]]) out.push(`${cluster[1]}label = "${stack.clusters[cluster[2]]}";`);
    else out.push(line);
  }

  // The arrows, one per pair of parts, and the people and services outside the stack.
  const added = [];
  const seenPairs = new Set();
  for (const pair of refs) {
    const [a, b] = pair.split('\n');
    const key = [a, b].sort().join('\n');
    if (hidden.has(a) || hidden.has(b) || a === b || seenPairs.has(key)) continue;
    seenPairs.add(key);
    const [from, to] = arrow(a, b, refs, ranks);
    added.push(`  "${from}" -> "${to}" [ arrowhead = "normal"; arrowsize = 0.8; ];`);
  }
  const outsideStyle = 'shape = "box"; style = "rounded,dashed"; color = "#5A6B85"; fontcolor = "#1B2621"; fontsize = 12; margin = "0.15,0.08"; fixedsize = "false"; width = 0; height = 0;';
  // Who comes in stands at the left edge; where things go out, at the right.
  stack.outside.forEach((o, n) => {
    const id = `outside/${n}`;
    added.push(`  { rank = "${o.to ? 'min' : 'max'}"; "${id}" [ label = "${dotLabel(o.label)}"; ${outsideStyle} ]; }`);
    for (const t of o.to ?? []) added.push(`  "${id}" -> "${stackId}/${t}" [ style = "dashed"; color = "#5A6B85"; arrowhead = "normal"; arrowsize = 0.8; ];`);
    for (const f of o.from ?? []) added.push(`  "${stackId}/${f}" -> "${id}" [ style = "dashed"; color = "#5A6B85"; arrowhead = "normal"; arrowsize = 0.8; ];`);
  });
  const close = out.lastIndexOf('}');
  out.splice(close, 0, ...added);
  // The legend under the picture.
  const open = out.findIndex((l) => l.startsWith('digraph'));
  out.splice(open + 1, 0, `  label = "${legend}";`, '  labelloc = "b";', '  labeljust = "l";', '  fontsize = 13;');
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
  render(simplify(dot, stack, stackId, iconDir), 150, join(workDir, `${stack.name}.png`), 'LR');
  for (const file of [`${stack.name}.png`, `${stack.name}-all.png`]) copyFileSync(join(workDir, file), join(outDir, file));
  console.log(`drew ${stack.name}.png and ${stack.name}-all.png`);
}
