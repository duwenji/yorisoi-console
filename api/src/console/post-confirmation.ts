import { AdminAddUserToGroupCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';

const cognito = new CognitoIdentityProviderClient({});

/**
 * Cognito post-confirmation trigger: whoever signs up and confirms their address becomes a
 * publisher (ARCH-001 D-7). Operators are added to the operator group by an administrator only,
 * so no sign-up can reach the operator API.
 */
export async function handler(event: PostConfirmationTriggerEvent) {
  if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: event.userPoolId, Username: event.userName, GroupName: 'publisher' }));
  }
  return event;
}
