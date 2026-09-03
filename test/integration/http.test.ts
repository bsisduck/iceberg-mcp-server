import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/config.js';
import type { ErrorReporter } from '../../src/shared/logging.js';
import type { Services } from '../../src/services.js';
import { Secret } from '../../src/shared/secret.js';
import { createServices } from '../../src/services.js';
import type { HttpServerHandle } from '../../src/transport/http.js';
import { startHttp } from '../../src/transport/http.js';
import type { Server } from 'node:http';

const handles: { readonly http: HttpServerHandle; readonly services: Services }[] = [];
const mockCatalogs: Server[] = [];
const temporaryDirectories: string[] = [];
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
    logLevel: 'info',
    sourceDir: undefined,
    sourceIndexMaxBytes: 64_000_000,
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
          endpoints: [
            'GET /v1/{prefix}/namespaces',
            'POST /v1/{prefix}/namespaces',
            'DELETE /v1/{prefix}/namespaces/{namespace}',
          ],
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

async function startMockJavadoc(): Promise<URL> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname.endsWith('/package-search-index.js')) {
      response.setHeader('content-type', 'application/javascript');
      response.end('packageSearchIndex = [{"l":"org.apache.iceberg"}];updateSearchResults();');
      return;
    }
    if (pathname.endsWith('/type-search-index.js')) {
      response.setHeader('content-type', 'application/javascript');
      response.end(
        'typeSearchIndex = [{"p":"org.apache.iceberg","l":"Table"}];updateSearchResults();',
      );
      return;
    }
    if (pathname.endsWith('/member-search-index.js')) {
      response.setHeader('content-type', 'application/javascript');
      response.end(
        'memberSearchIndex = [{"p":"org.apache.iceberg","c":"Table","l":"schema()"}];updateSearchResults();',
      );
      return;
    }
    if (pathname.endsWith('/org/apache/iceberg/Table.html')) {
      response.setHeader('content-type', 'text/html');
      response.end(`
        <main><h1 class="title">Interface Table</h1>
        <section class="class-description"><div class="block">Access metadata.</div></section>
        <section class="detail" id="schema()"><h3>schema</h3>
        <div class="member-signature">Schema schema()</div></section></main>`);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
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
    throw new Error('Mock Javadoc server has no TCP address');
  }
  return new URL(`http://127.0.0.1:${address.port}/javadoc/`);
}

async function startMockSourceCheckout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'iceberg-http-source-test-'));
  temporaryDirectories.push(root);
  const api = path.join(root, 'api', 'src', 'main', 'java', 'org', 'apache', 'iceberg');
  const core = path.join(root, 'core', 'src', 'main', 'java', 'org', 'apache', 'iceberg');
  await mkdir(api, { recursive: true });
  await mkdir(core, { recursive: true });
  await writeFile(
    path.join(api, 'Table.java'),
    'package org.apache.iceberg; public interface Table { String marker = "search-marker"; }',
  );
  await writeFile(
    path.join(core, 'BaseTable.java'),
    'package org.apache.iceberg; public final class BaseTable implements Table {}',
  );
  return root;
}

async function start(config: AppConfig = testConfig()): Promise<HttpServerHandle> {
  const services = await createServices(config);
  const handle = await startHttp({ config, reporter, services }, reporter);
  handles.push({ http: handle, services });
  return handle;
}

async function mcpPost(
  address: URL,
  message: object,
  protocolVersion?: string,
): Promise<Record<string, unknown>> {
  const method = (message as { method?: unknown }).method;
  const response = await fetch(address, {
    body: JSON.stringify(message),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      origin: 'http://127.0.0.1',
      ...(protocolVersion === undefined
        ? {}
        : {
            'mcp-method': typeof method === 'string' ? method : '',
            'mcp-protocol-version': protocolVersion,
          }),
    },
    method: 'POST',
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
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
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
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
  it('serves the 2026-07-28 per-request envelope and discovery handshake', async (): Promise<void> => {
    const handle = await start();
    const envelope = {
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'modern-integration-test', version: '1.0.0' },
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    };
    const discovered = await mcpPost(
      handle.address,
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'server/discover',
        params: { _meta: envelope },
      },
      '2026-07-28',
    );

    expect(discovered['error']).toBeUndefined();
    expect(JSON.stringify(discovered['result'])).toContain('iceberg-mcp-server');

    const listed = await mcpPost(
      handle.address,
      {
        id: 2,
        jsonrpc: '2.0',
        method: 'tools/list',
        params: { _meta: envelope },
      },
      '2026-07-28',
    );
    expect((listed['result'] as { tools: unknown[] }).tools).toHaveLength(9);
  });

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
    const handle = await start(testConfig({ authToken: new Secret('inbound-secret') }));
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
    expect(accepted.headers.get('cache-control')).toContain('no-cache');
    expect(accepted.headers.get('x-content-type-options')).toBe('nosniff');
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
    const listResult = listed['result'] as {
      tools: {
        annotations?: {
          destructiveHint?: boolean;
          openWorldHint?: boolean;
          readOnlyHint?: boolean;
        };
        inputSchema?: { additionalProperties?: boolean; type?: string };
        name: string;
        outputSchema?: unknown;
      }[];
    };
    expect(listResult.tools.map((tool) => tool.name)).toContain('iceberg_api_get_type');
    expect(listResult.tools).toHaveLength(9);
    const getType = listResult.tools.find((tool) => tool.name === 'iceberg_api_get_type');
    expect(getType).toMatchObject({
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
        readOnlyHint: true,
      },
      inputSchema: { additionalProperties: false, type: 'object' },
    });
    expect(getType?.outputSchema).toBeDefined();

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

  it('executes every Java API and source tool through MCP', async (): Promise<void> => {
    const baseUrl = await startMockJavadoc();
    const sourceDir = await startMockSourceCheckout();
    const configured = testConfig();
    const handle = await start({
      ...configured,
      javadoc: { baseUrl, version: '1.11.0' },
      sourceDir,
    });
    const calls: readonly [string, Record<string, unknown>][] = [
      ['iceberg_api_list_versions', {}],
      ['iceberg_api_browse', { kind: 'type', limit: 10, version: '1.11.0' }],
      ['iceberg_api_search', { limit: 10, query: 'Table', scope: 'all', version: '1.11.0' }],
      [
        'iceberg_api_get_type',
        { fully_qualified_name: 'org.apache.iceberg.Table', member_limit: 10, version: '1.11.0' },
      ],
      [
        'iceberg_api_get_member',
        {
          fully_qualified_name: 'org.apache.iceberg.Table',
          member: 'schema()',
          version: '1.11.0',
        },
      ],
      [
        'iceberg_api_compare_versions',
        { from_version: '1.10.0', kind: 'type', limit: 10, to_version: '1.11.0' },
      ],
      [
        'iceberg_source_get_type',
        { fully_qualified_name: 'org.apache.iceberg.Table', line_count: 10, start_line: 1 },
      ],
      ['iceberg_source_search', { limit: 10, literal: 'search-marker' }],
      [
        'iceberg_source_find_implementations',
        { fully_qualified_name: 'org.apache.iceberg.Table', limit: 10 },
      ],
    ];

    for (const [index, [name, arguments_]] of calls.entries()) {
      const response = await mcpPost(handle.address, {
        id: 20 + index,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: arguments_, name },
      });
      expect(response['error'], name).toBeUndefined();
      expect((response['result'] as { isError?: boolean }).isError, name).not.toBe(true);
    }
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
    const readOnlyDefinitions = (
      readOnlyList['result'] as {
        tools: { annotations?: Record<string, boolean>; name: string }[];
      }
    ).tools;
    const readOnlyTools = readOnlyDefinitions.map((tool) => tool.name);
    expect(readOnlyTools).toContain('iceberg_catalog_get_config');
    expect(readOnlyTools).toContain('iceberg_catalog_list_namespaces');
    expect(readOnlyTools).not.toContain('iceberg_catalog_create_namespace');
    expect(readOnlyTools).not.toContain('iceberg_catalog_list_tables');
    expect(
      readOnlyDefinitions.find((tool) => tool.name === 'iceberg_catalog_list_namespaces'),
    ).toMatchObject({
      annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
    });

    const mutableHandle = await start(withCatalog(testConfig(), catalogUri, true));
    const mutableList = await mcpPost(mutableHandle.address, {
      id: 5,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    });
    const mutableDefinitions = (
      mutableList['result'] as {
        tools: { annotations?: Record<string, boolean>; name: string }[];
      }
    ).tools;
    const mutableTools = mutableDefinitions.map((tool) => tool.name);
    expect(mutableTools).toContain('iceberg_catalog_create_namespace');
    expect(
      mutableDefinitions.find((tool) => tool.name === 'iceberg_catalog_create_namespace'),
    ).toMatchObject({ annotations: { destructiveHint: false, readOnlyHint: false } });
    expect(
      mutableDefinitions.find((tool) => tool.name === 'iceberg_catalog_drop_namespace'),
    ).toMatchObject({ annotations: { destructiveHint: true, readOnlyHint: false } });

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

    const configResource = await mcpPost(readOnlyHandle.address, {
      id: 7,
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'iceberg://catalog/config' },
    });
    expect(JSON.stringify(configResource['result'])).toContain('GET /v1/{prefix}/namespaces');
  });

  it('advertises canonical resources and user-selected workflow prompts', async (): Promise<void> => {
    const handle = await start();
    const templatesResponse = await mcpPost(handle.address, {
      id: 7,
      jsonrpc: '2.0',
      method: 'resources/templates/list',
      params: {},
    });
    const templates = (
      templatesResponse['result'] as { resourceTemplates: { uriTemplate: string }[] }
    ).resourceTemplates;
    expect(templates.map((template) => template.uriTemplate)).toEqual([
      'iceberg://api/{version}/package/{package}',
      'iceberg://api/{version}/type/{type}',
      'iceberg://source/type/{type}',
    ]);

    const promptsResponse = await mcpPost(handle.address, {
      id: 8,
      jsonrpc: '2.0',
      method: 'prompts/list',
      params: {},
    });
    const prompts = (promptsResponse['result'] as { prompts: { name: string }[] }).prompts;
    expect(prompts.map((prompt) => prompt.name)).toEqual([
      'iceberg-java-usage',
      'iceberg-api-migration',
      'iceberg-catalog-investigation',
    ]);

    const promptResponse = await mcpPost(handle.address, {
      id: 9,
      jsonrpc: '2.0',
      method: 'prompts/get',
      params: {
        arguments: { goal: 'Implement a metadata lookup', version: '1.11.0' },
        name: 'iceberg-java-usage',
      },
    });
    const promptText = (promptResponse['result'] as { messages: { content: { text: string } }[] })
      .messages[0]?.content.text;
    expect(promptText).toContain('iceberg_api_search');
    expect(promptText).toContain('1.11.0');

    const invalidPromptResponse = await mcpPost(handle.address, {
      id: 10,
      jsonrpc: '2.0',
      method: 'prompts/get',
      params: {
        arguments: { goal: 'Implement a metadata lookup', version: 'latest' },
        name: 'iceberg-java-usage',
      },
    });
    expect(invalidPromptResponse['error']).toMatchObject({ code: -32_602 });

    const migrationResponse = await mcpPost(handle.address, {
      id: 11,
      jsonrpc: '2.0',
      method: 'prompts/get',
      params: {
        arguments: { from_version: '1.10.0', goal: 'Upgrade safely', to_version: '1.11.0' },
        name: 'iceberg-api-migration',
      },
    });
    expect(JSON.stringify(migrationResponse['result'])).toContain('iceberg_api_compare_versions');

    const investigationResponse = await mcpPost(handle.address, {
      id: 12,
      jsonrpc: '2.0',
      method: 'prompts/get',
      params: {
        arguments: { question: 'Which namespaces contain tables?' },
        name: 'iceberg-catalog-investigation',
      },
    });
    expect(JSON.stringify(investigationResponse['result'])).toContain('iceberg_catalog_get_config');
  });

  it('reads canonical Javadoc resources with bounded JSON content', async (): Promise<void> => {
    const baseUrl = await startMockJavadoc();
    const configured = testConfig();
    const handle = await start({
      ...configured,
      javadoc: { baseUrl, version: '1.11.0' },
    });

    const packageResponse = await mcpPost(handle.address, {
      id: 12,
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'iceberg://api/1.11.0/package/org.apache.iceberg' },
    });
    expect(JSON.stringify(packageResponse['result'])).toContain('org.apache.iceberg.Table');

    const typeResponse = await mcpPost(handle.address, {
      id: 13,
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'iceberg://api/1.11.0/type/org.apache.iceberg.Table' },
    });
    expect(JSON.stringify(typeResponse['result'])).toContain('Interface Table');
  });
});
