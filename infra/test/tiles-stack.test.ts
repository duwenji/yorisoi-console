import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { tilesConfigs } from '../lib/tiles-config.js';
import { TilesStack } from '../lib/tiles-stack.js';

function template(name: 'dev' | 'prod') {
  // Skip building the image; tests look at the resources.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TilesStack(app, `Tiles-${name}`, { config: tilesConfigs[name], env: { region: 'ap-northeast-1', account: '123456789012' } });
  return Template.fromStack(stack);
}

describe('TilesStack', () => {
  const prod = template('prod');
  const dev = template('dev');

  it('serves a private bucket through CloudFront, without access logs (ADR-SPOT-TILES S-7, S-12)', () => {
    prod.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    prod.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'LICENSE.txt',
        Logging: Match.absent(),
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'https-only', AllowedMethods: ['GET', 'HEAD'] }),
      }),
    });
  });

  it('lets CloudFront list the bucket, so a tile outside the range is 404 (API-SPOT-TILES)', () => {
    const policy = JSON.stringify(prod.findResources('AWS::S3::BucketPolicy'));
    expect(policy).toContain('s3:ListBucket');
    expect(policy).toContain('cloudfront.amazonaws.com');
  });

  it('runs the batch every Wednesday at 3:00 in Japan, on Fargate (S-5, S-6)', () => {
    prod.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 3 ? * WED *)',
      ScheduleExpressionTimezone: 'Asia/Tokyo',
      Target: Match.objectLike({ EcsParameters: Match.objectLike({ LaunchType: 'FARGATE' }) }),
    });
    prod.hasResourceProperties('AWS::ECS::TaskDefinition', { Cpu: '4096', Memory: '16384', EphemeralStorage: { SizeInGiB: 40 } });
  });

  it('may invalidate its own distribution only', () => {
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('cloudfront:CreateInvalidation');
    expect(policies).not.toMatch(/"cloudfront:CreateInvalidation","Resource":"\*"/);
  });

  it('tells the operator when the batch fails', () => {
    prod.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ source: ['aws.ecs'], detail: Match.objectLike({ lastStatus: ['STOPPED'] }) }),
    });
    dev.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email' });
  });

  it('keeps production tiles, and deletes development ones with the stack', () => {
    prod.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    dev.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  });

  it('pays for no NAT gateway', () => {
    expect(Object.keys(prod.findResources('AWS::EC2::NatGateway'))).toHaveLength(0);
  });
});
