import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';

import type { AppConfig } from '../../src/config.js';
import type { ErrorReporter } from '../../src/shared/logging.js';
import type { Services } from '../../src/services.js';
import { createServices } from '../../src/services.js';
import type { HttpServerHandle } from '../../src/transport/http.js';
import { startHttp } from '../../src/transport/http.js';
import type { Server } from 'node:http';

const handles: { readonly http: HttpServerHandle; readonly services: Services }[] = [];
const mockCatalogs: Server[] = [];
const reporter: ErrorReporter = {
  report(): void {
    // Tests assert HTTP responses; transport errors are not expected here.
  },
};

function testConfig(overrides: Partial<AppConfig['http']> = {}): AppConfig {
  return {
    catalog: {
      allowMutations: false,
      oauth2Credential: undefined,
      oauth2Uri: undefined,
      token: undefined,
      uri: undefined,
      warehouse: undefined,
    },
    http: {
      allowedOrigins: ['http://127.0.0.1'],
      authToken: undefined,
      host: '127.0.0.1',
      maxRequestBytes: 1_048_576,
      port: 0,
      ...overrides,
    },
    javadoc: {
      baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
      version: '1.11.0',
    },
    limits: { maxResponseChars: 30_000, requestTimeoutMs: 15_000 },
    sourceDir: undefined,
    transport: 'http',
  };
}

function withCatalog(config: AppConfig, uri: URL, allowMutations: boolean): AppConfig {
  return {
    ...config,
    catalog: { ...config.catalog, allowMutations, uri },
  };
}

async function startMockCatalog(): Promise<URL> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/v1/config') === true) {
      response.end(
        JSON.stringify({
          defaults: {},
          endpoints: ['GET /v1/{prefix}/namespaces', 'POST /v1/{prefix}/namespaces'],
          overrides: {},
        }),
      );
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/namespaces') === true) {
      response.end(JSON.stringify({ namespaces: [['analytics']], 'next-page-token': null }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: 404, message: 'not found', type: 'NotFound' } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  mockCatalogs.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Mock catalog has no TCP address');
  }
  return new URL(`http://127.0.0.1:${address.port}/`);
}

async function start(config: AppConfig = testConfig()): Promise<HttpServerHandle> {
  const services = await createServices(config);
  const handle = await startHttp({ config, reporter, services }, reporter);
  handles.push({ http: handle, services });
  return handle;
}

async function mcpPost(address: URL, message: object): Promise<Record<string, unknown>> {
  const response = await fetch(address, {
    body: JSON.stringify(message),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      origin: 'http://127.0.0.1',
    },
    method: 'POST',
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine?.slice(6) ?? text) as Record<string, unknown>;
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    handles.splice(0).map(async ({ http, services }) => {
      await http.close();
      await services.close();
    }),
  );
  await Promise.all(
    mockCatalogs.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe('HTTP transport', (): void => {
  it('serves MCP initialization through the current stateless handler', async (): Promise<void> => {
    const handle = await start();
    const response = await fetch(handle.address, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1.0.0' },
          protocolVersion: '2025-11-25',
        },
      }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: 'http://127.0.0.1',
      },
      method: 'POST',
    });
    const responseText = await response.text();
    const dataLine = responseText.split('\n').find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const body = JSON.parse(dataLine?.slice(6) ?? '{}') as {
      result?: { serverInfo?: { name?: string } };
    };

    expect(response.status).toBe(200);
    expect(body.result?.serverInfo?.name).toBe('iceberg-mcp-server');
  });

  it('enforces exact origins and inbound bearer authentication', async (): Promise<void> => {
    const handle = await start(testConfig({ authToken: 'inbound-secret' }));
    const requestBody = JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'ping' });

    const wrongOrigin = await fetch(handle.address, {
      body: requestBody,
      headers: {
        authorization: 'Bearer inbound-secret',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      method: 'POST',
    });
    expect(wrongOrigin.status).toBe(403);

    const missingToken = await fetch(handle.address, {
      body: requestBody,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: 'http://127.0.0.1',
      },
      method: 'POST',
    });
    expect(missingToken.status).toBe(401);
    expect(missingToken.headers.get('www-authenticate')).toBe('Bearer');

    const accepted = await fetch(handle.address, {
      body: requestBody,
      headers: {
        authorization: 'Bearer inbound-secret',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: 'http://127.0.0.1',
      },
      method: 'POST',
    });
    expect(accepted.status).toBe(200);
  });

  it('rejects unbounded, malformed, and unsupported bodies before dispatch', async (): Promise<void> => {
    const handle = await start(testConfig({ maxRequestBytes: 32 }));

    const tooLarge = await fetch(handle.address, {
      body: JSON.stringify({ payload: 'x'.repeat(64) }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(tooLarge.status).toBe(413);

    const malformed = await fetch(handle.address, {
      body: '{',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(malformed.status).toBe(400);

    const unsupported = await fetch(handle.address, {
      body: '{}',
      headers: { 'content-type': 'text/plain' },
      method: 'POST',
    });
    expect(unsupported.status).toBe(415);
  });

  it('does not mount MCP on arbitrary paths', async (): Promise<void> => {
    const handle = await start();
    const response = await fetch(new URL('/not-mcp', handle.address));

    expect(response.status).toBe(404);
  });

  it('advertises typed API tools and calls a documentation-only tool', async (): Promise<void> => {
    const handle = await start();
    const listed = await mcpPost(handle.address, {
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    });
    const listResult = listed['result'] as { tools: { name: string }[] };
    expect(listResult.tools.map((tool) => tool.name)).toContain('iceberg_api_get_type');
    expect(listResult.tools).toHaveLength(9);

    const called = await mcpPost(handle.address, {
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'iceberg_api_list_versions' },
    });
    const callResult = called['result'] as {
      structuredContent: { count: number; items: { kind: string }[] };
    };
    expect(callResult.structuredContent.count).toBe(2);
    expect(callResult.structuredContent.items.map((item) => item.kind)).toEqual([
      'release',
      'nightly',
    ]);
  });

  it('registers only discovered catalog tools and gates mutations', async (): Promise<void> => {
    const catalogUri = await startMockCatalog();
    const readOnlyHandle = await start(withCatalog(testConfig(), catalogUri, false));
    const readOnlyList = await mcpPost(readOnlyHandle.address, {
      id: 4,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    });
    const readOnlyTools = (readOnlyList['result'] as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    );
    expect(readOnlyTools).toContain('iceberg_catalog_get_config');
    expect(readOnlyTools).toContain('iceberg_catalog_list_namespaces');
    expect(readOnlyTools).not.toContain('iceberg_catalog_create_namespace');
    expect(readOnlyTools).not.toContain('iceberg_catalog_list_tables');

    const mutableHandle = await start(withCatalog(testConfig(), catalogUri, true));
    const mutableList = await mcpPost(mutableHandle.address, {
      id: 5,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    });
    const mutableTools = (mutableList['result'] as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    );
    expect(mutableTools).toContain('iceberg_catalog_create_namespace');

    const configCall = await mcpPost(readOnlyHandle.address, {
      id: 6,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'iceberg_catalog_get_config' },
    });
    expect(
      (configCall['result'] as { structuredContent: { operation_id: string } }).structuredContent
        .operation_id,
    ).toBe('getConfig');
  });
});
