import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import type { CatalogConfig, LimitsConfig } from '../config.js';
import { CapabilityError, LimitError, UpstreamError } from '../shared/errors.js';
import { decodeTokenCursor, encodeTokenCursor } from '../shared/pagination.js';
import { redactSecrets } from '../shared/redaction.js';
import type { CatalogAuthProvider } from './auth.js';
import { createCatalogAuthProvider } from './auth.js';
import { DEFAULT_CATALOG_ENDPOINTS, DEFAULT_VIEW_ENDPOINTS, operationById } from './operations.js';
import type { CatalogOperation } from './operations.js';
import type { CatalogCall, CatalogDiscovery, CatalogResult } from './types.js';
import { validateCatalogResponse } from './response-schemas.js';

const discoverySchema = z.looseObject({
  defaults: z.record(z.string(), z.string()),
  endpoints: z.array(z.string().max(2_000)).max(500).optional(),
  'idempotency-key-lifetime': z.string().max(100).optional(),
  overrides: z.record(z.string(), z.string()),
});
const errorResponseSchema = z.looseObject({
  error: z.looseObject({
    code: z.number().int().optional(),
    message: z.string().max(10_000).optional(),
    type: z.string().max(1_000).optional(),
  }),
});

class Semaphore {
  readonly #waiting: (() => void)[] = [];
  #available: number;

  public constructor(count: number) {
    this.#available = count;
  }

  public async use<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#available === 0) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#available -= 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) {
        this.#available += 1;
      } else {
        next();
      }
    }
  }
}

function normalizedBaseUri(uri: URL): URL {
  const base = new URL(uri);
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) {
    base.pathname = `${base.pathname}/`;
  }
  return base;
}

function decodeNamespaceSeparator(value: string | undefined): string {
  if (value === undefined) {
    return '\u001f';
  }
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 8 ? decoded : '\u001f';
  } catch {
    return '\u001f';
  }
}

function configValue(config: Readonly<Record<string, string>>, name: string): string | undefined {
  return config[name];
}

export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  const byteSix = bytes[6] ?? 0;
  const byteEight = bytes[8] ?? 0;
  bytes[6] = 0x70 | (byteSix & 0x0f);
  bytes[8] = 0x80 | (byteEight & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let length = 0;
  let result = await reader.read();
  while (!result.done) {
    length += result.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new LimitError(`Catalog response exceeds ${maxBytes} bytes`);
    }
    chunks.push(result.value);
    result = await reader.read();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(output);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UpstreamError(`${label} returned invalid JSON`, 502, false, { cause: error });
  }
}

function isJsonContent(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
  return contentType === 'application/json' || contentType.endsWith('+json');
}

function retryAfter(response: Response, attempt: number): number {
  const value = response.headers.get('retry-after');
  if (value !== null && /^\d+$/u.test(value)) {
    return Math.min(Number(value) * 1_000, 5_000);
  }
  return Math.min(1_000, 100 * 2 ** attempt) + Math.floor(Math.random() * 50);
}

function sanitizeCredentials(data: unknown): unknown {
  if (data === null || typeof data !== 'object') {
    return { storage_credentials: [] };
  }
  const credentials = (data as Record<string, unknown>)['storage-credentials'];
  if (!Array.isArray(credentials)) {
    return { storage_credentials: [] };
  }
  return {
    storage_credentials: credentials.map((credential) => {
      if (credential === null || typeof credential !== 'object') {
        return { config_keys: [], prefix: null };
      }
      const record = credential as Record<string, unknown>;
      const config =
        record['config'] !== null && typeof record['config'] === 'object'
          ? Object.keys(record['config']).sort()
          : [];
      return {
        config_keys: config,
        prefix: typeof record['prefix'] === 'string' ? record['prefix'] : null,
      };
    }),
  };
}

export interface CatalogClientOptions {
  readonly config: CatalogConfig;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly limits: LimitsConfig;
}

export class CatalogClient {
  readonly #auth: CatalogAuthProvider;
  readonly #baseUri: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #limits: LimitsConfig;
  readonly #semaphore = new Semaphore(8);
  readonly discovery: CatalogDiscovery;

  private constructor(
    options: CatalogClientOptions,
    auth: CatalogAuthProvider,
    discovery: CatalogDiscovery,
  ) {
    if (options.config.uri === undefined) {
      throw new Error('Catalog URI is required');
    }
    this.#auth = auth;
    this.#baseUri = normalizedBaseUri(options.config.uri);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#limits = options.limits;
    this.discovery = discovery;
  }

  public static async create(options: CatalogClientOptions): Promise<CatalogClient> {
    if (options.config.uri === undefined) {
      throw new Error('Catalog URI is required');
    }
    const auth = createCatalogAuthProvider(
      options.config,
      options.limits.requestTimeoutMs,
      options.fetch,
    );
    try {
      const discovery = await CatalogClient.discover(options, auth);
      return new CatalogClient(options, auth, discovery);
    } catch (error) {
      auth.clear();
      throw error;
    }
  }

  public static async discover(
    options: CatalogClientOptions,
    auth: CatalogAuthProvider,
  ): Promise<CatalogDiscovery> {
    if (options.config.uri === undefined) {
      throw new Error('Catalog URI is required');
    }
    const baseUri = normalizedBaseUri(options.config.uri);
    const url = new URL('v1/config', baseUri);
    if (options.config.warehouse !== undefined) {
      url.searchParams.set('warehouse', options.config.warehouse);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.limits.requestTimeoutMs);
    try {
      const authorization = await auth.authorization(controller.signal);
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        headers: {
          accept: 'application/json',
          ...(authorization === undefined ? {} : { authorization }),
          'user-agent': 'iceberg-mcp-server/0.1.0',
          'x-request-id': randomUUID(),
        },
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await readResponseText(
        response,
        Math.min(options.limits.maxResponseChars * 4, 1_000_000),
      );
      if (!response.ok) {
        throw CatalogClient.responseError(response, text);
      }
      if (!isJsonContent(response)) {
        throw new UpstreamError('Catalog config returned an unexpected content type', 502, false);
      }
      const parsed = discoverySchema.safeParse(parseJson(text, 'Catalog config'));
      if (!parsed.success) {
        throw new UpstreamError('Catalog config response is invalid', 502, false);
      }
      const local: Record<string, string> =
        options.config.warehouse === undefined ? {} : { warehouse: options.config.warehouse };
      const merged: Record<string, string> = {
        ...parsed.data.defaults,
        ...local,
        ...parsed.data.overrides,
      };
      const advertisedEndpoints = parsed.data.endpoints;
      const endpoints =
        advertisedEndpoints === undefined || advertisedEndpoints.length === 0
          ? new Set([
              ...DEFAULT_CATALOG_ENDPOINTS,
              ...(merged['view-endpoints-supported'] === 'true' ? DEFAULT_VIEW_ENDPOINTS : []),
            ])
          : new Set(advertisedEndpoints);
      return {
        defaults: parsed.data.defaults,
        endpoints,
        idempotencyKeyLifetime: parsed.data['idempotency-key-lifetime'],
        merged,
        namespaceSeparator: decodeNamespaceSeparator(merged['namespace-separator']),
        overrides: parsed.data.overrides,
        prefix: configValue(merged, 'prefix') ?? '',
        retrievedAt: new Date(),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new UpstreamError('Catalog config request timed out', 504, true, { cause: error });
      }
      if (!(error instanceof UpstreamError) && !(error instanceof LimitError)) {
        throw new UpstreamError('Catalog config request failed', 502, true, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public close(): void {
    this.#auth.clear();
  }

  public supports(operation: CatalogOperation): boolean {
    return (
      operation.id === 'getConfig' ||
      this.discovery.endpoints.has(`${operation.method} ${operation.path}`)
    );
  }

  public configResult(): CatalogResult {
    return {
      data: redactSecrets({
        defaults: this.discovery.defaults,
        endpoints: [...this.discovery.endpoints].sort(),
        idempotency_key_lifetime: this.discovery.idempotencyKeyLifetime ?? null,
        merged: this.discovery.merged,
        namespace_separator: encodeURIComponent(this.discovery.namespaceSeparator),
        overrides: this.discovery.overrides,
        prefix: this.discovery.prefix,
        retrieved_at: this.discovery.retrievedAt.toISOString(),
      }),
      next_cursor: null,
      operation_id: 'getConfig',
      status: 200,
    };
  }

  public async call(call: CatalogCall, signal?: AbortSignal): Promise<CatalogResult> {
    const operation = operationById(call.operationId);
    if (operation.id === 'getConfig') {
      return this.configResult();
    }
    if (!this.supports(operation)) {
      throw new CapabilityError(`Catalog did not advertise ${operation.method} ${operation.path}`);
    }
    const url = this.#operationUrl(operation, call);
    const cursorIdentity = {
      operationId: call.operationId,
      path: call.path,
      query: call.query ?? {},
    };
    if (operation.paginated) {
      url.searchParams.set('pageToken', decodeTokenCursor(call.cursor, cursorIdentity));
    }
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    const canRetryWithoutKey = operation.method === 'GET' || operation.method === 'HEAD';
    const idempotencyKey =
      !canRetryWithoutKey && this.discovery.idempotencyKeyLifetime !== undefined
        ? uuidV7()
        : undefined;
    const attempts = canRetryWithoutKey || idempotencyKey !== undefined ? 3 : 1;
    return this.#semaphore.use(async () => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const response = await this.#request(operation, url, body, idempotencyKey, signal);
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          await delay(retryAfter(response, attempt), undefined, { signal });
          continue;
        }
        return this.#result(operation, response, cursorIdentity);
      }
      throw new UpstreamError('Catalog retry limit exceeded', 502, false);
    });
  }

  async #request(
    operation: CatalogOperation,
    url: URL,
    body: string | undefined,
    idempotencyKey: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#limits.requestTimeoutMs);
    const combined =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    try {
      const authorization = await this.#auth.authorization(combined);
      return await this.#fetch(url, {
        ...(body === undefined ? {} : { body }),
        headers: {
          accept: 'application/json',
          ...(authorization === undefined ? {} : { authorization }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
          'user-agent': 'iceberg-mcp-server/0.1.0',
          'x-request-id': randomUUID(),
        },
        method: operation.method,
        redirect: 'error',
        signal: combined,
      });
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new UpstreamError('Catalog request timed out', 504, true, { cause: error });
      }
      if (!(error instanceof UpstreamError) && !(error instanceof LimitError)) {
        throw new UpstreamError('Catalog request failed', 502, true, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #result(
    operation: CatalogOperation,
    response: Response,
    cursorIdentity: unknown,
  ): Promise<CatalogResult> {
    if (operation.method === 'HEAD' && (response.status === 204 || response.status === 404)) {
      return {
        data: { exists: response.status === 204 },
        next_cursor: null,
        operation_id: operation.id,
        status: response.status,
      };
    }
    const text = await readResponseText(response, this.#limits.maxResponseChars * 4);
    if (!response.ok) {
      throw CatalogClient.responseError(response, text);
    }
    if (text !== '' && !isJsonContent(response)) {
      throw new UpstreamError('Catalog returned an unexpected content type', 502, false);
    }
    const data = validateCatalogResponse(
      operation.id,
      text === '' ? null : parseJson(text, `Catalog ${operation.id}`),
    );
    const serialized = JSON.stringify(data);
    if (serialized.length > this.#limits.maxResponseChars) {
      throw new LimitError(
        `Catalog response exceeds ${this.#limits.maxResponseChars} characters; request a smaller page`,
      );
    }
    const token =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['next-page-token']
        : undefined;
    const nextCursor = typeof token === 'string' ? encodeTokenCursor(token, cursorIdentity) : null;
    return {
      data: operation.id === 'loadCredentials' ? sanitizeCredentials(data) : redactSecrets(data),
      next_cursor: nextCursor,
      operation_id: operation.id,
      status: response.status,
    };
  }

  #operationUrl(operation: CatalogOperation, call: CatalogCall): URL {
    let pathname = operation.path;
    pathname = pathname.replace(
      '/{prefix}',
      this.discovery.prefix === '' ? '' : `/${encodeURIComponent(this.discovery.prefix)}`,
    );
    const placeholders = [...pathname.matchAll(/\{([^}]+)\}/gu)];
    for (const placeholder of placeholders) {
      const name = placeholder[1];
      const value = name === undefined ? undefined : call.path[name];
      if (name === undefined || value === undefined) {
        throw new CapabilityError(`Missing path input for ${placeholder[0]}`);
      }
      const raw = Array.isArray(value)
        ? value.join(this.discovery.namespaceSeparator)
        : String(value);
      pathname = pathname.replace(placeholder[0], encodeURIComponent(raw));
    }
    const url = new URL(pathname.replace(/^\//u, ''), this.#baseUri);
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(
          name,
          Array.isArray(value) ? value.join(this.discovery.namespaceSeparator) : String(value),
        );
      }
    }
    return url;
  }

  static responseError(response: Response, text: string): UpstreamError {
    let payload: unknown;
    try {
      payload = text === '' ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }
    const parsed = payload === undefined ? undefined : errorResponseSchema.safeParse(payload);
    const error = parsed?.success === true ? parsed.data.error : undefined;
    return new UpstreamError(
      error?.message ?? `Catalog returned HTTP ${response.status}`,
      response.status,
      response.status === 429 || response.status >= 500,
      undefined,
      { code: error?.code, type: error?.type },
    );
  }
}
