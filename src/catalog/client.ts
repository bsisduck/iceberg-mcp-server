import { randomBytes, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { CatalogConfig, LimitsConfig } from '../config.js';
import { CancelledError, CapabilityError, LimitError, UpstreamError } from '../shared/errors.js';
import { cancelBody, readBoundedText } from '../shared/fetch.js';
import { auditLog } from '../shared/logging.js';
import type { LogLevel } from '../shared/logging.js';
import { decodeTokenCursor, encodeTokenCursor } from '../shared/pagination.js';
import { redactSecrets } from '../shared/redaction.js';
import { Semaphore } from '../shared/semaphore.js';
import { sleep } from '../shared/sleep.js';
import { USER_AGENT } from '../version.js';
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
const MAX_CATALOG_REQUEST_BYTES = 1_048_576;
const MAX_CATALOG_ATTEMPTS = 3;
const MAX_AUDIT_IDENTIFIER_CHARS = 512;
/** Path inputs that name the catalog object a call acts on, in the order they read best. */
const AUDIT_IDENTIFIER_KEYS = ['namespace', 'table', 'view', 'function', 'plan-id'] as const;

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

function omitToken(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'next-page-token'));
}

/**
 * The catalog object a call acted on, for the audit line. Path inputs name it for almost every
 * operation; renames and transaction commits carry it in the arguments instead.
 */
function auditIdentifier(call: CatalogCall, args: unknown): string {
  const segments: string[] = [];
  for (const key of AUDIT_IDENTIFIER_KEYS) {
    const value = call.path[key];
    if (value !== undefined) {
      segments.push(...(typeof value === 'string' ? [value] : value));
    }
  }
  // Without tool arguments (an embedder calling the client directly) the body is the next best source.
  const source = args ?? call.body;
  if (segments.length === 0 && source !== null && typeof source === 'object') {
    const record = source as Record<string, unknown>;
    const namespace = record['source_namespace'] ?? record['namespace'];
    if (Array.isArray(namespace)) {
      segments.push(...namespace.map((segment) => String(segment)));
    }
    const name = record['source_name'] ?? record['name'];
    if (typeof name === 'string') {
      segments.push(name);
    }
  }
  const identifier = segments.join('.');
  if (identifier === '') {
    return '-';
  }
  return identifier.length > MAX_AUDIT_IDENTIFIER_CHARS
    ? `${identifier.slice(0, MAX_AUDIT_IDENTIFIER_CHARS)}…`
    : identifier;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Renders the discovered prefix as path segments. The reference clients encode each segment
 * separately, so a multi-segment prefix such as `ws/foo` routes to `/v1/ws/foo/...` rather than to
 * a single `ws%2Ffoo` segment, while a segment that needs escaping is still escaped. Empty segments
 * from a leading, trailing, or doubled separator are dropped so the path stays well formed.
 */
function encodedPrefix(prefix: string): string {
  const segments = prefix
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment));
  return segments.length === 0 ? '' : `/${segments.join('/')}`;
}

/** `Retry-After` in milliseconds when the catalog sent a delta-seconds value, otherwise undefined. */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  return value !== null && /^\d+$/u.test(value) ? Number(value) * 1_000 : undefined;
}

/** Exponential backoff with jitter, used when the catalog offers no `Retry-After`. */
function backoffMs(attempt: number): number {
  return Math.min(1_000, 100 * 2 ** attempt) + Math.floor(Math.random() * 50);
}

function normalizeAttemptError(error: unknown, timeoutSignal: AbortSignal): Error {
  if (timeoutSignal.aborted) {
    return new UpstreamError('Catalog request timed out', 504, true, { cause: error });
  }
  if (error instanceof UpstreamError || error instanceof LimitError) {
    return error;
  }
  return new UpstreamError('Catalog request failed', 502, true, { cause: error });
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
  /** Gates the mutation audit trail; `error` suppresses it. Defaults to `info`. */
  readonly logLevel?: LogLevel | undefined;
}

export interface CatalogCallOptions {
  /** The model-facing tool arguments, recorded (redacted) on the audit line for a mutation. */
  readonly args?: unknown;
  /** Caller cancellation: aborts the in-flight fetch, the queued permit, and the retry backoff. */
  readonly signal?: AbortSignal | undefined;
}

/** One logical call, including the state shared by every attempt made on its behalf. */
interface CatalogRequest {
  readonly attempts: number;
  readonly body: string | undefined;
  readonly correlationId: string;
  readonly cursorIdentity: unknown;
  readonly deadline: number;
  readonly idempotencyKey: string | undefined;
  readonly operation: CatalogOperation;
  readonly signal: AbortSignal | undefined;
  readonly url: URL;
}

export class CatalogClient {
  readonly #auth: CatalogAuthProvider;
  readonly #baseUri: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #limits: LimitsConfig;
  readonly #logLevel: LogLevel;
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
    this.#logLevel = options.logLevel ?? 'info';
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
          'user-agent': USER_AGENT,
          'x-request-id': randomUUID(),
        },
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await readBoundedText(
        response,
        Math.min(options.limits.maxResponseChars * 4, 1_000_000),
        'Catalog response',
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

  public async call(call: CatalogCall, options: CatalogCallOptions = {}): Promise<CatalogResult> {
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
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_CATALOG_REQUEST_BYTES) {
      throw new LimitError(`Catalog request exceeds ${MAX_CATALOG_REQUEST_BYTES} bytes`);
    }
    const canRetryWithoutKey = operation.method === 'GET' || operation.method === 'HEAD';
    const idempotencyKey =
      !canRetryWithoutKey && this.discovery.idempotencyKeyLifetime !== undefined
        ? uuidV7()
        : undefined;
    const attempts = canRetryWithoutKey || idempotencyKey !== undefined ? MAX_CATALOG_ATTEMPTS : 1;
    const startedAt = Date.now();
    const request: CatalogRequest = {
      attempts,
      body,
      correlationId: randomUUID(),
      cursorIdentity,
      // Retries share one budget: the per-attempt timeout multiplied by the attempt allowance.
      deadline: startedAt + this.#limits.requestTimeoutMs * attempts,
      idempotencyKey,
      operation,
      signal: options.signal,
      url,
    };
    // Reads are not audited: the trail exists to answer "who changed this catalog object".
    if (operation.mode === 'read') {
      return this.#run(request);
    }
    try {
      const result = await this.#run(request);
      this.#audit(request, call, options.args, startedAt, 'success', result.status);
      return result;
    } catch (error) {
      this.#audit(
        request,
        call,
        options.args,
        startedAt,
        'failure',
        error instanceof UpstreamError ? error.status : undefined,
      );
      throw error;
    }
  }

  /** One `catalog.mutation` line per attempted change, successful or not. */
  #audit(
    request: CatalogRequest,
    call: CatalogCall,
    args: unknown,
    startedAt: number,
    outcome: 'failure' | 'success',
    status: number | undefined,
  ): void {
    auditLog(
      {
        args: args ?? { body: call.body, path: call.path, query: call.query },
        correlationId: request.correlationId,
        durationMs: Date.now() - startedAt,
        idempotencyKey: request.idempotencyKey,
        identifier: auditIdentifier(call, args),
        operation: request.operation.id,
        outcome,
        status,
      },
      this.#logLevel,
    );
  }

  /**
   * Runs the attempt loop. The semaphore permit is acquired per attempt and released while the
   * backoff sleeps, so a waiting request never queues behind a sleeping one. A caller that aborts
   * — mid-fetch, while queued for a permit, or during the backoff — gets a `CancelledError` rather
   * than a retryable upstream failure, because no further attempt would help.
   */
  async #run(request: CatalogRequest): Promise<CatalogResult> {
    try {
      for (let attempt = 0; attempt < request.attempts; attempt += 1) {
        const outcome = await this.#semaphore.use(
          () => this.#attempt(request, attempt, attempt + 1 < request.attempts),
          request.signal,
        );
        if (typeof outcome !== 'number') {
          return outcome;
        }
        await sleep(outcome, request.signal);
      }
      throw new UpstreamError('Catalog retry limit exceeded', 502, false);
    } catch (error) {
      if (request.signal?.aborted === true && !(error instanceof CancelledError)) {
        throw new CancelledError('Catalog request was cancelled', { cause: error });
      }
      throw error;
    }
  }

  /**
   * One HTTP attempt. Returns the result, or the number of milliseconds to wait before the next
   * attempt when this one failed in a way another attempt could fix.
   */
  async #attempt(
    request: CatalogRequest,
    attempt: number,
    canRetry: boolean,
  ): Promise<CatalogResult | number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#limits.requestTimeoutMs);
    const combined =
      request.signal === undefined
        ? controller.signal
        : AbortSignal.any([request.signal, controller.signal]);
    try {
      const authorization = await this.#auth.authorization(combined);
      const response = await this.#fetch(request.url, {
        ...(request.body === undefined ? {} : { body: request.body }),
        headers: {
          accept: 'application/json',
          ...(authorization === undefined ? {} : { authorization }),
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(request.idempotencyKey === undefined
            ? {}
            : { 'idempotency-key': request.idempotencyKey }),
          'user-agent': USER_AGENT,
          'x-request-id': request.correlationId,
        },
        method: request.operation.method,
        redirect: 'error',
        signal: combined,
      });
      if ((response.status === 429 || response.status >= 500) && canRetry) {
        const wait = this.#retryWait(
          retryAfterMs(response) ?? backoffMs(attempt),
          request.deadline,
        );
        if (wait !== undefined) {
          cancelBody(response);
          return wait;
        }
      }
      return await this.#result(request.operation, response, request.cursorIdentity);
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw new CancelledError('Catalog request was cancelled', { cause: error });
      }
      const failure = normalizeAttemptError(error, controller.signal);
      if (canRetry && failure instanceof UpstreamError && failure.retryable) {
        const wait = this.#retryWait(backoffMs(attempt), request.deadline);
        if (wait !== undefined) {
          return wait;
        }
      }
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Bounds a requested wait by the per-attempt timeout, then keeps it only when it still fits the
   * call's deadline. A `Retry-After` longer than the budget means the caller is better served by
   * the upstream error than by a retry it cannot afford to wait for.
   */
  #retryWait(requested: number, deadline: number): number | undefined {
    const wait = Math.min(requested, this.#limits.requestTimeoutMs);
    return Date.now() + wait <= deadline ? wait : undefined;
  }

  async #result(
    operation: CatalogOperation,
    response: Response,
    cursorIdentity: unknown,
  ): Promise<CatalogResult> {
    if (operation.method === 'HEAD' && (isSuccess(response.status) || response.status === 404)) {
      cancelBody(response);
      return {
        data: { exists: response.status !== 404 },
        next_cursor: null,
        operation_id: operation.id,
        status: response.status,
      };
    }
    const text = await readBoundedText(
      response,
      this.#limits.maxResponseChars * 4,
      'Catalog response',
    );
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
    const record =
      data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined;
    const token = record?.['next-page-token'];
    const nextCursor = typeof token === 'string' ? encodeTokenCursor(token, cursorIdentity) : null;
    // The raw server token is dropped so `next_cursor` is the only pagination field the model sees;
    // it is opaque, scoped to this query, and would otherwise invite a second, unusable one.
    const payload = record !== undefined && 'next-page-token' in record ? omitToken(record) : data;
    return {
      data:
        operation.id === 'loadCredentials' ? sanitizeCredentials(payload) : redactSecrets(payload),
      next_cursor: nextCursor,
      operation_id: operation.id,
      status: response.status,
    };
  }

  #operationUrl(operation: CatalogOperation, call: CatalogCall): URL {
    let pathname = operation.path;
    pathname = pathname.replace('/{prefix}', encodedPrefix(this.discovery.prefix));
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
