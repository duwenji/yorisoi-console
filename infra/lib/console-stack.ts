import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import type { EnvConfig } from './config.js';
import { ConsoleApp } from './console-app.js';
import { PROJECT_TAG, logGroupFor } from './common.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));


export interface ConsoleStackProps extends StackProps {
  config: EnvConfig;
  /** The built SPA; defaults to web/dist. */
  webDist?: string;
  /** The built machine review; defaults to validator/build/lambda/validator.zip. */
  validatorZip?: string;
}

/**
 * The channel management system (ARCH-001). This first part is what publishing needs: the table
 * (DM-001), the public and archive buckets, CloudFront, the KMS signing keys, the publishing
 * Lambda with its daily schedule, and alarms; and the console (Cognito, the API, the SPA).
 */
export class ConsoleStack extends Stack {
  constructor(scope: Construct, id: string, props: ConsoleStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prod = config.name === 'prod';
    const keep = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // DM-001: one table, two GSIs; PITR and deletion protection (M-3 keeps the audit records forever).
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.cost.pointInTimeRecovery },
      deletionProtection: prod,
      timeToLiveAttribute: 'ttl',
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
        },
        {
          indexName: 'GSI2',
          partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    const bucketDefaults: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: keep,
      autoDeleteObjects: !prod,
    };
    // A-7: read only through CloudFront (OAC); only the publisher writes. `trial/` lasts 7 days (A-13).
    const publicBucket = new s3.Bucket(this, 'PublicBucket', {
      ...bucketDefaults,
      lifecycleRules: [{ prefix: 'trial/', expiration: Duration.days(7) }],
    });
    // M-13: every published list, keyset and review sample, kept for good.
    const recordsBucket = new s3.Bucket(this, 'RecordsBucket', { ...bucketDefaults, versioned: true });

    const distribution = new cloudfront.Distribution(this, 'PublicDistribution', {
      comment: `SanpoGuide channel provider (${config.name})`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(publicBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        // Honors the Cache-Control the publisher sets: 5 minutes for the lists, long for hashed files.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // With the custom domain (ARCH-001 未決事項 No.1), add its certificate and minimumProtocolVersion TLS_V1_2_2021;
      // the default CloudFront certificate ignores that setting.
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    // A-8: Ed25519 keys that never leave KMS; one per period, replaced through the root-signed keyset.
    const signingKeys = config.signingKeyIds.map(
      (keyId) =>
        new kms.Key(this, `SigningKey-${keyId}`, {
          description: `SanpoGuide channel list signing key ${keyId} (${config.name})`,
          keySpec: kms.KeySpec.ECC_NIST_EDWARDS25519,
          keyUsage: kms.KeyUsage.SIGN_VERIFY,
          alias: `alias/yorisoi-console/${config.name}/${keyId}`,
          removalPolicy: RemovalPolicy.RETAIN,
        }),
    );

    const publisher = new nodejs.NodejsFunction(this, 'PublishFunction', {
      ...logGroupFor(this, 'PublishFunctionLogs', config),
      entry: `${repoRoot}api/src/publish/handler.ts`,
      projectRoot: repoRoot,
      depsLockFilePath: `${repoRoot}package-lock.json`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // A minute to publish; the daily run then checks outside resources for up to 5 (DES-009 M-7).
      timeout: Duration.minutes(6),
      // A-10: one run at a time; the conditional write on seq guards the rest.
      reservedConcurrentExecutions: 1,
      bundling: { format: nodejs.OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true },
      environment: {
        TABLE_NAME: table.tableName,
        PUBLIC_BUCKET: publicBucket.bucketName,
        ARCHIVE_BUCKET: recordsBucket.bucketName,
        DISTRIBUTION_ID: distribution.distributionId,
        PROVIDER_NAME: config.providerName,
        ROOT_PUBLIC_KEY: config.rootPublicKey,
        ...(config.reviewPolicyUrl ? { REVIEW_POLICY_URL: config.reviewPolicyUrl } : {}),
        ...(config.termsUrl ? { TERMS_URL: config.termsUrl } : {}),
        ...(config.contact ? { CONTACT: config.contact } : {}),
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    table.grantReadWriteData(publisher);
    publicBucket.grantPut(publisher);
    recordsBucket.grantPut(publisher, 'published/*');
    // Only this function (and, later, the ticket function) may sign (A-8).
    for (const key of signingKeys) {
      key.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['kms:Sign'],
          principals: [new iam.ArnPrincipal(publisher.role!.roleArn)],
          resources: ['*'],
          conditions: { StringEquals: { 'kms:SigningAlgorithm': 'ED25519_SHA_512', 'kms:MessageType': 'RAW' } },
        }),
      );
      // No key.grant(): it would add an unconditional IAM allowance next to the conditioned key policy.
    }
    publisher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
      }),
    );

    // A-10: rebuild daily so the list (14 days) never runs out, even with nothing to change.
    new scheduler.Schedule(this, 'DailyPublish', {
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '18' }), // 03:00 JST
      target: new targets.LambdaInvoke(publisher, { input: scheduler.ScheduleTargetInput.fromObject({ trigger: 'daily' }) }),
      description: 'Rebuild and re-sign the approved channel list',
    });

    // A-16: tell the operator when publishing fails, or when nothing has been published for two days.
    const alarms = new sns.Topic(this, 'OperatorAlarms');
    if (config.alarmEmail) alarms.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    const failures = new cloudwatch.Alarm(this, 'PublishFailures', {
      metric: publisher.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The channel list could not be published',
    });
    const successes = new cloudwatch.MathExpression({
      expression: 'invocations - errors',
      usingMetrics: {
        invocations: publisher.metricInvocations({ period: Duration.days(1), statistic: 'Sum' }),
        errors: publisher.metricErrors({ period: Duration.days(1), statistic: 'Sum' }),
      },
      period: Duration.days(1),
    });
    const stale = new cloudwatch.Alarm(this, 'NoRecentPublication', {
      metric: successes,
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'No successful publication for two days; the list expires 14 days after the last one',
    });
    for (const alarm of [failures, stale]) alarm.addAlarmAction(new cwActions.SnsAction(alarms));

    // A monthly budget on what this project costs, by its tag (docs/operations/cost.md).
    if (config.cost.budget) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: `yorisoi-console-${config.name}`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: config.cost.budget.monthlyUsd, unit: 'USD' },
          costFilters: { TagKeyValue: [`user:project$${PROJECT_TAG}`] },
        },
        notificationsWithSubscribers: [
          { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'EMAIL', address: config.cost.budget.email }] },
          { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'EMAIL', address: config.cost.budget.email }] },
        ],
      });
    }

    const consoleApp = new ConsoleApp(this, 'Console', {
      config,
      repoRoot,
      webDist: props.webDist ?? `${repoRoot}web/dist`,
      table,
      publisher,
      signingKeys,
      publicBucket,
      providerUrl: `https://${distribution.distributionDomainName}`,
      recordsBucket,
      validatorZip: props.validatorZip ?? `${repoRoot}validator/build/lambda/validator.zip`,
      alarms,
    });
    // The daily check tells producers of outside resources that fail (DES-009 M-7).
    publisher.addEnvironment('NOTIFY_QUEUE_URL', consoleApp.notifyQueue.queueUrl);
    consoleApp.notifyQueue.grantSendMessages(publisher);
    // Test tickets are signed by the console API, under the same conditions as the list (A-8).
    for (const key of signingKeys) {
      key.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['kms:Sign'],
          principals: [new iam.ArnPrincipal(consoleApp.consoleFunction.role!.roleArn)],
          resources: ['*'],
          conditions: { StringEquals: { 'kms:SigningAlgorithm': 'ED25519_SHA_512', 'kms:MessageType': 'RAW' } },
        }),
      );
    }

    new CfnOutput(this, 'ProviderUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'PublishFunctionName', { value: publisher.functionName });
    signingKeys.forEach((key, i) => new CfnOutput(this, `SigningKeyArn${i}`, { value: key.keyArn, description: config.signingKeyIds[i] }));
  }
}
