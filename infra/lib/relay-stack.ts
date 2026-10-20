import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { RelayConfig } from './relay-config.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface RelayStackProps extends StackProps {
  config: RelayConfig;
}

/**
 * The operator's AI relay (platform ADR-AI-RELAY R-6): a stack of its own, so the console and the
 * relay don't stop each other. A REST API (it takes AWS WAF; an HTTP API doesn't), one Lambda that
 * calls Bedrock with its role, a table of nonces, tokens and counts, and the operator's settings in
 * Parameter Store.
 */
export class RelayStack extends Stack {
  constructor(scope: Construct, id: string, props: RelayStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prod = config.name === 'prod';

    // Nonces, tokens and counts all expire (API-AI-RELAY「中継が残すもの」): nothing to back up.
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // R-14: the operator changes these without a deploy; the Lambda reads them every 5 minutes.
    // CloudFormation only writes them when the value here changes, so a value set by hand stays.
    const dailyLimit = new ssm.StringParameter(this, 'DailyLimit', {
      parameterName: `/yorisoi-ai-relay/${config.name}/daily-limit`,
      stringValue: String(config.dailyLimit),
      description: 'Calls a day per install on the operator’s AI: an integer from 5 to 100 (ADR-AI-RELAY R-14)',
    });
    const monthlyBudget = new ssm.StringParameter(this, 'MonthlyBudget', {
      parameterName: `/yorisoi-ai-relay/${config.name}/monthly-budget-usd`,
      stringValue: String(config.monthlyBudgetUsd),
      description: 'USD a month for the operator’s AI; the relay pauses when the month’s spend reaches it (ADR-AI-RELAY R-10)',
    });
    const model = new ssm.StringParameter(this, 'Model', {
      parameterName: `/yorisoi-ai-relay/${config.name}/model`,
      stringValue: config.model,
      description: `The model of the operator’s AI, one of: ${config.models.map((m) => m.id).join(', ')} (ADR-AI-RELAY R-5)`,
    });

    const installSecret =
      config.installKey === 'secret'
        ? new secrets.Secret(this, 'InstallKey', {
            description: 'Key for the hashes of install ids (API-AI-RELAY AR-2)',
            generateSecretString: { passwordLength: 64, excludePunctuation: true },
            removalPolicy: RemovalPolicy.RETAIN,
          })
        : undefined;

    const fn = new nodejs.NodejsFunction(this, 'Relay', {
      projectRoot: repoRoot,
      depsLockFilePath: `${repoRoot}package-lock.json`,
      entry: `${repoRoot}api/src/relay/handler.ts`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: { format: nodejs.OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true },
      memorySize: 512,
      // A narration takes a few seconds; the API waits at most 29.
      timeout: Duration.seconds(28),
      logGroup: new logs.LogGroup(this, 'RelayLogs', {
        retention: prod ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        RELAY_ENV: config.name,
        TABLE_NAME: table.tableName,
        PACKAGES: config.packages.join(','),
        PARAM_DAILY_LIMIT: dailyLimit.parameterName,
        PARAM_MONTHLY_BUDGET: monthlyBudget.parameterName,
        PARAM_MODEL: model.parameterName,
        DEFAULT_MONTHLY_BUDGET_USD: String(config.monthlyBudgetUsd),
        MODELS: JSON.stringify(config.models.map(({ id, profile, price }) => ({ id, profile, price }))),
        DEFAULT_MODEL: config.model,
        ...(installSecret ? { INSTALL_KEY_SECRET_ARN: installSecret.secretArn } : { INSTALL_KEY: randomBytes(32).toString('base64url') }),
        ...(config.integritySecretName ? { INTEGRITY_SECRET_ID: config.integritySecretName } : {}),
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    table.grantReadWriteData(fn);
    dailyLimit.grantRead(fn);
    monthlyBudget.grantRead(fn);
    model.grantRead(fn);
    installSecret?.grantRead(fn);
    if (config.integritySecretName) {
      // Put in by hand (docs/operations/ai-relay.md): it holds a Google private key.
      secrets.Secret.fromSecretNameV2(this, 'IntegrityAccount', config.integritySecretName).grantRead(fn);
    }
    // R-5: the listed models only: in Tokyo, or behind a jp profile in the regions it routes to
    // (Tokyo and Osaka).
    fn.addToRolePolicy(
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

    const api = new apigw.RestApi(this, 'Api', {
      restApiName: `yorisoi-ai-relay-${config.name}`,
      description: 'The operator’s AI relay (platform API-AI-RELAY)',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: { stageName: 'api', throttlingRateLimit: prod ? 100 : 10, throttlingBurstLimit: prod ? 200 : 20 },
      cloudWatchRole: false,
    });
    const integration = new apigw.LambdaIntegration(fn);
    const v1 = api.root.addResource('v1');
    const sessionResource = v1.addResource('session');
    sessionResource.addMethod('POST', integration);
    sessionResource.addResource('challenge').addMethod('POST', integration);
    v1.addResource('quota').addMethod('GET', integration);
    v1.addResource('generate').addMethod('POST', integration);

    if (config.waf) {
      const waf = new wafv2.CfnWebACL(this, 'ApiWaf', {
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `yorisoi-ai-relay-${config.name}`, sampledRequestsEnabled: false },
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

    // ---- what tells the operator (R-10, R-14) ----
    const alarms = new sns.Topic(this, 'Alarms', { displayName: `Yorisoi AI relay (${config.name})` });
    if (config.alarmEmail) alarms.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    const metric = (name: string, statistic: string) =>
      new cloudwatch.Metric({ namespace: 'YorisoiAiRelay', metricName: name, dimensionsMap: { Env: config.name }, statistic, period: Duration.minutes(5) });
    const alarm = (id: string, name: string, statistic: string, threshold: number, description: string) =>
      new cloudwatch.Alarm(this, id, {
        metric: metric(name, statistic),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      }).addAlarmAction(new cwActions.SnsAction(alarms));
    alarm('BudgetNear', 'SpendRatio', 'Maximum', 0.8, 'The month’s spend on the operator’s AI passed 80% of the budget (ADR-AI-RELAY R-10)');
    alarm('Paused', 'RelayPaused', 'Sum', 1, 'The operator’s AI is paused: the month’s budget is used up (ADR-AI-RELAY R-10)');
    alarm('BadSetting', 'InvalidSetting', 'Maximum', 1, 'A relay parameter is not valid; the relay uses 30 calls, the default budget or the default model (ADR-AI-RELAY R-5, R-14)');
    alarm('UpstreamErrors', 'UpstreamError', 'Sum', 10, 'Bedrock failed 10 times in 5 minutes');

    new CfnOutput(this, 'RelayUrl', { value: `${api.url}` });
    new CfnOutput(this, 'DailyLimitParameter', { value: dailyLimit.parameterName });
    new CfnOutput(this, 'MonthlyBudgetParameter', { value: monthlyBudget.parameterName });
    new CfnOutput(this, 'ModelParameter', { value: model.parameterName });
  }
}
