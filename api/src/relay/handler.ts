import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { awsPorts } from './aws.js';
import { challenge, generate, quota, RelayError, session, type RelayPorts } from './relay.js';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const ok = (body: unknown): APIGatewayProxyResult => ({ statusCode: 200, headers: { 'content-type': 'application/json', ...HEADERS }, body: JSON.stringify(body) });

/** RFC 9457 with the API-AI-RELAY `code`, and the quota when there is one. */
function problem(e: RelayError): APIGatewayProxyResult {
  return {
    statusCode: e.status,
    headers: { 'content-type': 'application/problem+json', ...HEADERS },
    body: JSON.stringify({ type: 'about:blank', title: e.message, status: e.status, code: e.code, ...(e.quota ? { quota: e.quota } : {}) }),
  };
}

function parse(body: string | null): unknown {
  try {
    return JSON.parse(body ?? '');
  } catch {
    throw new RelayError('invalid_request', 'The body must be JSON');
  }
}

/** Routes one request; `ports` is passed in by the tests. */
export async function route(event: APIGatewayProxyEvent, ports: RelayPorts): Promise<APIGatewayProxyResult> {
  const auth = event.headers.Authorization ?? event.headers.authorization;
  try {
    switch (`${event.httpMethod} ${event.resource}`) {
      case 'POST /v1/session/challenge':
        return ok(await challenge(ports));
      case 'POST /v1/session':
        return ok(await session(ports, parse(event.body)));
      case 'GET /v1/quota':
        return ok(await quota(ports, auth));
      case 'POST /v1/generate':
        return ok(await generate(ports, auth, parse(event.body)));
      default:
        throw new RelayError('invalid_request', 'Unknown operation');
    }
  } catch (e) {
    if (e instanceof RelayError) return problem(e);
    // Google's or AWS's services failing: the app goes on with its set phrases (API-AI-RELAY エラー表).
    console.error(JSON.stringify({ event: 'error', error: (e as Error)?.name, message: (e as Error)?.message }));
    return problem(new RelayError('upstream_error', 'A service the relay depends on failed'));
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return route(event, await awsPorts());
}
