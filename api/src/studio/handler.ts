import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { awsPorts } from './aws.js';
import { block, blocks, cells, deleteNote, myNotes, placeNote, reactions, report, StudioError, terms, unblock, type StudioPorts } from './studio.js';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...HEADERS },
  body: JSON.stringify(body),
});
const empty = (statusCode: number): APIGatewayProxyResult => ({ statusCode, headers: HEADERS, body: '' });

/** RFC 9457 with the API-STUDIO `code`, and `until` or `resetsAt` when there is one. */
function problem(e: StudioError): APIGatewayProxyResult {
  return {
    statusCode: e.status,
    headers: { 'content-type': 'application/problem+json', ...HEADERS, ...(e.code === 'too_many_requests' ? { 'retry-after': '60' } : {}) },
    body: JSON.stringify({ type: 'about:blank', title: e.message, status: e.status, code: e.code, ...e.extra }),
  };
}

function parse(body: string | null): unknown {
  try {
    return JSON.parse(body ?? '');
  } catch {
    throw new StudioError('invalid_request', 'The body must be JSON');
  }
}

/** Routes one request; `ports` is passed in by the tests. */
export async function route(event: APIGatewayProxyEvent, ports: StudioPorts): Promise<APIGatewayProxyResult> {
  const auth = event.headers.Authorization ?? event.headers.authorization;
  const id = event.pathParameters?.id;
  try {
    switch (`${event.httpMethod} ${event.resource}`) {
      case 'GET /v1/studio/cells':
        return json(200, await cells(ports, auth, event.queryStringParameters ?? {}));
      case 'POST /v1/studio/notes':
        return json(201, await placeNote(ports, auth, parse(event.body)));
      case 'GET /v1/studio/notes/mine':
        return json(200, await myNotes(ports, auth));
      case 'DELETE /v1/studio/notes/{id}':
        await deleteNote(ports, auth, id);
        return empty(204);
      case 'POST /v1/studio/reactions':
        await reactions(ports, auth, parse(event.body));
        return empty(202);
      case 'POST /v1/studio/reports':
        await report(ports, auth, parse(event.body));
        return empty(202);
      case 'POST /v1/studio/blocks':
        return json(201, await block(ports, auth, parse(event.body)));
      case 'GET /v1/studio/blocks':
        return json(200, await blocks(ports, auth));
      case 'DELETE /v1/studio/blocks/{id}':
        await unblock(ports, auth, id);
        return empty(204);
      case 'GET /v1/studio/terms':
        return json(200, await terms(ports));
      default:
        throw new StudioError('invalid_request', 'Unknown operation');
    }
  } catch (e) {
    if (e instanceof StudioError) return problem(e);
    // AWS's services failing: the walk and the narration go on without the studio (API-STUDIO エラー表).
    console.error(JSON.stringify({ event: 'error', error: (e as Error)?.name, message: (e as Error)?.message }));
    return problem(new StudioError('upstream_error', 'A service the studio depends on failed'));
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return route(event, await awsPorts());
}
