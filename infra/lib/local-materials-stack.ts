import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import type { LocalMaterialsConfig } from './local-materials-config.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface LocalMaterialsStackProps extends StackProps {
  config: LocalMaterialsConfig;
}

/**
 * The studio (platform API-LOCAL-MATERIALS, console DES-013): notes and studios, handed out per cell.
 * A stack of its own (K-1), deployed after the relay, whose tokens, model and budget it uses
 * (K-2, K-3), and before the console, which reads this stack's names from Parameter Store.
 */
export class LocalMaterialsStack extends Stack {
  constructor(scope: Construct, id: string, props: LocalMaterialsStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prod = config.name === 'prod';
    const removal = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const param = (name: string) => `/yorisoi-local-materials/${config.name}/${name}`;
    const relayParam = (name: string) => `/yorisoi-ai-relay/${config.name}/${name}`;
    const parameterArn = (name: string) => `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`;

    // DES-013「データモデル」: everything carries a ttl; reports and blocks expire, notes after a week.
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
        },
      ],
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: prod },
      removalPolicy: removal,
    });

    // K-5: providers upload to the intake bucket; only checked audio is copied to the served one.
    // Uploads go in a day; held audio and transcripts stay 30 days, so an appeal can still be met.
    // CORS allows any origin, as the console's intake does: a POST still needs the presigned policy.
    const intake = new s3.Bucket(this, 'Intake', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 3600 }],
      lifecycleRules: [
        { prefix: 'uploads/', expiration: Duration.days(1) },
        { prefix: 'held/', expiration: Duration.days(30) },
        { prefix: 'transcripts/', expiration: Duration.days(30) },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // A studio starts within 30 days and runs at most 30: its audio is gone soon after it ends.
    const audio = new s3.Bucket(this, 'Audio', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ prefix: 'studios/', expiration: Duration.days(62) }],
      removalPolicy: removal,
      autoDeleteObjects: !config.retainData,
    });
    const distribution = new cloudfront.Distribution(this, 'AudioCdn', {
      comment: `Yorisoi studio audio (${config.name})`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(audio),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      enableLogging: false,
    });

    // K-19: the operator raises the terms' version, or pauses the studio, without a deploy.
    const termsVersion = new ssm.StringParameter(this, 'TermsVersion', {
      parameterName: param('terms-version'),
      stringValue: String(config.termsVersion),
      description: 'The version of the note terms the apps must have accepted (DES-013 K-19)',
    });
    const termsUrl = new ssm.StringParameter(this, 'TermsUrl', {
      parameterName: param('terms-url'),
      stringValue: config.termsUrl,
      description: 'Where the apps show the note terms (DES-013 K-19)',
    });
    const termsUpdatedAt = new ssm.StringParameter(this, 'TermsUpdatedAt', {
      parameterName: param('terms-updated-at'),
      stringValue: '2026-11-01T00:00:00Z',
      description: 'When the note terms were last changed (DES-013 K-19)',
    });
    const paused = new ssm.StringParameter(this, 'Paused', {
      parameterName: param('paused'),
      stringValue: 'false',
      description: 'true stops the studio: the apps get local_paused (API-LOCAL-MATERIALS)',
    });

    const relayTableName = ssm.StringParameter.valueForStringParameter(this, relayParam('table-name'));

    const fn = new nodejs.NodejsFunction(this, 'LocalMaterials', {
      projectRoot: repoRoot,
      depsLockFilePath: `${repoRoot}package-lock.json`,
      entry: `${repoRoot}api/src/local/handler.ts`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: { format: nodejs.OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true },
      memorySize: 512,
      // A note's check is a short call to the model; the API waits at most 29.
      timeout: Duration.seconds(28),
      logGroup: new logs.LogGroup(this, 'LocalLogs', {
        retention: prod ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        STUDIO_ENV: config.name,
        TABLE_NAME: table.tableName,
        RELAY_TABLE_NAME: relayTableName,
        AUDIO_BASE_URL: `https://${distribution.distributionDomainName}`,
        PARAM_TERMS_VERSION: termsVersion.parameterName,
        PARAM_TERMS_URL: termsUrl.parameterName,
        PARAM_TERMS_UPDATED_AT: termsUpdatedAt.parameterName,
        PARAM_PAUSED: paused.parameterName,
        PARAM_RELAY_MONTHLY_BUDGET: relayParam('monthly-budget-usd'),
        PARAM_RELAY_MODEL: relayParam('model'),
        DEFAULT_TERMS_VERSION: String(config.termsVersion),
        DEFAULT_TERMS_URL: config.termsUrl,
        DEFAULT_MONTHLY_BUDGET_USD: String(config.monthlyBudgetUsd),
        MODELS: JSON.stringify(config.models.map(({ id, profile, price }) => ({ id, profile, price }))),
        DEFAULT_MODEL: config.model,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    table.grantReadWriteData(fn);
    for (const p of [termsVersion, termsUrl, termsUpdatedAt, paused]) p.grantRead(fn);
    // Both functions read the relay's settings, add to its month and call its models (K-3).
    const relayAccess: iam.PolicyStatement[] = [];
    relayAccess.push(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters'],
        resources: [parameterArn(relayParam('monthly-budget-usd')), parameterArn(relayParam('model'))],
      }),
    );
    // K-3: in the relay's table, only tokens are read and only the month's spend is added to.
    relayAccess.push(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [`arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${relayTableName}`],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TOKEN#*', 'SPEND'] } },
      }),
    );
    // The relay's models only, as the relay calls them (API-AI-RELAY R-5).
    relayAccess.push(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: config.models.flatMap((m) =>
          m.inferenceProfile
            ? [
                `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${m.profile}`,
                `arn:${this.partition}:bedrock:ap-northeast-1::foundation-model/${m.foundationModel}`,
                `arn:${this.partition}:bedrock:ap-northeast-3::foundation-model/${m.foundationModel}`,
              ]
            : [`arn:${this.partition}:bedrock:${this.region}::foundation-model/${m.foundationModel}`],
        ),
      }),
    );

    // ---- the studio check (K-11) ----
    const jobPrefix = `studio-${config.name}-`;
    const checkFn = new nodejs.NodejsFunction(this, 'StudioCheck', {
      projectRoot: repoRoot,
      depsLockFilePath: `${repoRoot}package-lock.json`,
      entry: `${repoRoot}api/src/local/studio-handler.ts`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: { format: nodejs.OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true },
      memorySize: 512,
      timeout: Duration.minutes(1),
      logGroup: new logs.LogGroup(this, 'StudioCheckLogs', {
        retention: prod ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        STUDIO_ENV: config.name,
        TABLE_NAME: table.tableName,
        RELAY_TABLE_NAME: relayTableName,
        INTAKE_BUCKET: intake.bucketName,
        AUDIO_BUCKET: audio.bucketName,
        JOB_PREFIX: jobPrefix,
        PARAM_TERMS_VERSION: termsVersion.parameterName,
        PARAM_TERMS_URL: termsUrl.parameterName,
        PARAM_TERMS_UPDATED_AT: termsUpdatedAt.parameterName,
        PARAM_PAUSED: paused.parameterName,
        PARAM_RELAY_MONTHLY_BUDGET: relayParam('monthly-budget-usd'),
        PARAM_RELAY_MODEL: relayParam('model'),
        DEFAULT_TERMS_VERSION: String(config.termsVersion),
        DEFAULT_TERMS_URL: config.termsUrl,
        DEFAULT_MONTHLY_BUDGET_USD: String(config.monthlyBudgetUsd),
        MODELS: JSON.stringify(config.models.map(({ id, profile, price }) => ({ id, profile, price }))),
        DEFAULT_MODEL: config.model,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    table.grantReadWriteData(checkFn);
    for (const p of [termsVersion, termsUrl, termsUpdatedAt, paused]) p.grantRead(checkFn);
    // Transcribe reads the held audio and writes the transcript with the caller's rights.
    intake.grantRead(checkFn, 'uploads/*');
    intake.grantReadWrite(checkFn, 'held/*');
    intake.grantReadWrite(checkFn, 'transcripts/*');
    audio.grantPut(checkFn, 'studios/*');
    checkFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['transcribe:StartTranscriptionJob'], resources: ['*'] }));
    new events.Rule(this, 'TranscribeDone', {
      description: 'Hands this stack’s finished Transcribe jobs to the studio check (DES-013 K-11)',
      eventPattern: {
        source: ['aws.transcribe'],
        detailType: ['Transcribe Job State Change'],
        detail: { TranscriptionJobName: [{ prefix: jobPrefix }], TranscriptionJobStatus: ['COMPLETED', 'FAILED'] },
      },
      targets: [new targets.LambdaFunction(checkFn)],
    });
    for (const f of [fn, checkFn]) for (const statement of relayAccess) f.addToRolePolicy(statement);

    const api = new apigw.RestApi(this, 'Api', {
      restApiName: `yorisoi-local-materials-${config.name}`,
      description: 'The studio (platform API-LOCAL-MATERIALS)',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: { stageName: 'api', throttlingRateLimit: prod ? 100 : 10, throttlingBurstLimit: prod ? 200 : 20 },
      cloudWatchRole: false,
    });
    const integration = new apigw.LambdaIntegration(fn);
    const studio = api.root.addResource('v1').addResource('local');
    studio.addResource('cells').addMethod('GET', integration);
    const notes = studio.addResource('notes');
    notes.addMethod('POST', integration);
    notes.addResource('mine').addMethod('GET', integration);
    notes.addResource('{id}').addMethod('DELETE', integration);
    studio.addResource('reactions').addMethod('POST', integration);
    studio.addResource('reports').addMethod('POST', integration);
    const blocks = studio.addResource('blocks');
    blocks.addMethod('POST', integration);
    blocks.addMethod('GET', integration);
    blocks.addResource('{id}').addMethod('DELETE', integration);
    studio.addResource('terms').addMethod('GET', integration);

    if (config.waf) {
      const waf = new wafv2.CfnWebACL(this, 'ApiWaf', {
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `yorisoi-local-materials-${config.name}`, sampledRequestsEnabled: false },
        rules: [
          {
            name: 'RateLimitPerIp',
            priority: 0,
            action: { block: { customResponse: { responseCode: 429 } } },
            statement: { rateBasedStatement: { limit: 300, evaluationWindowSec: 300, aggregateKeyType: 'IP' } },
            visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp', sampledRequestsEnabled: false },
          },
          {
            name: 'AmazonIpReputation',
            priority: 1,
            overrideAction: { none: {} },
            statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' } },
            visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'AmazonIpReputation', sampledRequestsEnabled: false },
          },
        ],
      });
      new wafv2.CfnWebACLAssociation(this, 'ApiWafAssociation', { resourceArn: api.deploymentStage.stageArn, webAclArn: waf.attrArn });
    }

    // ---- what tells the operator ----
    const alarms = new sns.Topic(this, 'Alarms', { displayName: `Yorisoi studio (${config.name})` });
    if (config.alarmEmail) alarms.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    const alarm = (id: string, name: string, statistic: string, threshold: number, description: string) =>
      new cloudwatch.Alarm(this, id, {
        metric: new cloudwatch.Metric({ namespace: 'YorisoiLocalMaterials', metricName: name, dimensionsMap: { Env: config.name }, statistic, period: Duration.minutes(5) }),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      }).addAlarmAction(new cwActions.SnsAction(alarms));
    alarm('UpstreamErrors', 'UpstreamError', 'Sum', 10, 'The note check failed 10 times in 5 minutes (DES-013 K-10)');
    alarm('BadSetting', 'InvalidSetting', 'Maximum', 1, 'A studio or relay parameter is not valid; the studio uses the deployed value (DES-013 K-19)');
    alarm('NotesHidden', 'NotesHidden', 'Sum', 1, 'A note was hidden by reports and waits for the operator (REQ-NOTES F-13)');
    alarm('StudiosSuspended', 'StudiosSuspended', 'Sum', 1, 'A studio was stopped by reports and waits for the operator (studio-rules.md 4.1)');

    // K-2: the console stack reads these when it is deployed.
    new ssm.StringParameter(this, 'TableNameParameter', { parameterName: param('table-name'), stringValue: table.tableName });
    new ssm.StringParameter(this, 'IntakeBucketParameter', { parameterName: param('intake-bucket'), stringValue: intake.bucketName });
    new ssm.StringParameter(this, 'AudioBucketParameter', { parameterName: param('audio-bucket'), stringValue: audio.bucketName });
    new ssm.StringParameter(this, 'CheckFunctionParameter', { parameterName: param('check-function'), stringValue: checkFn.functionName });

    new CfnOutput(this, 'LocalUrl', { value: `${api.url}` });
    new CfnOutput(this, 'AudioBaseUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'PausedParameter', { value: paused.parameterName });
    new CfnOutput(this, 'TermsVersionParameter', { value: termsVersion.parameterName });
  }
}
