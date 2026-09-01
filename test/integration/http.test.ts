import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/config.js';
import type { ErrorReporter } from '../../src/shared/logging.js';
import type { HttpServerHandle } from '../../src/transport/http.js';
import { startHttp } from '../../src/transport/http.js';

const handles: HttpServerHandle[] = [];
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

async function start(config: AppConfig = testConfig()): Promise<HttpServerHandle> {
  const handle = await startHttp({ config }, reporter);
  handles.push(handle);
  return handle;
}

afterEach(async (): Promise<void> => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
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
});
