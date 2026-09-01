import { describe, expect, it, vi } from 'vitest';

import type { CatalogConfig, LimitsConfig } from '../../src/config.js';
import { CatalogClient, uuidV7 } from '../../src/catalog/client.js';
import {
  ALL_CATALOG_OPERATIONS,
  CATALOG_OPERATIONS,
  CURRENT_CATALOG_EXTENSION_OPERATIONS,
  operationById,
} from '../../src/catalog/operations.js';
import { catalogToolDefinitions } from '../../src/capabilities/catalog-tools.js';

const limits: LimitsConfig = { maxResponseChars: 30_000, requestTimeoutMs: 2_000 };

function config(overrides: Partial<CatalogConfig> = {}): CatalogConfig {
  return {
    allowMutations: false,
    oauth2Credential: undefined,
    oauth2Uri: undefined,
    token: 'catalog-secret',
    uri: new URL('https://catalog.example.test/base/'),
    warehouse: 'analytics',
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('catalog operation coverage', (): void => {
  it('maps all 32 released operation IDs and exactly 30 model-callable tools', (): void => {
    expect(CATALOG_OPERATIONS).toHaveLength(32);
    expect(new Set(CATALOG_OPERATIONS.map((operation) => operation.id)).size).toBe(32);
    expect(
      CATALOG_OPERATIONS.filter((operation) => operation.toolName === undefined).map(
        (operation) => operation.id,
      ),
    ).toEqual(['getToken', 'signRequest']);
    expect(CURRENT_CATALOG_EXTENSION_OPERATIONS).toHaveLength(3);
    expect(catalogToolDefinitions()).toHaveLength(33);
    expect(new Set(catalogToolDefinitions().map((definition) => definition.operationId))).toEqual(
      new Set(
        ALL_CATALOG_OPERATIONS.filter((operation) => operation.toolName !== undefined).map(
          (operation) => operation.id,
        ),
      ),
    );
  });

  it('produces RFC 9562 version-7 UUIDs', (): void => {
    expect(uuidV7(1_700_000_000_000)).toMatch(
      /^018bcfe5-6800-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('builds every callable operation from strict, model-facing inputs', (): void => {
    const namespace = ['company', 'analytics'];
    const tablePath = { namespace, table: 'events' };
    const viewPath = { namespace, view: 'daily_events' };
    const samples: Record<string, Record<string, unknown>> = {
      cancelPlanning: { ...tablePath, plan_id: 'plan-1' },
      commitTransaction: { table_changes: [{ identifier: { name: 'events', namespace } }] },
      createNamespace: { namespace, properties: { owner: 'data' } },
      createTable: {
        location: 's3://warehouse/events',
        name: 'events',
        namespace,
        partition_spec: { fields: [] },
        properties: { owner: 'data' },
        schema: { fields: [], 'schema-id': 0, type: 'struct' },
        stage_create: true,
        write_order: { fields: [], 'order-id': 0 },
      },
      createView: {
        location: 's3://warehouse/views/daily_events',
        name: 'daily_events',
        namespace,
        properties: { dialect: 'spark' },
        schema: { fields: [], 'schema-id': 0, type: 'struct' },
        view_version: { 'version-id': 1 },
      },
      dropNamespace: { namespace },
      dropTable: { ...tablePath, purge_requested: true },
      dropView: viewPath,
      fetchPlanningResult: { ...tablePath, plan_id: 'plan-1' },
      fetchScanTasks: {
        ...tablePath,
        cursor: 'opaque',
        page_size: 25,
        plan_task: 'task-token',
      },
      getConfig: {},
      listFunctions: { cursor: 'opaque', namespace, page_size: 25 },
      listNamespaces: { cursor: 'opaque', page_size: 25, parent: ['company'] },
      listTables: { cursor: 'opaque', namespace, page_size: 25 },
      listViews: { cursor: 'opaque', namespace, page_size: 25 },
      loadCredentials: { ...tablePath, plan_id: 'plan-1' },
      loadFunction: { function: 'bucket', namespace },
      loadNamespaceMetadata: { namespace },
      loadTable: { ...tablePath, snapshots: 'refs' },
      loadView: viewPath,
      namespaceExists: { namespace },
      planTableScan: {
        ...tablePath,
        case_sensitive: true,
        end_snapshot_id: 3,
        filter: { type: 'true' },
        min_rows_requested: 1,
        select: ['id'],
        snapshot_id: 2,
        start_snapshot_id: 1,
        use_snapshot_schema: true,
      },
      registerTable: {
        metadata_location: 's3://warehouse/events/metadata/v1.json',
        name: 'events',
        namespace,
        overwrite: false,
      },
      registerView: {
        metadata_location: 's3://warehouse/views/daily_events/metadata/v1.json',
        name: 'daily_events',
        namespace,
      },
      renameTable: {
        destination_name: 'events_v2',
        destination_namespace: namespace,
        source_name: 'events',
        source_namespace: namespace,
      },
      renameView: {
        destination_name: 'daily_events_v2',
        destination_namespace: namespace,
        source_name: 'daily_events',
        source_namespace: namespace,
      },
      replaceView: {
        ...viewPath,
        requirements: [{ type: 'assert-view-uuid', uuid: 'view-uuid' }],
        updates: [{ type: 'set-properties', updates: { owner: 'data' } }],
      },
      reportMetrics: { ...tablePath, report: { 'report-type': 'scan-report' } },
      tableExists: tablePath,
      unregisterTable: tablePath,
      updateProperties: { namespace, removals: ['old'], updates: { owner: 'data' } },
      updateTable: {
        ...tablePath,
        requirements: [{ type: 'assert-table-uuid', uuid: 'table-uuid' }],
        updates: [{ type: 'set-properties', updates: { owner: 'data' } }],
      },
      viewExists: viewPath,
    };

    const calls = catalogToolDefinitions().map((definition) => {
      const sample = samples[definition.operationId];
      if (sample === undefined) {
        throw new Error(`Missing sample for ${definition.operationId}`);
      }
      return definition.build(definition.inputSchema.parse(sample));
    });

    expect(calls).toHaveLength(33);
    expect(calls.map((call) => call.operationId)).toEqual(
      catalogToolDefinitions().map((definition) => definition.operationId),
    );
    expect(calls.find((call) => call.operationId === 'renameTable')?.body).toEqual({
      destination: { name: 'events_v2', namespace },
      source: { name: 'events', namespace },
    });
    expect(calls.find((call) => call.operationId === 'loadCredentials')?.query).toEqual({
      planId: 'plan-1',
    });
  });
});

describe('CatalogClient', (): void => {
  it('requires a catalog URI before discovery', async (): Promise<void> => {
    await expect(
      CatalogClient.create({ config: config({ uri: undefined }), fetch: vi.fn(), limits }),
    ).rejects.toThrow(/URI is required/u);
    await expect(
      CatalogClient.discover(
        { config: config({ uri: undefined }), fetch: vi.fn(), limits },
        { authorization: () => Promise.resolve(undefined), clear: vi.fn() },
      ),
    ).rejects.toThrow(/URI is required/u);
  });

  it.each([
    [new Response('{}', { headers: { 'content-type': 'text/plain' } }), /content type/u],
    [new Response('{', { headers: { 'content-type': 'application/json' } }), /invalid JSON/u],
    [jsonResponse([]), /response is invalid/u],
    [jsonResponse({ error: { code: 503, message: 'busy', type: 'Busy' } }, 503), /busy/u],
  ])('rejects invalid discovery responses %#', async (response, expected): Promise<void> => {
    await expect(
      CatalogClient.create({
        config: config(),
        fetch: () => Promise.resolve(response.clone()),
        limits,
      }),
    ).rejects.toThrow(expected);
  });

  it('normalizes discovery network failures and timeouts', async (): Promise<void> => {
    await expect(
      CatalogClient.create({
        config: config(),
        fetch: () => Promise.reject(new Error('network failed')),
        limits,
      }),
    ).rejects.toMatchObject({ retryable: true, status: 502 });

    await expect(
      CatalogClient.create({
        config: config(),
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
        limits: { ...limits, requestTimeoutMs: 1 },
      }),
    ).rejects.toMatchObject({ retryable: true, status: 504 });
  });

  it('keeps the request deadline active while consuming a response body', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      if (request.url.includes('/v1/config')) {
        return Promise.resolve(
          jsonResponse({
            defaults: {},
            endpoints: ['POST /v1/{prefix}/namespaces'],
            overrides: {},
          }),
        );
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller): void {
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new Error('aborted')),
                { once: true },
              );
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const client = await CatalogClient.create({
      config: config(),
      fetch,
      limits: { ...limits, requestTimeoutMs: 1 },
    });

    await expect(
      client.call({ body: { namespace: ['analytics'] }, operationId: 'createNamespace', path: {} }),
    ).rejects.toMatchObject({ retryable: true, status: 504 });
    expect(fetch).toHaveBeenCalledTimes(2);
    client.close();
  });

  it('uses default endpoints, safe separator fallback, and redacted merged config', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          defaults: { password: 'do-not-return', 'namespace-separator': '%' },
          overrides: {},
        }),
      ),
    );
    const client = await CatalogClient.create({
      config: config({ warehouse: undefined }),
      fetch,
      limits,
    });

    expect(client.supports(operationById('listTables'))).toBe(true);
    expect(JSON.stringify(client.configResult())).not.toContain('do-not-return');
    expect(client.configResult()).toMatchObject({ operation_id: 'getConfig', status: 200 });
    expect(await client.call({ operationId: 'getConfig', path: {} })).toEqual(
      client.configResult(),
    );
    client.close();
  });

  it('discovers config, preserves the operator origin/base path, and paginates opaquely', async (): Promise<void> => {
    const requests: Request[] = [];
    let listCall = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes('/v1/config')) {
        return Promise.resolve(
          jsonResponse({
            defaults: { prefix: 'default-prefix' },
            endpoints: ['GET /v1/{prefix}/namespaces'],
            overrides: { 'namespace-separator': '%1F', prefix: 'tenant' },
          }),
        );
      }
      listCall += 1;
      return Promise.resolve(
        jsonResponse({
          namespaces: [['analytics'], ['raw']],
          'next-page-token': listCall === 1 ? 'server-token' : null,
        }),
      );
    });
    const client = await CatalogClient.create({ config: config(), fetch, limits });

    const first = await client.call({
      operationId: 'listNamespaces',
      path: {},
      query: { pageSize: 2, parent: ['company', 'finance'] },
    });
    expect(first.next_cursor).not.toBeNull();
    const second = await client.call({
      cursor: first.next_cursor ?? undefined,
      operationId: 'listNamespaces',
      path: {},
      query: { pageSize: 2, parent: ['company', 'finance'] },
    });
    expect(second.next_cursor).toBeNull();

    expect(requests[0]?.url).toBe(
      'https://catalog.example.test/base/v1/config?warehouse=analytics',
    );
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer catalog-secret');
    const firstUrl = new URL(requests[1]?.url ?? 'https://invalid');
    expect(firstUrl.pathname).toBe('/base/v1/tenant/namespaces');
    expect(firstUrl.searchParams.get('pageToken')).toBe('');
    expect(firstUrl.searchParams.get('pageSize')).toBe('2');
    expect(firstUrl.searchParams.get('parent')).toBe('company\u001ffinance');
    expect(new URL(requests[2]?.url ?? 'https://invalid').searchParams.get('pageToken')).toBe(
      'server-token',
    );
    client.close();
  });

  it('gates unadvertised operations before network I/O', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          defaults: {},
          endpoints: ['GET /v1/{prefix}/namespaces'],
          overrides: {},
        }),
      ),
    );
    const client = await CatalogClient.create({ config: config(), fetch, limits });

    await expect(
      client.call({ operationId: 'listTables', path: { namespace: ['analytics'] } }),
    ).rejects.toThrow(/did not advertise/u);
    expect(fetch).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('bounds outbound catalog bodies from every transport', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          defaults: {},
          endpoints: ['POST /v1/{prefix}/namespaces'],
          overrides: {},
        }),
      ),
    );
    const client = await CatalogClient.create({ config: config(), fetch, limits });

    await expect(
      client.call({
        body: { namespace: ['analytics'], properties: { large: 'x'.repeat(1_048_576) } },
        operationId: 'createNamespace',
        path: {},
      }),
    ).rejects.toThrow(/request exceeds 1048576 bytes/u);
    expect(fetch).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('uses Iceberg legacy defaults for an empty endpoint advertisement', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ defaults: {}, endpoints: [], overrides: {} })),
    );
    const client = await CatalogClient.create({ config: config(), fetch, limits });

    expect(client.supports(operationById('listTables'))).toBe(true);
    expect(client.supports(operationById('listViews'))).toBe(false);
    client.close();
  });

  it('adds legacy view endpoints when discovery enables them', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          defaults: { 'view-endpoints-supported': 'true' },
          overrides: {},
        }),
      ),
    );
    const client = await CatalogClient.create({ config: config(), fetch, limits });

    expect(client.supports(operationById('listViews'))).toBe(true);
    expect(client.supports(operationById('renameView'))).toBe(true);
    expect(client.supports(operationById('registerView'))).toBe(false);
    client.close();
  });

  it('uses one UUIDv7 idempotency key for eligible retries', async (): Promise<void> => {
    const idempotencyKeys: (string | null)[] = [];
    let mutationCalls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      if (request.url.includes('/v1/config')) {
        return Promise.resolve(
          jsonResponse({
            defaults: {},
            endpoints: ['POST /v1/{prefix}/namespaces'],
            'idempotency-key-lifetime': 'PT30M',
            overrides: {},
          }),
        );
      }
      mutationCalls += 1;
      idempotencyKeys.push(request.headers.get('idempotency-key'));
      return Promise.resolve(
        mutationCalls === 1
          ? jsonResponse({ error: { code: 503, message: 'busy', type: 'ServiceUnavailable' } }, 503)
          : jsonResponse({ namespace: ['analytics'], properties: {} }),
      );
    });
    const client = await CatalogClient.create({ config: config(), fetch, limits });

    const result = await client.call({
      body: { namespace: ['analytics'] },
      operationId: 'createNamespace',
      path: {},
    });

    expect(result.status).toBe(200);
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
    expect(idempotencyKeys[0]).toMatch(/-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/u);
    client.close();
  });

  it('preserves conflict details and never retries HTTP 409', async (): Promise<void> => {
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      if (request.url.includes('/v1/config')) {
        return Promise.resolve(
          jsonResponse({
            defaults: {},
            endpoints: ['POST /v1/{prefix}/namespaces/{namespace}/tables/{table}'],
            'idempotency-key-lifetime': 'PT30M',
            overrides: {},
          }),
        );
      }
      calls += 1;
      return Promise.resolve(
        jsonResponse(
          { error: { code: 409, message: 'requirement failed', type: 'CommitFailedException' } },
          409,
        ),
      );
    });
    const client = await CatalogClient.create({ config: config(), fetch, limits });

    await expect(
      client.call({
        body: { requirements: [], updates: [] },
        operationId: 'updateTable',
        path: { namespace: ['analytics'], table: 'events' },
      }),
    ).rejects.toMatchObject({
      retryable: false,
      status: 409,
      upstreamCode: 409,
      upstreamType: 'CommitFailedException',
    });
    expect(calls).toBe(1);
    client.close();
  });

  it('returns existence booleans and strips credential values', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      if (request.url.includes('/v1/config')) {
        return Promise.resolve(
          jsonResponse({
            defaults: {},
            endpoints: [
              'HEAD /v1/{prefix}/namespaces/{namespace}/tables/{table}',
              'GET /v1/{prefix}/namespaces/{namespace}/tables/{table}/credentials',
            ],
            overrides: {},
          }),
        );
      }
      if (request.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(
        jsonResponse({
          'storage-credentials': [
            {
              config: { 's3.access-key-id': 'AKIA', 's3.secret-access-key': 'secret' },
              prefix: 's3://warehouse/',
            },
          ],
        }),
      );
    });
    const client = await CatalogClient.create({ config: config(), fetch, limits });
    const path = { namespace: ['analytics'], table: 'events' };

    const exists = await client.call({ operationId: 'tableExists', path });
    const credentials = await client.call({ operationId: 'loadCredentials', path });

    expect(exists.data).toEqual({ exists: false });
    expect(credentials.data).toEqual({
      storage_credentials: [
        {
          config_keys: ['s3.access-key-id', 's3.secret-access-key'],
          prefix: 's3://warehouse/',
        },
      ],
    });
    expect(JSON.stringify(credentials)).not.toContain('AKIA');
    expect(JSON.stringify(credentials)).not.toContain('secret"');
    client.close();
  });

  it('returns true for HEAD 204 and rejects missing path inputs before fetching', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const request = new Request(input);
      if (request.url.includes('/v1/config')) {
        return Promise.resolve(
          jsonResponse({
            defaults: {},
            endpoints: [
              'HEAD /v1/{prefix}/namespaces/{namespace}/tables/{table}',
              'GET /v1/{prefix}/namespaces/{namespace}/tables',
            ],
            overrides: {},
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = await CatalogClient.create({ config: config(), fetch, limits });

    const exists = await client.call({
      operationId: 'tableExists',
      path: { namespace: ['analytics'], table: 'events' },
    });
    expect(exists.data).toEqual({ exists: true });
    await expect(client.call({ operationId: 'listTables', path: {} })).rejects.toThrow(
      /Missing path input/u,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    client.close();
  });

  it.each([
    [new Response('{}', { headers: { 'content-type': 'text/plain' } }), /content type/u],
    [new Response('{', { headers: { 'content-type': 'application/json' } }), /invalid JSON/u],
    [jsonResponse({ namespaces: 'invalid' }), /does not match/u],
    [jsonResponse({ namespaces: [['x'.repeat(1_200)]] }), /characters/u],
  ])('validates successful operation responses %#', async (operationResponse, expected) => {
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const request = new Request(input);
      return Promise.resolve(
        request.url.includes('/v1/config')
          ? jsonResponse({
              defaults: {},
              endpoints: ['GET /v1/{prefix}/namespaces'],
              overrides: {},
            })
          : operationResponse.clone(),
      );
    });
    const client = await CatalogClient.create({
      config: config(),
      fetch,
      limits: { ...limits, maxResponseChars: 1_000 },
    });

    await expect(
      client.call({ operationId: 'listNamespaces', path: {}, query: { pageSize: 10 } }),
    ).rejects.toThrow(expected);
    client.close();
  });

  it('accepts empty successful responses for response-less mutations', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const request = new Request(input);
      return Promise.resolve(
        request.url.includes('/v1/config')
          ? jsonResponse({
              defaults: {},
              endpoints: ['DELETE /v1/{prefix}/namespaces/{namespace}'],
              overrides: {},
            })
          : new Response(null, { status: 204 }),
      );
    });
    const client = await CatalogClient.create({ config: config(), fetch, limits });

    const result = await client.call({
      operationId: 'dropNamespace',
      path: { namespace: ['empty'] },
    });

    expect(result).toMatchObject({ data: null, operation_id: 'dropNamespace', status: 204 });
    client.close();
  });
});
