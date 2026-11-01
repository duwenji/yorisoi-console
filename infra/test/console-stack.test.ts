import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configs } from '../lib/config.js';
import { ConsoleStack } from '../lib/console-stack.js';

// A stand-in for web/dist, so the tests don't need the SPA built.
const webDist = mkdtempSync(join(tmpdir(), 'web-dist-'));
writeFileSync(join(webDist, 'index.html'), '<!doctype html>');
// And for the machine review's package.
const validatorZip = join(webDist, 'validator.zip');
writeFileSync(validatorZip, 'zip');

function template(name: 'dev' | 'prod') {
  // Skip bundling the Lambda code; tests look at the resources, not the bundle.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new ConsoleStack(app, `Test-${name}`, {
    config: { ...configs[name], rootPublicKey: 'A'.repeat(43) },
    webDist,
    validatorZip,
    env: { region: 'ap-northeast-1', account: '123456789012' },
  });
  return Template.fromStack(stack);
}

describe('ConsoleStack', () => {
  const prod = template('prod');

  it('has the DM-001 table with both GSIs, TTL and PITR', () => {
    prod.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: 'GSI1' }), Match.objectLike({ IndexName: 'GSI2' })]),
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }, DeletionProtectionEnabled: true })],
    });
  });

  it('signs with Ed25519 keys in KMS, only from the publisher and only as pure Ed25519', () => {
    prod.hasResourceProperties('AWS::KMS::Key', { KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY' });
    prod.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'kms:Sign',
            Condition: { StringEquals: { 'kms:SigningAlgorithm': 'ED25519_SHA_512', 'kms:MessageType': 'RAW' } },
          }),
        ]),
      },
    });
    // No identity policy grants kms:Sign without the conditions.
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('kms:Sign');
  });

  it('keeps the public bucket private behind CloudFront with HTTPS only', () => {
    prod.resourceCountIs('AWS::S3::Bucket', 4);
    prod.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    prod.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'https-only' }) }),
    });
    prod.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
  });

  it('runs one publisher at a time, daily, with alarms', () => {
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      ReservedConcurrentExecutions: 1,
      Environment: { Variables: Match.objectLike({ ROOT_PUBLIC_KEY: 'A'.repeat(43), PROVIDER_NAME: 'SanpoGuide 公式チャンネル' }) },
    });
    prod.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 18 * * ? *)',
      Target: Match.objectLike({ Input: '{"trigger":"daily"}' }),
    });
    prod.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });

  it('keeps production data on stack deletion, but not development data', () => {
    prod.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    const dev = template('dev');
    dev.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    dev.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
  });

  it('requires TOTP MFA from everyone and lets only sign-ups become publishers (ARCH-001 A-4 1.2)', () => {
    prod.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12 }) },
      LambdaConfig: { PostConfirmation: Match.anyValue() },
    });
    prod.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'operator' });
    prod.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'publisher' });
    prod.hasResourceProperties('AWS::Cognito::UserPoolDomain', { ManagedLoginVersion: 2 });
    prod.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 1);
    prod.hasResourceProperties('AWS::WAFv2::WebACLAssociation', { ResourceArn: Match.anyValue() });
  });

  it('gives the SPA a public client: code flow, no secret, no localhost in production', () => {
    prod.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      EnableTokenRevocation: true,
      CallbackURLs: Match.arrayWith([Match.objectLike({ 'Fn::Join': Match.anyValue() })]),
    });
    expect(JSON.stringify(prod.findResources('AWS::Cognito::UserPoolClient'))).not.toContain('localhost');
    expect(JSON.stringify(template('dev').findResources('AWS::Cognito::UserPoolClient'))).toContain('http://localhost:5173/callback');
  });

  it('puts the API behind the JWT authorizer, throttled, and the SPA behind a strict CSP', () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'] });
    prod.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /api/{proxy+}', AuthorizationType: 'JWT' });
    prod.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 } });
    const csp = JSON.stringify(prod.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('keeps development cheap and production protected (docs/operations/cost.md)', () => {
    const dev = template('dev');
    dev.resourceCountIs('AWS::WAFv2::WebACL', 0);
    dev.resourceCountIs('AWS::SecretsManager::Secret', 0);
    dev.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ CURSOR_KEY: Match.anyValue() }) } });
    dev.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
    dev.hasResourceProperties('AWS::DynamoDB::GlobalTable', { Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } })] });
    dev.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: 'USD' }, CostFilters: { TagKeyValue: ['user:project$yorisoi-console'] } }),
    });

    prod.resourceCountIs('AWS::WAFv2::WebACL', 1);
    prod.resourceCountIs('AWS::SecretsManager::Secret', 1);
    prod.resourceCountIs('AWS::Logs::LogGroup', 0);
    prod.resourceCountIs('AWS::Budgets::Budget', 0);
  });

  it('takes uploads straight to a private intake bucket that forgets settled packages after 90 days', () => {
    prod.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ['POST'] })] },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'archive/', ExpirationInDays: 90 }),
          Match.objectLike({ Prefix: 'archive-col/', ExpirationInDays: 90 }),
        ]),
      },
    });
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('cognito-idp:AdminDeleteUser');
    expect(JSON.stringify(prod.findResources('AWS::CloudFront::ResponseHeadersPolicy'))).toContain('IntakeBucket');
  });

  it('reviews uploads with the Java Lambda, and lets the console API sign tickets only through the key policy', () => {
    prod.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'java21', Handler: 'console.validator.Handler::handleRequest' });
    prod.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          Match.objectLike({ Events: ['s3:ObjectCreated:*'], Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'intake/' }] } } }),
          // Collections too (DES-007 J-3).
          Match.objectLike({ Events: ['s3:ObjectCreated:*'], Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'intake-col/' }] } } }),
        ],
      },
    });
    // The publisher checks outside resources daily and tells producers through the queue (DES-009 M-7).
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 360,
      Environment: { Variables: Match.objectLike({ NOTIFY_QUEUE_URL: Match.anyValue(), DISTRIBUTION_ID: Match.anyValue() }) },
    });
    // The API copies approved collections to col/ and knows each app's version of each stage (DES-008 K-4・K-6, DES-011 N-4).
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ APP_STAGE_VERSIONS: '{"sanpoguide":{"0":1,"1":1,"2":9999,"3":9999},"cycleguide":{"0":1,"1":9999,"2":9999,"3":9999}}' }) },
    });
    // Reading a collection's outside resources takes up to 10 minutes (J-5); it resolves against the listed ones (J-2).
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'console.validator.Handler::handleRequest',
      Timeout: 900,
      Environment: { Variables: Match.objectLike({ PUBLIC_BUCKET: Match.anyValue() }) },
    });
    const keyPolicy = JSON.stringify(prod.findResources('AWS::KMS::Key'));
    expect(keyPolicy.match(/ED25519_SHA_512/g)?.length).toBe(2);
    expect(JSON.stringify(prod.findResources('AWS::IAM::Policy'))).not.toContain('kms:Sign');
  });

  it('lets the console reach the AI for review samples, and nothing else outside', () => {
    const csp = JSON.stringify(prod.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    expect(csp).toContain('https://api.openai.com');
    expect(csp).toContain('https://api.deepseek.com');
    expect(csp).not.toContain('api.anthropic.com');
  });

  it('emails publishers through a queue with retries, a dead-letter queue and an alarm (ARCH-001 A-19)', () => {
    prod.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: { maxReceiveCount: 3, deadLetterTargetArn: Match.anyValue() } });
    prod.hasResourceProperties('AWS::Lambda::EventSourceMapping', { FunctionResponseTypes: ['ReportBatchItemFailures'] });
    prod.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmDescription: Match.stringLikeRegexp('dead-letter'), AlarmActions: Match.anyValue() });
    prod.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ NOTIFY_MODE: 'log' }) } });
    expect(JSON.stringify(prod.findResources('AWS::IAM::Policy'))).toContain('cognito-idp:AdminGetUser');
    // No sending until a domain is set up (T-7); then only from that identity.
    expect(JSON.stringify(prod.findResources('AWS::IAM::Policy'))).not.toContain('ses:SendEmail');
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const ses = Template.fromStack(
      new ConsoleStack(app, 'Test-ses', {
        config: { ...configs.prod, rootPublicKey: 'A'.repeat(43), notify: { mode: 'ses', from: 'no-reply@channels.example' } },
        webDist, validatorZip, env: { region: 'ap-northeast-1', account: '123456789012' },
      }),
    );
    ses.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ NOTIFY_MODE: 'ses', NOTIFY_FROM: 'no-reply@channels.example' }) } });
    expect(JSON.stringify(ses.findResources('AWS::IAM::Policy'))).toContain('identity/channels.example');
  });
});
