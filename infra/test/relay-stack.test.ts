import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { relayConfigs } from '../lib/relay-config.js';
import { RelayStack } from '../lib/relay-stack.js';

function template(name: 'dev' | 'prod') {
  // Skip bundling the Lambda code; tests look at the resources, not the bundle.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new RelayStack(app, `Relay-${name}`, { config: relayConfigs[name], env: { region: 'ap-northeast-1', account: '123456789012' } });
  return Template.fromStack(stack);
}

describe('RelayStack', () => {
  const prod = template('prod');
  const dev = template('dev');

  it('calls only the jp profile of Claude Haiku 5.5 (ADR-AI-RELAY R-5)', () => {
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('inference-profile/jp.anthropic.claude-haiku-5-5');
    expect(policies).toContain('foundation-model/anthropic.claude-haiku-5-5');
    expect(policies).not.toMatch(/bedrock:\*|"bedrock:InvokeModel","Resource":"\*"/);
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ MODEL_ID: 'jp.anthropic.claude-haiku-5-5', INTEGRITY_SECRET_ID: 'yorisoi-ai-relay/prod/play-integrity' }) },
    });
  });

  it('keeps the daily limit and the budget in Parameter Store (R-14)', () => {
    prod.hasResourceProperties('AWS::SSM::Parameter', { Name: '/yorisoi-ai-relay/prod/daily-limit', Value: '30' });
    prod.hasResourceProperties('AWS::SSM::Parameter', { Name: '/yorisoi-ai-relay/prod/monthly-budget-usd' });
  });

  it('has the four operations of API-AI-RELAY', () => {
    const methods = Object.values(prod.findResources('AWS::ApiGateway::Method')).map((m) => m.Properties.HttpMethod).sort();
    expect(methods).toEqual(['GET', 'POST', 'POST', 'POST']);
  });

  it('puts WAF and Play Integrity in production only (R-9, AR-4)', () => {
    prod.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    dev.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    const devEnv = JSON.stringify(dev.findResources('AWS::Lambda::Function'));
    expect(devEnv).not.toContain('INTEGRITY_SECRET_ID');
  });

  it('tells the operator about the budget and bad settings', () => {
    for (const name of ['SpendRatio', 'RelayPaused', 'InvalidSetting']) {
      prod.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: name, Namespace: 'YorisoiAiRelay' });
    }
  });
});
