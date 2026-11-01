import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type { Notice } from '../console/deps.js';
import { deliver, type NotifyPorts } from './notify.js';

function env(name: string): string {
  return process.env[name] || (() => { throw new Error(`${name} is not set`); })();
}

const cognito = new CognitoIdentityProviderClient({});
const ses = new SESv2Client({});

const ports: NotifyPorts = {
  db: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  table: env('TABLE_NAME'),
  now: () => new Date(),
  consoleUrl: env('CONSOLE_URL'),
  emailOf: async (sub) => {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: sub })).catch(() => undefined);
    const attr = (name: string) => user?.UserAttributes?.find((a) => a.Name === name)?.Value;
    return attr('email_verified') === 'true' ? attr('email') : undefined;
  },
  send: async (mail) => {
    // Development has no sending domain yet (ARCH-001 未決事項 No.1): record what would be sent, without the address or text.
    if (env('NOTIFY_MODE') === 'log') {
      console.log(JSON.stringify({ wouldSend: mail.subject, bodyLength: mail.body.length }));
      return 'log-only';
    }
    const out = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: env('NOTIFY_FROM'),
        Destination: { ToAddresses: [mail.to] },
        Content: { Simple: { Subject: { Data: mail.subject, Charset: 'UTF-8' }, Body: { Text: { Data: mail.body, Charset: 'UTF-8' } } } },
        ...(process.env.SES_CONFIGURATION_SET ? { ConfigurationSetName: process.env.SES_CONFIGURATION_SET } : {}),
      }),
    );
    return out.MessageId ?? '';
  },
};

/** Matches the queue's maxReceiveCount: after this many tries the message goes to the dead-letter queue. */
export const MAX_ATTEMPTS = 3;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const notice = JSON.parse(record.body) as Notice;
      const outcome = await deliver(ports, notice, Number(record.attributes.ApproximateReceiveCount), MAX_ATTEMPTS);
      console.log(JSON.stringify({ noticeId: notice.noticeId, event: notice.event, outcome }));
    } catch (e) {
      console.error(JSON.stringify({ messageId: record.messageId, error: e instanceof Error ? e.message : String(e) }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
