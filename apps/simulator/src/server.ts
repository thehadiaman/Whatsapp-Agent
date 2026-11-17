import { createServer, type Server } from 'node:http';

/**
 * Phase 0 skeleton. Phase 2 adds the Meta Graph API subset (send message,
 * upload and download media), signed webhook delivery, the customer chat page
 * and fault injection. The HTTP framework choice is made there.
 */
export function createSimulatorServer(): Server {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}
