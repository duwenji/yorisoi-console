import { Annotations, CfnOutput, RemovalPolicy, Stack, TimeZone, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import type { TilesConfig } from './tiles-config.js';

const tilesDir = fileURLToPath(new URL('../../tiles/', import.meta.url));

export interface TilesStackProps extends StackProps {
  config: TilesConfig;
}

/**
 * The operator's spot tiles (platform API-SPOT-TILES S-6, S-7): a stack of its own, apart from the
 * console and the AI relay. A bucket served by CloudFront without access logs (S-12), and a weekly
 * Fargate task that makes the tiles from Geofabrik's extract of Japan and puts the changed ones in
 * the bucket (`tiles/`).
 */
export class TilesStack extends Stack {
  constructor(scope: Construct, id: string, props: TilesStackProps) {
    super(scope, id, props);
    const { config } = props;

    const bucket = new s3.Bucket(this, 'Tiles', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.retainTiles ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.retainTiles,
    });

    // LIST lets S3 answer 404 for a tile outside the range, as API-SPOT-TILES asks, not 403.
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: `Yorisoi spot tiles (${config.name})`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
          originAccessLevels: [cloudfront.AccessLevel.READ, cloudfront.AccessLevel.LIST],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // The bucket's root would list its keys; show the license there instead.
      defaultRootObject: 'LICENSE.txt',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      enableLogging: false,
    });
    Annotations.of(distribution).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:listBucketSecurityRisk',
      'The root shows LICENSE.txt; the keys are the tiles, all public',
    );

    // ---- the weekly batch ----
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const securityGroup = new ec2.SecurityGroup(this, 'BatchSecurityGroup', { vpc, description: 'The spot tiles batch: out only', allowAllOutbound: true });
    const task = new ecs.FargateTaskDefinition(this, 'Batch', {
      cpu: config.cpu,
      memoryLimitMiB: config.memoryMiB,
      ephemeralStorageGiB: config.diskGiB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    task.addContainer('make', {
      // Built for x86-64 Fargate, whatever machine deploys it.
      image: ecs.ContainerImage.fromAsset(tilesDir, { platform: ecrAssets.Platform.LINUX_AMD64 }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'tiles',
        logGroup: new logs.LogGroup(this, 'BatchLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      }),
      environment: { BUCKET: bucket.bucketName, DISTRIBUTION_ID: distribution.distributionId },
    });
    bucket.grantReadWrite(task.taskRole);
    bucket.grantDelete(task.taskRole);
    task.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
      }),
    );

    new scheduler.Schedule(this, 'Weekly', {
      description: 'Make the spot tiles from the week’s OpenStreetMap (API-SPOT-TILES S-5)',
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: config.schedule.hour, weekDay: config.schedule.weekDay, timeZone: TimeZone.ASIA_TOKYO }),
      target: new schedulerTargets.EcsRunFargateTask(cluster, {
        taskDefinition: task,
        assignPublicIp: true,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [securityGroup],
      }),
    });

    // A batch that fails, or refuses to publish because the tiles dropped (exit 2), tells the operator.
    const alarms = new sns.Topic(this, 'Alarms', { displayName: `Yorisoi spot tiles (${config.name})` });
    if (config.alarmEmail) alarms.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    new events.Rule(this, 'BatchFailed', {
      description: 'The spot tiles batch stopped with an error; the previous tiles stay',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [cluster.clusterArn],
          lastStatus: ['STOPPED'],
          containers: { exitCode: [{ 'anything-but': 0 }] },
        },
      },
      targets: [new eventTargets.SnsTopic(alarms)],
    });

    new CfnOutput(this, 'TilesUrl', { value: `https://${distribution.distributionDomainName}/` });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'TaskDefinition', { value: task.taskDefinitionArn });
    new CfnOutput(this, 'Subnets', { value: vpc.publicSubnets.map((s) => s.subnetId).join(',') });
    new CfnOutput(this, 'SecurityGroup', { value: securityGroup.securityGroupId });
  }
}
