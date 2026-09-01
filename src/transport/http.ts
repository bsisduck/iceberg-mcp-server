import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { isLoopbackHost } from '../config.js';
import type { HttpConfig } from '../config.js';
import type { ServerDependencies } from '../server.js';
import { createIcebergServer } from '../server.js';
import type { ErrorReporter } from '../shared/logging.js';

const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/iu;

export interface HttpServerHandle {
  readonly address: URL;
  close(): Promise<void>;
}

function sendJsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) {
    return false;
  }
  const suppliedDigest = createHash('sha256').update(header.slice(7)).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function exactOriginAllowed(request: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.origin;
  return origin === undefined || (typeof origin === 'string' && allowedOrigins.includes(origin));
}

async function readBoundedJson(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
): Promise<{ accepted: true; value: unknown } | { accepted: false }> {
  const contentType = request.headers['content-type'];
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
    sendJsonRpcError(response, 415, -32_600, 'Content-Type must be application/json');
    return { accepted: false };
  }
  if (request.headers['content-encoding'] !== undefined) {
    sendJsonRpcError(response, 415, -32_600, 'Compressed request bodies are not supported');
    return { accepted: false };
  }
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > maxBytes) {
    request.resume();
    sendJsonRpcError(response, 413, -32_600, 'Request body exceeds the configured limit');
    return { accepted: false };
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      request.resume();
      sendJsonRpcError(response, 413, -32_600, 'Request body exceeds the configured limit');
      return { accepted: false };
    }
    chunks.push(buffer);
  }
  try {
    return { accepted: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  } catch {
    sendJsonRpcError(response, 400, -32_700, 'Parse error');
    return { accepted: false };
  }
}

function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function startHttp(
  dependencies: ServerDependencies,
  reporter: ErrorReporter,
): Promise<HttpServerHandle> {
  const config: HttpConfig = dependencies.config.http;
  const handler = createMcpHandler(() => createIcebergServer(dependencies), {
    legacy: 'stateless',
    onerror(error): void {
      reporter.report(error, 'MCP HTTP handler');
    },
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror(error): void {
      reporter.report(error, 'Node HTTP adapter');
    },
  });
  const loopback = isLoopbackHost(config.host);
  const validateHost = loopback
    ? localhostHostValidation()
    : hostHeaderValidation([
        config.host,
        ...config.allowedOrigins.map((origin) => new URL(origin).hostname),
      ]);
  const validateOrigin = loopback
    ? localhostOriginValidation()
    : originValidation(config.allowedOrigins.map((origin) => new URL(origin).hostname));

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      if (request.method === undefined || request.url === undefined) {
        sendJsonRpcError(response, 400, -32_600, 'Malformed HTTP request');
        return;
      }
      const completeRequest = request as IncomingMessage & { method: string; url: string };
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/mcp') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      if (!validateHost(request, response) || !validateOrigin(request, response)) {
        return;
      }
      if (!exactOriginAllowed(request, config.allowedOrigins)) {
        sendJsonRpcError(response, 403, -32_600, 'Origin is not allowed');
        return;
      }
      if (
        config.authToken !== undefined &&
        !bearerMatches(request.headers.authorization, config.authToken)
      ) {
        response.setHeader('www-authenticate', 'Bearer');
        sendJsonRpcError(response, 401, -32_000, 'Authentication required');
        return;
      }
      if (request.method === 'POST') {
        const body = await readBoundedJson(request, response, config.maxRequestBytes);
        if (!body.accepted) {
          return;
        }
        await nodeHandler(completeRequest, response, body.value);
        return;
      }
      await nodeHandler(completeRequest, response);
    })().catch((error: unknown) => {
      reporter.report(error, 'HTTP request');
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, -32_603, 'Internal error');
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await handler.close();
    await closeNodeServer(server);
    throw new Error('HTTP server did not return a TCP address');
  }
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;

  return {
    address: new URL(`http://${displayHost}:${address.port}/mcp`),
    async close(): Promise<void> {
      await closeNodeServer(server);
      await handler.close();
    },
  };
}
