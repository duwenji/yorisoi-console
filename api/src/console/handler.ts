import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, providerId, signDocument, verifyDiscovery, type SignedDocument } from '@yorisoi-console/protocol';
import { kmsSigner } from '../publish/aws.js';
import type { SigningKeyRecord } from '../publish/ports.js';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { appsWith, DEFAULT_STAGE_VERSIONS, type AppEntry, type Deps, type LocalDeps } from './deps.js';
import { ApiError, problem } from './http.js';
import { callerFrom, route } from './router.js';
import { CursorCodec } from './util.js';

function env(name: string): string {
  return process.env[name] || (() => { throw new Error(`${name} is not set`); })();
}

const kms = new KMSClient({});
const lambda = new LambdaClient({});
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});
const sqs = new SQSClient({});
let deps: Deps | undefined;

/** The cursor key: from $CURSOR_KEY (development) or a Secrets Manager secret (production). */
async function cursorKey(): Promise<Buffer> {
  if (process.env.CURSOR_KEY) return Buffer.from(process.env.CURSOR_KEY, 'base64url');
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: env('CURSOR_SECRET_ARN') }));
  // The secret is random text; its SHA-256 is the 32-byte AES key.
  return createHash('sha256').update(secret.SecretString ?? '').digest();
}

async function load(): Promise<Deps> {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return {
    db,
    table: env('TABLE_NAME'),
    now: () => new Date(),
    cursors: new CursorCodec(await cursorKey()),
    rootPublicKey: env('ROOT_PUBLIC_KEY'),
    kmsPublicKey: async (keyArn) => {
      const out = await kms.send(new GetPublicKeyCommand({ KeyId: keyArn }));
      return { keySpec: out.KeySpec, publicKey: out.PublicKey ?? new Uint8Array() };
    },
    requestPublish: async (trigger) => {
      await lambda.send(new InvokeCommand({ FunctionName: env('PUBLISH_FUNCTION'), InvocationType: 'Event', Payload: JSON.stringify({ trigger }) }));
    },
    presignUpload: async (key, contentType, maxBytes) => {
      // S3 itself refuses a larger file or another type (API-001 C-10).
      const post = await createPresignedPost(s3, {
        Bucket: env('INTAKE_BUCKET'),
        Key: key,
        Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', contentType]],
        Fields: { 'Content-Type': contentType },
        Expires: 15 * 60,
      });
      return { url: post.url, fields: post.fields };
    },
    archiveUpload: async (key) => {
      const bucket = env('INTAKE_BUCKET');
      const target = key.replace(/^intake-col\//, 'archive-col/').replace(/^intake\//, 'archive/');
      try {
        await s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${key}`, Key: target }));
      } catch (e) {
        // Nothing was uploaded: nothing to keep.
        if ((e as { name?: string }).name === 'NoSuchKey') return;
        throw e;
      }
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    publishTrial: async (sourceKey, sha256) => {
      const key = `trial/${sha256}.zip`;
      await s3.send(
        new CopyObjectCommand({
          Bucket: env('PUBLIC_BUCKET'), Key: key, CopySource: `${env('INTAKE_BUCKET')}/${sourceKey}`,
          MetadataDirective: 'REPLACE', ContentType: 'application/zip', CacheControl: 'public, max-age=86400, immutable',
        }),
      );
      return `${env('PROVIDER_URL')}/${key}`;
    },
    packageUrl: (sha256) => `${env('PROVIDER_URL')}/pkg/${sha256}.zip`,
    signDocument: async (content) => {
      // The newest key of the current keyset (verified with the pinned root key) that is in its
      // validity, not revoked, and active in the table: the same choice the publisher makes (A-8).
      const now = Date.now();
      const table = env('TABLE_NAME');
      const rootKey = env('ROOT_PUBLIC_KEY');
      const head = (await db.send(new GetCommand({ TableName: table, Key: { PK: 'KEYSET', SK: 'HEAD' }, ConsistentRead: true }))).Item;
      if (!head) throw new Error('no keyset has been registered');
      const { keyset } = verifyDiscovery({
        provider: providerId(b64url.decode(rootKey)), name: '-', versions: ['v1'], list: '/v1/channels.json', rootKey, keyset: head.document as SignedDocument,
      });
      const records = new Map(
        ((await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'SIGNKEY' } }))).Items ?? []).map((k) => [String(k.keyId), k]),
      );
      const key = keyset.keys
        .filter((k) => !keyset.revokedKeys.includes(k.keyId) && Date.parse(k.notBefore) <= now && now < Date.parse(k.notAfter) && records.get(k.keyId)?.status === 'active')
        .sort((a, b) => Date.parse(b.notBefore) - Date.parse(a.notBefore))[0];
      if (!key) throw new Error('no active signing key in the current keyset');
      const record = records.get(key.keyId)!;
      return signDocument(content, kmsSigner({ keyId: key.keyId, kmsKeyArn: String(record.kmsKeyArn), status: 'active' } satisfies SigningKeyRecord, kms));
    },
    readUpload: async (key) => {
      const out = await s3.send(new GetObjectCommand({ Bucket: env('INTAKE_BUCKET'), Key: key }));
      return new Uint8Array(await out.Body!.transformToByteArray());
    },
    presignDownload: (key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: env('INTAKE_BUCKET'), Key: key }), { expiresIn: 300 }),
    readRecord: async (key) => {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: env('RECORDS_BUCKET'), Key: key }));
        return await out.Body!.transformToString('utf-8');
      } catch (e) {
        if (e instanceof NoSuchKey) return undefined;
        throw e;
      }
    },
    writeRecord: async (key, body) => {
      await s3.send(new PutObjectCommand({ Bucket: env('RECORDS_BUCKET'), Key: key, Body: body, ContentType: 'application/json' }));
    },
    publishApproved: async ({ packageKey, packageSha256, iconKey, iconSha256 }) => {
      // Named by their hashes, so they are immutable and cached for long (ADR-001 A-7).
      const copy = (from: string, to: string, contentType: string) =>
        s3.send(new CopyObjectCommand({
          Bucket: env('PUBLIC_BUCKET'), Key: to, CopySource: `${env('INTAKE_BUCKET')}/${from}`,
          MetadataDirective: 'REPLACE', ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable',
        }));
      await copy(packageKey, `pkg/${packageSha256}.zip`, 'application/zip');
      await copy(iconKey, `icons/${iconSha256}.png`, 'image/png');
      return { packageUrl: `${env('PROVIDER_URL')}/pkg/${packageSha256}.zip`, iconUrl: `${env('PROVIDER_URL')}/icons/${iconSha256}.png` };
    },
    publishCollection: async (packageKey, sha256) => {
      const key = `col/${sha256}.zip`;
      await s3.send(new CopyObjectCommand({
        Bucket: env('PUBLIC_BUCKET'), Key: key, CopySource: `${env('INTAKE_BUCKET')}/${packageKey}`,
        MetadataDirective: 'REPLACE', ContentType: 'application/zip', CacheControl: 'public, max-age=31536000, immutable',
      }));
      return `${env('PROVIDER_URL')}/${key}`;
    },
    apps: apps(),
    ...(process.env.LOCAL_TABLE ? { local: local() } : {}),
    deleteUser: async (sub) => {
      // Sign-in is by email, so the user name is the sub.
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: sub }));
    },
    notify: async (notice) => {
      await sqs.send(new SendMessageCommand({ QueueUrl: env('NOTIFY_QUEUE_URL'), MessageBody: JSON.stringify(notice) }));
    },
  };
}

/** The studio stack's table, intake and check (DES-013 K-2), when the console is deployed with it. */
function local(): LocalDeps {
  return {
    table: env('LOCAL_TABLE'),
    presignAudio: async (key, maxBytes) => {
      const post = await createPresignedPost(s3, {
        Bucket: env('STUDIO_INTAKE_BUCKET'),
        Key: key,
        Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', 'audio/mp4']],
        Fields: { 'Content-Type': 'audio/mp4' },
        Expires: 15 * 60,
      });
      return { url: post.url, fields: post.fields };
    },
    invokeCheck: async (event) => {
      await lambda.send(new InvokeCommand({ FunctionName: env('STUDIO_CHECK_FUNCTION'), InvocationType: 'Event', Payload: JSON.stringify(event) }));
    },
  };
}

/** The known apps with the versions each app stage needs, from the CDK configuration (DES-011 N-4). */
function apps(): Record<string, AppEntry> {
  const raw = process.env.APP_STAGE_VERSIONS;
  if (!raw) return appsWith(DEFAULT_STAGE_VERSIONS);
  const parsed = JSON.parse(raw) as Record<string, Record<string, number>>;
  return appsWith(Object.fromEntries(Object.entries(parsed).map(([id, byStage]) => [
    id, Object.fromEntries(Object.entries(byStage).map(([k, v]) => [Number(k), Number(v)])),
  ])));
}

const MAX_BODY = 1024 * 1024;

/** The console API behind API Gateway's JWT authorizer (ADR-001 A-3, API-001). */
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;
  try {
    deps ??= await load();
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : undefined;
    if (raw && raw.length > MAX_BODY) return problem(new ApiError('payload_too_large', 'the body is over 1MB'), requestId);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return problem(new ApiError('invalid_request', 'the body is not JSON'), requestId);
    }
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return await route(deps, {
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: event.queryStringParameters ?? {},
      headers,
      body,
      caller: callerFrom(event.requestContext.authorizer.jwt.claims as Record<string, unknown>),
      requestId,
    });
  } catch (e) {
    if (e instanceof ApiError) return problem(e, requestId);
    console.error(JSON.stringify({ requestId, error: e instanceof Error ? e.stack : String(e) }));
    return problem(new ApiError('internal', 'internal error'), requestId);
  }
}
