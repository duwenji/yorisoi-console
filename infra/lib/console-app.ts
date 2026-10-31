import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { EnvConfig } from './config.js';
import { logGroupFor } from './common.js';

export interface ConsoleAppProps {
  config: EnvConfig;
  repoRoot: string;
  /** The built SPA (`web/dist`); build it before synthesizing. */
  webDist: string;
  table: dynamodb.ITableV2;
  publisher: lambda.IFunction;
  signingKeys: kms.IKey[];
  /** Where test tickets' packages go (`trial/`) and the public URL in front of it. */
  publicBucket: s3.IBucket;
  providerUrl: string;
  /** Where the machine review keeps the review samples' prompts (`samples/`). */
  recordsBucket: s3.IBucket;
  /** The built machine-review Lambda (`validator/build/lambda/validator.zip`); build it before synthesizing. */
  validatorZip: string;
  /** The operator's alarms (a notice that could not be sent). */
  alarms: sns.ITopic;
}

const lambdaDefaults = (repoRoot: string): Partial<nodejs.NodejsFunctionProps> => ({
  projectRoot: repoRoot,
  depsLockFilePath: `${repoRoot}package-lock.json`,
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  bundling: { format: nodejs.OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true },
});

/**
 * The console the operators (and later the publishers) use: Cognito with managed login,
 * the console API behind API Gateway's JWT authorizer, and the SPA on CloudFront with `/api/*`
 * sent to the API (ADR-001 A-3, A-4, A-18; API-001 C-5, C-7).
 */
export class ConsoleApp extends Construct {
  /** The console API, which also signs test tickets (the stack lets it sign in the key policy). */
  readonly consoleFunction: lambda.IFunction;
  /** The publishers' notices (A-19); the publisher's daily check sends to it too (DES-009 M-7). */
  readonly notifyQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: ConsoleAppProps) {
    super(scope, id);
    const { config, repoRoot } = props;
    const prod = config.name === 'prod';
    const stack = Stack.of(this);
    if (!existsSync(`${props.webDist}/index.html`)) throw new Error(`build the SPA first (npm run build -w web): ${props.webDist}`);
    if (!existsSync(props.validatorZip)) throw new Error(`build the machine review first (cd validator && ./gradlew build): ${props.validatorZip}`);

    // ---- Cognito (ADR-001 A-4: one pool, TOTP MFA for everyone) ----
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `yorisoi-console-${config.name}`,
      // Publishers register themselves (D-7); operators are created by an administrator.
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      userVerification: {
        emailSubject: 'SanpoGuide チャンネル管理システムの確認コード',
        emailBody: 'SanpoGuide チャンネル管理システムの確認コードは {####} です。',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
    });
    new cognito.UserPoolGroup(this, 'OperatorGroup', { userPool, groupName: 'operator', precedence: 0, description: 'Operators (added by an administrator only)' });
    new cognito.UserPoolGroup(this, 'PublisherGroup', { userPool, groupName: 'publisher', precedence: 10, description: 'Publishers (added on sign-up)' });

    // Everyone who signs up is a publisher; operators are never made this way.
    const postConfirmation = new nodejs.NodejsFunction(this, 'PostConfirmation', {
      ...lambdaDefaults(repoRoot),
      ...logGroupFor(this, 'PostConfirmationLogs', config),
      entry: `${repoRoot}api/src/console/post-confirmation.ts`,
      memorySize: 256,
      timeout: Duration.seconds(10),
    });
    // A wildcard avoids a cycle between the pool (which names the trigger) and the trigger's policy.
    postConfirmation.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminAddUserToGroup'],
        resources: [`arn:${stack.partition}:cognito-idp:${stack.region}:${stack.account}:userpool/*`],
      }),
    );
    userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postConfirmation);

    const domain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `yorisoi-console-${config.name}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // A-18: limit sign-up and sign-in attempts per source address (production; about 7 USD a month).
    if (config.cost.waf) {
    const waf = new wafv2.CfnWebACL(this, 'UserPoolWaf', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `yorisoi-console-${config.name}-cognito`, sampledRequestsEnabled: true },
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 300, evaluationWindowSec: 300, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp', sampledRequestsEnabled: true },
        },
        {
          name: 'AmazonIpReputation',
          priority: 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'AmazonIpReputation', sampledRequestsEnabled: true },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'UserPoolWafAssociation', { resourceArn: userPool.userPoolArn, webAclArn: waf.attrArn });
    }

    // ---- uploads (API-001 C-10, DM-001 M-4) ----
    // Packages and icons go straight from the browser with presigned POSTs. Nothing here is public.
    // CORS allows any origin: a POST still needs the presigned policy, and naming the console's own
    // origin here would make a cycle (bucket → distribution → headers policy → bucket).
    const intakeBucket = new s3.Bucket(this, 'IntakeBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !prod,
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 3600 }],
      lifecycleRules: [
        // Settled submissions are kept 90 days (DM-001 M-4); uploads that never got a result go after 30.
        { prefix: 'archive/', expiration: Duration.days(90) },
        { prefix: 'intake/', expiration: Duration.days(30) },
        // Collections the same way, under their own prefixes (DM-001: their ids may equal a channel's).
        { prefix: 'archive-col/', expiration: Duration.days(90) },
        { prefix: 'intake-col/', expiration: Duration.days(30) },
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });

    // ---- the SPA's distribution, also fronting the API (API-001 C-5) ----
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const consoleFn = new nodejs.NodejsFunction(this, 'ConsoleApi', {
      ...lambdaDefaults(repoRoot),
      ...logGroupFor(this, 'ConsoleApiLogs', config),
      entry: `${repoRoot}api/src/console/handler.ts`,
      memorySize: 512,
      timeout: Duration.seconds(15),
    });
    // API-001 C-9. Development passes a key made at synthesis instead of paying for a secret.
    const cursorSecret =
      config.cost.cursorKey === 'secret'
        ? new secrets.Secret(this, 'CursorSecret', {
            description: 'Key material for opaque list cursors (API-001 C-9)',
            generateSecretString: { passwordLength: 64, excludePunctuation: true },
            removalPolicy: RemovalPolicy.DESTROY,
          })
        : undefined;

    const httpApi = new apigw.HttpApi(this, 'HttpApi', { apiName: `yorisoi-console-${config.name}`, createDefaultStage: true });
    const stage = httpApi.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };

    const authDomain = `${domain.domainName}.auth.${stack.region}.amazoncognito.com`;
    const issuer = `https://cognito-idp.${stack.region}.${stack.urlSuffix}/${userPool.userPoolId}`;

    // The studio stack's names (DES-013 K-2): it is deployed before the console.
    const studioParam = (name: string) => ssm.StringParameter.valueForStringParameter(this, `/yorisoi-studio/${config.name}/${name}`);
    const studio = config.studio
      ? { table: studioParam('table-name'), intake: studioParam('intake-bucket'), check: studioParam('check-function') }
      : undefined;
    const studioIntake = studio ? ` https://${studio.intake}.s3.${stack.region}.${stack.urlSuffix}` : '';

    // Security headers for the SPA; the CSP allows only this origin and Cognito (aws-auth).
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'ConsoleHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            // The icon of a submission under review comes from a presigned URL on the intake bucket.
            `img-src 'self' data: https://${intakeBucket.bucketRegionalDomainName}`,
            // The review samples call the AI from the browser with the operator's key (ADR-001 D-4, DES-005).
            `connect-src 'self' https://${authDomain} https://cognito-idp.${stack.region}.${stack.urlSuffix} https://${intakeBucket.bucketRegionalDomainName}${studioIntake} https://api.openai.com https://api.deepseek.com`,
            `form-action 'self' https://${authDomain}`,
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "object-src 'none'",
          ].join('; '),
        },
        strictTransportSecurity: { override: true, accessControlMaxAge: Duration.days(365), includeSubdomains: true },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER },
      },
    });
    const consoleDistribution = new cloudfront.Distribution(this, 'ConsoleDistribution', {
      comment: `SanpoGuide channel console (${config.name})`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            // Paths without a file extension are routes of the SPA.
            function: new cloudfront.Function(this, 'SpaRoutes', {
              code: cloudfront.FunctionCode.fromInline(
                "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }",
              ),
              runtime: cloudfront.FunctionRuntime.JS_2_0,
            }),
          },
        ],
      },
      additionalBehaviors: {
        'api/*': {
          origin: new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    const consoleUrl = `https://${consoleDistribution.distributionDomainName}`;

    // A public client: no secret, authorization code with PKCE (aws-auth: never a secret on an SPA).
    const client = userPool.addClient('WebClient', {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${consoleUrl}/callback`, ...(prod ? [] : ['http://localhost:5173/callback'])],
        logoutUrls: [`${consoleUrl}/`, ...(prod ? [] : ['http://localhost:5173/'])],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.hours(12),
      refreshTokenRotationGracePeriod: Duration.seconds(10),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });
    // Managed login v2 needs a branding style per client, or the login page is broken (aws-auth).
    const branding = new cognito.CfnManagedLoginBranding(this, 'LoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(domain);

    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration('ConsoleIntegration', consoleFn),
      authorizer: new authorizers.HttpJwtAuthorizer('Jwt', issuer, { jwtAudience: [client.userPoolClientId] }),
    });

    consoleFn.addEnvironment('TABLE_NAME', props.table.tableName);
    consoleFn.addEnvironment('PUBLISH_FUNCTION', props.publisher.functionName);
    consoleFn.addEnvironment('ROOT_PUBLIC_KEY', config.rootPublicKey);
    if (cursorSecret) {
      consoleFn.addEnvironment('CURSOR_SECRET_ARN', cursorSecret.secretArn);
      cursorSecret.grantRead(consoleFn);
    } else {
      consoleFn.addEnvironment('CURSOR_KEY', randomBytes(32).toString('base64url'));
    }
    consoleFn.addEnvironment('INTAKE_BUCKET', intakeBucket.bucketName);
    consoleFn.addEnvironment('PUBLIC_BUCKET', props.publicBucket.bucketName);
    consoleFn.addEnvironment('PROVIDER_URL', props.providerUrl);
    consoleFn.addEnvironment('RECORDS_BUCKET', props.recordsBucket.bucketName);
    consoleFn.addEnvironment('APP_STAGE_VERSIONS', JSON.stringify(config.appStageVersions));
    // Review (stage 3c): read the samples' prompts, keep the samples, publish approved files.
    props.recordsBucket.grantRead(consoleFn, 'samples/*');
    props.recordsBucket.grantReadWrite(consoleFn, 'reviews/*');
    props.publicBucket.grantPut(consoleFn, 'pkg/*');
    props.publicBucket.grantPut(consoleFn, 'icons/*');
    // Test tickets: the package is copied to trial/ (gone after 7 days), from intake/ or archive/.
    props.publicBucket.grantPut(consoleFn, 'trial/*');
    intakeBucket.grantRead(consoleFn, 'archive/*');
    consoleFn.addEnvironment('USER_POOL_ID', userPool.userPoolId);
    consoleFn.addEnvironment('NODE_OPTIONS', '--enable-source-maps');
    // Presigning needs the right to put; moving to archive/ needs read, put and delete.
    intakeBucket.grantPut(consoleFn, 'intake/*');
    intakeBucket.grantRead(consoleFn, 'intake/*');
    intakeBucket.grantDelete(consoleFn, 'intake/*');
    intakeBucket.grantPut(consoleFn, 'archive/*');
    // Collections (DES-008): their own prefixes, and approved packages under col/ (DM-001).
    intakeBucket.grantPut(consoleFn, 'intake-col/*');
    intakeBucket.grantRead(consoleFn, 'intake-col/*');
    intakeBucket.grantDelete(consoleFn, 'intake-col/*');
    intakeBucket.grantPut(consoleFn, 'archive-col/*');
    intakeBucket.grantRead(consoleFn, 'archive-col/*');
    props.publicBucket.grantPut(consoleFn, 'col/*');
    // Leaving deletes the user (API-001 C-4).
    consoleFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminDeleteUser'], resources: [userPool.userPoolArn] }));
    props.table.grantReadWriteData(consoleFn);
    if (studio) {
      consoleFn.addEnvironment('STUDIO_TABLE', studio.table);
      consoleFn.addEnvironment('STUDIO_INTAKE_BUCKET', studio.intake);
      consoleFn.addEnvironment('STUDIO_CHECK_FUNCTION', studio.check);
      const tableArn = `arn:${stack.partition}:dynamodb:${stack.region}:${stack.account}:table/${studio.table}`;
      consoleFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem'],
          resources: [tableArn, `${tableArn}/index/*`],
        }),
      );
      // Presigning the audio's POST needs the right to put it (K-16).
      consoleFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [`arn:${stack.partition}:s3:::${studio.intake}/uploads/*`] }));
      consoleFn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [`arn:${stack.partition}:lambda:${stack.region}:${stack.account}:function:${studio.check}`] }),
      );
    }
    props.publisher.grantInvoke(consoleFn);
    for (const key of props.signingKeys) key.grant(consoleFn, 'kms:GetPublicKey', 'kms:DescribeKey');
    // Registering a signing key reads any KMS key the operator names, in this account only.
    consoleFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['kms:GetPublicKey'], resources: [`arn:${stack.partition}:kms:${stack.region}:${stack.account}:key/*`] }),
    );

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      destinationBucket: webBucket,
      sources: [
        s3deploy.Source.asset(props.webDist),
        // Read by the SPA at start-up, so one build serves every environment.
        s3deploy.Source.jsonData('config.json', {
          authority: issuer,
          clientId: client.userPoolClientId,
          authDomain: `https://${authDomain}`,
          environment: config.name,
        }),
      ],
      distribution: consoleDistribution,
      distributionPaths: ['/index.html', '/config.json'],
      prune: true,
    });

    this.consoleFunction = consoleFn;

    // ---- the machine review (ADR-001 A-11) ----
    const validator = new lambda.Function(this, 'MachineReview', {
      runtime: lambda.Runtime.JAVA_21,
      architecture: lambda.Architecture.ARM_64,
      handler: 'console.validator.Handler::handleRequest',
      code: lambda.Code.fromAsset(props.validatorZip),
      memorySize: 1536,
      // A collection's outside resources are read within 10 minutes (DES-007 J-5).
      timeout: Duration.minutes(15),
      ...logGroupFor(this, 'MachineReviewLogs', config),
      environment: {
        TABLE_NAME: props.table.tableName,
        INTAKE_BUCKET: intakeBucket.bucketName,
        RECORDS_BUCKET: props.recordsBucket.bucketName,
        PUBLIC_BUCKET: props.publicBucket.bucketName,
        JAVA_TOOL_OPTIONS: '-XX:+TieredCompilation -XX:TieredStopAtLevel=1',
      },
    });
    props.table.grantReadWriteData(validator);
    intakeBucket.grantRead(validator, 'intake/*');
    intakeBucket.grantDelete(validator, 'intake/*');
    intakeBucket.grantPut(validator, 'archive/*');
    props.recordsBucket.grantPut(validator, 'samples/*');
    intakeBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(validator), { prefix: 'intake/' });
    // Collections (DES-007 J-2・J-3): their packages, and the listed ones a channel's review resolves against.
    intakeBucket.grantRead(validator, 'intake-col/*');
    intakeBucket.grantDelete(validator, 'intake-col/*');
    intakeBucket.grantPut(validator, 'archive-col/*');
    props.publicBucket.grantRead(validator, 'col/*');
    intakeBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(validator), { prefix: 'intake-col/' });

    // ---- the publishers' emails (ADR-001 A-19, API-001 C-14) ----
    const deadNotices = new sqs.Queue(this, 'NotifyDeadLetters', { retentionPeriod: Duration.days(14), enforceSSL: true });
    const notices = new sqs.Queue(this, 'NotifyQueue', {
      visibilityTimeout: Duration.minutes(2),
      deadLetterQueue: { queue: deadNotices, maxReceiveCount: 3 }, // the notifier's MAX_ATTEMPTS
      enforceSSL: true,
    });
    notices.grantSendMessages(consoleFn);
    this.notifyQueue = notices;
    consoleFn.addEnvironment('NOTIFY_QUEUE_URL', notices.queueUrl);
    const notifier = new nodejs.NodejsFunction(this, 'Notify', {
      ...lambdaDefaults(repoRoot),
      ...logGroupFor(this, 'NotifyLogs', config),
      entry: `${repoRoot}api/src/notify/handler.ts`,
      memorySize: 256,
      timeout: Duration.seconds(20),
      environment: {
        TABLE_NAME: props.table.tableName,
        USER_POOL_ID: userPool.userPoolId,
        CONSOLE_URL: consoleUrl,
        NOTIFY_MODE: config.notify.mode,
        ...(config.notify.mode === 'ses'
          ? { NOTIFY_FROM: config.notify.from, ...(config.notify.configurationSet ? { SES_CONFIGURATION_SET: config.notify.configurationSet } : {}) }
          : {}),
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    notifier.addEventSource(new SqsEventSource(notices, { batchSize: 10, reportBatchItemFailures: true }));
    props.table.grantReadWriteData(notifier);
    notifier.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminGetUser'], resources: [userPool.userPoolArn] }));
    if (config.notify.mode === 'ses') {
      const domainName = config.notify.from.split('@')[1]!;
      notifier.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: [
            `arn:${stack.partition}:ses:${stack.region}:${stack.account}:identity/${domainName}`,
            ...(config.notify.configurationSet ? [`arn:${stack.partition}:ses:${stack.region}:${stack.account}:configuration-set/${config.notify.configurationSet}`] : []),
          ],
        }),
      );
    }
    new cloudwatch.Alarm(this, 'NoticesNotSent', {
      metric: deadNotices.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A publisher notice could not be sent after retries (dead-letter queue)',
    }).addAlarmAction(new cwActions.SnsAction(props.alarms));

    new CfnOutput(stack, 'ConsoleUrl', { value: consoleUrl });
    new CfnOutput(stack, 'IntakeBucketName', { value: intakeBucket.bucketName });
    new CfnOutput(stack, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(stack, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(stack, 'LoginDomain', { value: `https://${authDomain}` });
  }
}
