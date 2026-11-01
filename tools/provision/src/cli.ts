import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, publicKeyFromRaw, rawPublicKey, utf8 } from '@yorisoi-console/protocol';
import { signKeyset, verifyKeyset } from '@yorisoi-console/root-key';
import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const USAGE = `provision — set up the development provider (DES-002). Not for production: its root key stays offline

  npm run provision -w tools/provision -- --env dev --root-key <dir with root-key.pem and passphrase.txt>

Steps (each one skips what is already done):
  1. read the stack outputs
  2. register each KMS signing key (its public key from KMS) as an active signing key
  3. sign a keyset listing those keys with the root key, and register it
  4. run the publisher once
Uses the AWS credentials of AWS_PROFILE (e.g. an SSO profile).`;

const DAY = 24 * 3600_000;

async function main() {
  const { values } = parseArgs({
    options: { env: { type: 'string', default: 'dev' }, 'root-key': { type: 'string' }, 'validity-days': { type: 'string', default: '180' } },
  });
  const rootDir = values['root-key'];
  if (!rootDir) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  if (values.env === 'prod') {
    // The production root key stays on an offline machine (ARCH-001 A-9, docs/operations/keys.md).
    console.error('provision is for development only: register production keys in the operator screen and sign keysets offline (docs/operations/keys.md)');
    process.exitCode = 1;
    return;
  }
  const region = 'ap-northeast-1';
  const stackName = `YorisoiConsole-${values.env}`;

  // 1. Stack outputs.
  const cfn = new CloudFormationClient({ region });
  const stack = (await cfn.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
  const outputs = new Map((stack?.Outputs ?? []).map((o) => [o.OutputKey!, o]));
  const out = (key: string) => outputs.get(key)?.OutputValue ?? fail(`${stackName} has no output ${key}`);
  const table = out('TableName');
  const functionName = out('PublishFunctionName');
  const providerUrl = out('ProviderUrl');
  const signingKeys = [...outputs.values()]
    .filter((o) => o.OutputKey?.startsWith('SigningKeyArn'))
    .map((o) => ({ keyId: o.Description ?? fail(`${o.OutputKey} has no key id`), arn: o.OutputValue! }));
  console.log(`stack ${stackName}: table ${table}, ${signingKeys.length} signing key(s), ${providerUrl}`);

  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const kms = new KMSClient({ region });

  // 2. Signing keys.
  const now = new Date();
  const entries = [];
  for (const key of signingKeys) {
    const res = await kms.send(new GetPublicKeyCommand({ KeyId: key.arn }));
    if (res.KeySpec !== 'ECC_NIST_EDWARDS25519' || !res.PublicKey) fail(`${key.keyId} is not an Ed25519 key`);
    const raw = rawPublicKey(createPublicKey({ key: Buffer.from(res.PublicKey!), format: 'der', type: 'spki' }));
    publicKeyFromRaw(raw);
    const publicKey = b64url.encode(raw);
    const existing = (await db.send(new GetCommand({ TableName: table, Key: { PK: 'SIGNKEY', SK: `KEY#${key.keyId}` } }))).Item;
    if (!existing) {
      await db.send(
        new PutCommand({
          TableName: table,
          Item: { PK: 'SIGNKEY', SK: `KEY#${key.keyId}`, type: 'signing-key', keyId: key.keyId, kmsKeyArn: key.arn, publicKey, status: 'active', createdAt: now.toISOString() },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      console.log(`registered signing key ${key.keyId}`);
    } else if (existing.publicKey !== publicKey) {
      fail(`${key.keyId} is registered with another public key`);
    }
    entries.push({
      keyId: key.keyId,
      publicKey,
      notBefore: new Date(now.getTime() - DAY).toISOString(),
      notAfter: new Date(now.getTime() + Number(values['validity-days']) * DAY).toISOString(),
    });
  }

  // 3. Keyset, unless the current one already lists every key.
  const rootPem = await readFile(`${rootDir}/root-key.pem`, 'utf8');
  const passphrase = (await readFile(`${rootDir}/passphrase.txt`, 'utf8')).trim();
  const rootPublicKey = (await readFile(`${rootDir}/root-key.pub`, 'utf8')).trim();
  const head = (await db.send(new GetCommand({ TableName: table, Key: { PK: 'KEYSET', SK: 'HEAD' }, ConsistentRead: true }))).Item;
  const current = head ? verifyKeyset(head.document, rootPublicKey) : undefined;
  const missing = entries.filter((e) => !current?.keys.some((k) => k.keyId === e.keyId && k.publicKey === e.publicKey));
  if (missing.length > 0) {
    const seq = (current?.seq ?? 0) + 1;
    const document = await signKeyset({ seq, keys: entries, revokedKeys: current?.revokedKeys ?? [] }, rootPem, passphrase, now);
    const item = { type: 'keyset', seq, document, registeredBy: 'provision', verifiedAt: now.toISOString() };
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table,
              Item: { PK: 'KEYSET', SK: 'HEAD', ...item },
              ...(current ? { ConditionExpression: 'seq = :prev', ExpressionAttributeValues: { ':prev': current.seq } } : { ConditionExpression: 'attribute_not_exists(PK)' }),
            },
          },
          { Put: { TableName: table, Item: { PK: 'KEYSET', SK: `SEQ#${String(seq).padStart(10, '0')}`, ...item }, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }),
    );
    // Keep the signing keys' validity next to them, as the operator screen does (DES-002 J-4).
    for (const e of entries) {
      await db.send(
        new UpdateCommand({
          TableName: table, Key: { PK: 'SIGNKEY', SK: `KEY#${e.keyId}` },
          UpdateExpression: 'SET #s = :active, notBefore = :nb, notAfter = :na', ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':active': 'active', ':nb': e.notBefore, ':na': e.notAfter },
        }),
      );
    }
    console.log(`registered keyset seq ${seq} (${entries.map((e) => e.keyId).join(', ')})`);
  } else {
    console.log(`keyset seq ${current!.seq} already lists every key`);
  }

  // 4. Publish once.
  const res = await new LambdaClient({ region }).send(
    new InvokeCommand({ FunctionName: functionName, Payload: utf8.encode(JSON.stringify({ trigger: 'keyset' })) }),
  );
  const payload = res.Payload ? utf8.decode(res.Payload) : '';
  if (res.FunctionError) fail(`publisher failed: ${payload}`);
  console.log(`published: ${payload}\n\nnext: npm run check -w conformance -- ${providerUrl} --provider <provider id>`);
}

function fail(message: string): never {
  throw new Error(message);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
