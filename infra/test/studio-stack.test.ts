import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { studioConfigs } from '../lib/studio-config.js';
import { StudioStack } from '../lib/studio-stack.js';

function template(name: 'dev' | 'prod') {
  // Skip bundling the Lambda code; tests look at the resources, not the bundle.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new StudioStack(app, `Studio-${name}`, { config: studioConfigs[name], env: { region: 'ap-northeast-1', account: '123456789012' } });
  return Template.fromStack(stack);
}

describe('StudioStack', () => {
  const prod = template('prod');
  const dev = template('dev');

  it('has the ten operations of API-STUDIO', () => {
    const methods = Object.values(prod.findResources('AWS::ApiGateway::Method')).map((m) => m.Properties.HttpMethod).sort();
    expect(methods).toEqual(['DELETE', 'DELETE', 'GET', 'GET', 'GET', 'GET', 'POST', 'POST', 'POST', 'POST']);
  });

  it('reads only tokens and the month’s spend in the relay’s table (DES-013 K-3)', () => {
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('"dynamodb:LeadingKeys":["TOKEN#*","SPEND"]');
    expect(policies).toContain('parameter/yorisoi-ai-relay/prod/model');
    expect(policies).toContain('parameter/yorisoi-ai-relay/prod/monthly-budget-usd');
    expect(policies).not.toMatch(/bedrock:\*|"bedrock:InvokeModel","Resource":"\*"/);
  });

  it('serves only the checked audio, never the intake (K-5)', () => {
    prod.resourceCountIs('AWS::CloudFront::Distribution', 1);
    prod.resourceCountIs('AWS::S3::Bucket', 2);
    prod.hasResourceProperties('AWS::S3::Bucket', { LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: 'uploads/', ExpirationInDays: 1 })]) } });
    const policies = JSON.stringify(prod.findResources('AWS::S3::BucketPolicy'));
    expect(policies.match(/cloudfront\.amazonaws\.com/g)).toHaveLength(1);
  });

  it('keeps the terms’ version and the pause in Parameter Store, and hands its names to the console (K-2, K-19)', () => {
    for (const name of ['terms-version', 'terms-url', 'terms-updated-at', 'paused', 'table-name', 'intake-bucket', 'audio-bucket']) {
      prod.hasResourceProperties('AWS::SSM::Parameter', { Name: `/yorisoi-studio/prod/${name}` });
    }
  });

  it('checks placements with Transcribe and hears back only about its own jobs (K-11)', () => {
    prod.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { source: ['aws.transcribe'], 'detail-type': ['Transcribe Job State Change'], detail: { TranscriptionJobName: [{ prefix: 'studio-prod-' }] } },
    });
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('transcribe:StartTranscriptionJob');
    expect(policies.match(/"dynamodb:LeadingKeys":\["TOKEN#\*","SPEND"\]/g)).toHaveLength(2);
    prod.hasResourceProperties('AWS::SSM::Parameter', { Name: '/yorisoi-studio/prod/check-function' });
    prod.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: 'held/', ExpirationInDays: 30 })]) },
    });
  });

  it('puts WAF and kept data on production only', () => {
    prod.resourceCountIs('AWS::WAFv2::WebACL', 1);
    dev.resourceCountIs('AWS::WAFv2::WebACL', 0);
    prod.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
    dev.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
  });
});
