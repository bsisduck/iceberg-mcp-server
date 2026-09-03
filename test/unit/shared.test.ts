import { format, inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { AsyncTtlCache } from '../../src/shared/cache.js';
import { BoundedFetcher, readBounded, readBoundedText } from '../../src/shared/fetch.js';
import { InputError, LimitError, UpstreamError } from '../../src/shared/errors.js';
import { auditLog, createStderrReporter, stderrReporter } from '../../src/shared/logging.js';
import {
  decodeCursor,
  decodeTokenCursor,
  encodeCursor,
  encodeTokenCursor,
  paginate,
} from '../../src/shared/pagination.js';
import { redactSecrets } from '../../src/shared/redaction.js';
import { executeTool } from '../../src/shared/responses.js';
import { Secret } from '../../src/shared/secret.js';
import { sleep } from '../../src/shared/sleep.js';

describe('AsyncTtlCache', (): void => {
  it('shares promises and evicts least-recently-used entries', async (): Promise<void> => {
    const cache = new AsyncTtlCache<number>({ maxEntries: 1, negativeTtlMs: 10, ttlMs: 1_000 });
    const loader = vi.fn(() => Promise.resolve(1));
    const first = cache.getOrLoad('first', loader);
    const duplicate = cache.getOrLoad('first', loader);

    expect(await first).toBe(1);
    expect(await duplicate).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1);
    await cache.getOrLoad('second', () => Promise.resolve(2));
    expect(cache.size).toBe(1);
  });

  it('expires entries, negatively caches failures, and clears state', async (): Promise<void> => {
    vi.useFakeTimers();
    const cache = new AsyncTtlCache<number>({ maxEntries: 2, negativeTtlMs: 20, ttlMs: 10 });
    const loader = vi.fn(() => Promise.resolve(1));
    expect(await cache.getOrLoad('value', loader)).toBe(1);
    await vi.advanceTimersByTimeAsync(11);
    expect(await cache.getOrLoad('value', loader)).toBe(1);
    expect(loader).toHaveBeenCalledTimes(2);

    const failure = Promise.reject(new Error('failed'));
    await expect(cache.getOrLoad('failure', () => failure)).rejects.toThrow('failed');
    await expect(cache.getOrLoad('failure', () => Promise.resolve(2))).rejects.toThrow('failed');
    cache.clear();
    expect(cache.size).toBe(0);
    vi.useRealTimers();
  });
});

describe('bounded pagination', (): void => {
  it('binds opaque cursors to immutable query parameters', (): void => {
    const query = { kind: 'type', package: 'org.apache.iceberg' };
    const first = paginate(['a', 'b', 'c'], 0, 2, query);

    expect(first).toMatchObject({ hasMore: true, items: ['a', 'b'] });
    expect(decodeCursor(first.nextCursor, query)).toBe(2);
    expect(() => decodeCursor(first.nextCursor, { ...query, kind: 'member' })).toThrow(
      /does not match/u,
    );
    expect(() => decodeCursor('***', query)).toThrow(/malformed/u);
    expect(decodeCursor(encodeCursor(3, query), query)).toBe(3);
    expect(() => paginate(['a'], 2, 1, query)).toThrow(/beyond/u);
  });

  it('binds REST page tokens and rejects malformed token cursors', (): void => {
    const query = { operationId: 'listTables', path: { namespace: ['analytics'] } };
    const cursor = encodeTokenCursor('server-token', query);

    expect(decodeTokenCursor(undefined, query)).toBe('');
    expect(decodeTokenCursor(cursor, query)).toBe('server-token');
    expect(() => decodeTokenCursor(cursor, { ...query, operationId: 'listViews' })).toThrow(
      /does not match/u,
    );
    expect(() => decodeTokenCursor('*', query)).toThrow(/malformed/u);
  });
});

describe('recursive redaction', (): void => {
  it('removes nested secret values without hiding safe metadata', (): void => {
    const redacted = redactSecrets({
      authorization: 'Bearer private',
      nested: [
        {
          'client-secret': 'private',
          prefix: 's3://warehouse',
          properties: { 's3.access-key': 'private', region: 'eu-central-1' },
        },
      ],
      tokenized_name: 'safe',
    });

    expect(redacted).toEqual({
      authorization: '[REDACTED]',
      nested: [
        {
          'client-secret': '[REDACTED]',
          prefix: 's3://warehouse',
          properties: { 's3.access-key': '[REDACTED]', region: 'eu-central-1' },
        },
      ],
      tokenized_name: 'safe',
    });
    expect(JSON.stringify(redacted)).not.toContain('private');
  });
});

describe('BoundedFetcher', (): void => {
  it('rejects URLs and redirects outside its configured root', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(null, {
          headers: { location: 'https://example.test/private' },
          status: 302,
        }),
      ),
    );
    const bounded = new BoundedFetcher({
      allowedBaseUrl: new URL('https://iceberg.apache.org/javadoc/'),
      concurrency: 1,
      fetch,
      timeoutMs: 1_000,
      userAgent: 'test',
    });

    await expect(
      bounded.get(new URL('https://example.test/private'), {
        acceptedContentTypes: ['text/plain'],
        maxBytes: 100,
        retries: 0,
      }),
    ).rejects.toThrow(/outside/u);
    await expect(
      bounded.get(new URL('https://iceberg.apache.org/javadoc/index.html'), {
        acceptedContentTypes: ['text/plain'],
        maxBytes: 100,
        retries: 0,
      }),
    ).rejects.toThrow(/outside/u);
  });

  it('enforces declared and streamed response bounds', async (): Promise<void> => {
    const declared = new BoundedFetcher({
      allowedBaseUrl: new URL('https://iceberg.apache.org/javadoc/'),
      concurrency: 1,
      fetch: (): Promise<Response> =>
        Promise.resolve(
          new Response('large', {
            headers: { 'content-length': '100', 'content-type': 'text/plain' },
          }),
        ),
      timeoutMs: 1_000,
      userAgent: 'test',
    });
    await expect(
      declared.get(new URL('https://iceberg.apache.org/javadoc/a'), {
        acceptedContentTypes: ['text/plain'],
        maxBytes: 5,
        retries: 0,
      }),
    ).rejects.toThrow(/exceeds/u);

    const streamed = new BoundedFetcher({
      allowedBaseUrl: new URL('https://iceberg.apache.org/javadoc/'),
      concurrency: 1,
      fetch: (): Promise<Response> =>
        Promise.resolve(new Response('too large', { headers: { 'content-type': 'text/plain' } })),
      timeoutMs: 1_000,
      userAgent: 'test',
    });
    await expect(
      streamed.get(new URL('https://iceberg.apache.org/javadoc/a'), {
        acceptedContentTypes: ['text/plain'],
        maxBytes: 2,
        retries: 0,
      }),
    ).rejects.toThrow(/exceeds/u);
  });

  it('cancels bodies rejected before streaming', async (): Promise<void> => {
    const contentTypeCancel = vi.fn();
    const declaredLengthCancel = vi.fn();
    const responses = [
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: contentTypeCancel,
          start(controller): void {
            controller.enqueue(new TextEncoder().encode('html'));
          },
        }),
        { headers: { 'content-type': 'text/html' } },
      ),
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: declaredLengthCancel,
          start(controller): void {
            controller.enqueue(new TextEncoder().encode('large'));
          },
        }),
        { headers: { 'content-length': '100', 'content-type': 'text/plain' } },
      ),
    ];
    const bounded = new BoundedFetcher({
      allowedBaseUrl: new URL('https://iceberg.apache.org/javadoc/'),
      concurrency: 1,
      fetch: (): Promise<Response> =>
        Promise.resolve(responses.shift() ?? new Response('unexpected')),
      timeoutMs: 1_000,
      userAgent: 'test',
    });

    await expect(
      bounded.get(new URL('https://iceberg.apache.org/javadoc/content-type'), {
        acceptedContentTypes: ['text/plain'],
        maxBytes: 10,
        retries: 0,
      }),
    ).rejects.toThrow(/content type/u);
    await expect(
      bounded.get(new URL('https://iceberg.apache.org/javadoc/declared-length'), {
        acceptedContentTypes: ['text/plain'],
        maxBytes: 10,
        retries: 0,
      }),
    ).rejects.toThrow(/exceeds/u);

    expect(contentTypeCancel).toHaveBeenCalledOnce();
    expect(declaredLengthCancel).toHaveBeenCalledOnce();
  });

  it('accepts bounded JSON suffix content, empty bodies, and same-root redirects', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith('/redirect')) {
        return Promise.resolve(
          new Response(null, { headers: { location: './result' }, status: 302 }),
        );
      }
      if (url.pathname.endsWith('/empty')) {
        return Promise.resolve(
          new Response(null, { headers: { 'content-type': 'application/problem+json' } }),
        );
      }
      return Promise.resolve(
        new Response('{"ok":true}', {
          headers: { 'content-type': 'application/problem+json; charset=utf-8' },
        }),
      );
    });
    const bounded = new BoundedFetcher({
      allowedBaseUrl: new URL('https://iceberg.apache.org/javadoc/'),
      concurrency: 1,
      fetch,
      timeoutMs: 1_000,
      userAgent: 'test',
    });

    const redirected = await bounded.get(new URL('https://iceberg.apache.org/javadoc/redirect'), {
      acceptedContentTypes: ['application/problem+json'],
      maxBytes: 100,
      retries: 0,
    });
    expect(new TextDecoder().decode(redirected.body)).toBe('{"ok":true}');
    const empty = await bounded.get(new URL('https://iceberg.apache.org/javadoc/empty'), {
      acceptedContentTypes: ['application/problem+json'],
      maxBytes: 100,
      retries: 0,
    });
    expect(empty.body).toHaveLength(0);
  });

  it('rejects credential URLs, invalid redirects, statuses, and content types', async (): Promise<void> => {
    const responses = [
      new Response(null, { status: 302 }),
      new Response('missing', { status: 404 }),
      new Response('html', { headers: { 'content-type': 'text/html' } }),
    ];
    const bounded = new BoundedFetcher({
      allowedBaseUrl: new URL('https://iceberg.apache.org/javadoc/'),
      concurrency: 1,
      fetch: (): Promise<Response> =>
        Promise.resolve(responses.shift() ?? new Response('unexpected')),
      timeoutMs: 1_000,
      userAgent: 'test',
    });
    const options = { acceptedContentTypes: ['application/json'], maxBytes: 100, retries: 0 };

    await expect(
      bounded.get(new URL('https://user:pass@iceberg.apache.org/javadoc/a'), options),
    ).rejects.toThrow(/credentials/u);
    await expect(
      bounded.get(new URL('https://iceberg.apache.org/javadoc/a'), options),
    ).rejects.toThrow(/invalid redirect/u);
    await expect(
      bounded.get(new URL('https://iceberg.apache.org/javadoc/b'), options),
    ).rejects.toThrow(/HTTP 404/u);
    await expect(
      bounded.get(new URL('https://iceberg.apache.org/javadoc/c'), options),
    ).rejects.toThrow(/content type/u);
  });

  it('retries eligible upstream failures and honors caller cancellation', async (): Promise<void> => {
    let calls = 0;
    const bounded = new BoundedFetcher({
      allowedBaseUrl: new URL('https://iceberg.apache.org/javadoc/'),
      concurrency: 1,
      fetch: (_input, init): Promise<Response> => {
        if (init?.signal?.aborted === true) {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        }
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? new Response('busy', { status: 503 })
            : new Response('ok', { headers: { 'content-type': 'text/plain' } }),
        );
      },
      timeoutMs: 1_000,
      userAgent: 'test',
    });

    const result = await bounded.get(new URL('https://iceberg.apache.org/javadoc/retry'), {
      acceptedContentTypes: ['text/plain'],
      maxBytes: 100,
      retries: 1,
    });
    expect(new TextDecoder().decode(result.body)).toBe('ok');
    expect(calls).toBe(2);

    const controller = new AbortController();
    controller.abort();
    await expect(
      bounded.get(new URL('https://iceberg.apache.org/javadoc/cancelled'), {
        acceptedContentTypes: ['text/plain'],
        maxBytes: 100,
        retries: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe('bounded body readers', (): void => {
  function streamed(chunks: readonly string[], cancel = vi.fn(), close = true): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel,
        start(controller): void {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          if (close) {
            controller.close();
          }
        },
      }),
    );
  }

  it('accepts bodies up to the exact limit and rejects one byte more', async (): Promise<void> => {
    expect(new TextDecoder().decode(await readBounded(streamed(['ab', 'cd']), 4))).toBe('abcd');
    await expect(readBounded(streamed(['ab', 'cd', 'e']), 4)).rejects.toThrow(LimitError);
    await expect(readBounded(streamed(['ab', 'cd', 'e']), 4)).rejects.toThrow(
      /Upstream response exceeds 4 bytes/u,
    );
    await expect(readBounded(streamed(['x'.repeat(5)]), 4, 'Catalog response')).rejects.toThrow(
      /Catalog response exceeds 4 bytes/u,
    );
  });

  it('cancels streams that overflow or declare an oversized length', async (): Promise<void> => {
    const overflowCancel = vi.fn();
    await expect(readBounded(streamed(['abc', 'def'], overflowCancel, false), 4)).rejects.toThrow(
      LimitError,
    );
    expect(overflowCancel).toHaveBeenCalledOnce();

    const declaredCancel = vi.fn();
    const declared = new Response(
      new ReadableStream<Uint8Array>({
        cancel: declaredCancel,
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('ab'));
        },
      }),
      { headers: { 'content-length': '5' } },
    );
    await expect(readBounded(declared, 4)).rejects.toThrow(/exceeds 4 bytes/u);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(declaredCancel).toHaveBeenCalledOnce();
  });

  it('returns empty output for bodiless responses and decodes strict UTF-8', async (): Promise<void> => {
    expect(await readBounded(new Response(null), 4)).toHaveLength(0);
    expect(await readBoundedText(new Response(null), 4)).toBe('');
    expect(await readBoundedText(new Response('héllo'), 6)).toBe('héllo');
    await expect(
      readBoundedText(new Response(new Uint8Array([0xff, 0xfe])), 4, 'Catalog response'),
    ).rejects.toMatchObject({
      message: 'Catalog response is not valid UTF-8',
      name: 'UpstreamError',
      retryable: false,
      status: 502,
    });
    await expect(readBoundedText(new Response('héllo'), 5)).rejects.toThrow(LimitError);
  });
});

describe('tool responses', (): void => {
  it('returns bounded structured success content', async (): Promise<void> => {
    const reporter = { report: vi.fn() };
    const response = await executeTool(
      () => Promise.resolve({ count: 1 }),
      (result) => `Count: ${result.count}`,
      reporter,
      1_000,
    );

    expect(response).toMatchObject({
      content: [{ text: 'Count: 1', type: 'text' }],
      structuredContent: { count: 1 },
    });
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('normalizes expected, upstream, oversized, and unexpected failures', async (): Promise<void> => {
    const reporter = { report: vi.fn() };
    const expected = await executeTool(
      () => Promise.reject(new InputError('bad cursor')),
      () => 'unused',
      reporter,
      1_000,
    );
    expect(expected).toMatchObject({
      isError: true,
      structuredContent: { error: { correlation_id: null, message: 'bad cursor' } },
    });

    const upstream = await executeTool(
      () =>
        Promise.reject(
          new UpstreamError('commit conflict', 409, false, undefined, {
            code: 409,
            type: 'CommitFailedException',
          }),
        ),
      () => 'unused',
      reporter,
      1_000,
    );
    expect(upstream.structuredContent).toMatchObject({
      error: {
        iceberg_code: 409,
        iceberg_type: 'CommitFailedException',
        retryable: false,
        status: 409,
      },
    });

    const oversized = await executeTool(
      () => Promise.resolve({ value: 'x'.repeat(100) }),
      () => 'unused',
      reporter,
      20,
    );
    expect(oversized).toMatchObject({
      isError: true,
      structuredContent: { error: { type: 'LimitError' } },
    });

    const unexpected = await executeTool(
      () => Promise.reject(new Error('sensitive internal detail')),
      () => 'unused',
      reporter,
      1_000,
    );
    expect(unexpected).toMatchObject({
      isError: true,
      structuredContent: {
        error: { message: 'Internal error', type: 'InternalError' },
      },
    });
    expect(
      (unexpected.structuredContent as { error: { correlation_id: string } }).error.correlation_id,
    ).toMatch(/^[0-9a-f-]{36}$/u);
    expect(reporter.report).toHaveBeenCalledTimes(1);
  });

  it('bounds rendered text and expected error details', async (): Promise<void> => {
    const reporter = { report: vi.fn() };
    const rendered = await executeTool(
      () => Promise.resolve({ ok: true }),
      () => 'x'.repeat(5_000),
      reporter,
      4_096,
    );
    expect(rendered).toMatchObject({
      isError: true,
      structuredContent: { error: { type: 'LimitError' } },
    });

    const expected = await executeTool(
      () => Promise.reject(new InputError('x'.repeat(10_000))),
      () => 'unused',
      reporter,
      4_096,
    );
    expect(expected).toMatchObject({
      isError: true,
      structuredContent: { error: { type: 'LimitError' } },
    });
    expect(JSON.stringify(expected).length).toBeLessThanOrEqual(4_096);
  });
});

function stderrLines(write: MockInstance<typeof process.stderr.write>): Record<string, unknown>[] {
  return write.mock.calls.map((call) => {
    const line = String(call[0]);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    return JSON.parse(line) as Record<string, unknown>;
  });
}

describe('structured error logging', (): void => {
  it('records the real message and omits the stack below debug', (): void => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    stderrReporter.report(new InputError('namespace is required'), 'tool.call', 'correlation-id');

    const [entry] = stderrLines(write);
    expect(entry).toMatchObject({
      correlation_id: 'correlation-id',
      error_name: 'InputError',
      event: 'tool.call',
      level: 'error',
      message: 'namespace is required',
    });
    expect(entry).not.toHaveProperty('stack');
    expect(String(entry?.['ts'])).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('adds a redacted stack only at debug level', (): void => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = new Error('failed');
    error.stack = 'Error: failed\n    at load (authorization: Bearer stack-secret)';

    createStderrReporter('error').report(error, 'transport.stdio');
    createStderrReporter('info').report(error, 'transport.stdio');
    createStderrReporter('debug').report(error, 'transport.stdio');

    const entries = stderrLines(write);
    expect(entries).toHaveLength(3);
    expect(entries[0]).not.toHaveProperty('stack');
    expect(entries[1]).not.toHaveProperty('stack');
    expect(entries[2]?.['stack']).toContain('at load');
    expect(JSON.stringify(entries)).not.toContain('stack-secret');
  });

  it('redacts credentials in the message and names non-error throws', (): void => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    stderrReporter.report(new Error('rejected authorization: Bearer sensitive-token'), 'tool.call');
    stderrReporter.report('boom', 'tool.call');

    const entries = stderrLines(write);
    expect(entries[0]?.['message']).toBe('rejected authorization: [REDACTED]');
    expect(JSON.stringify(entries)).not.toContain('sensitive-token');
    expect(entries[1]).toMatchObject({
      correlation_id: null,
      error_name: 'NonErrorThrown',
      message: 'An unknown error occurred',
    });
  });
});

describe('mutation audit log', (): void => {
  const mutation = {
    args: {
      namespace: ['analytics'],
      properties: { 'gcs.oauth2.token': 'private', owner: 'data-eng' },
      token: new Secret('catalog-secret'),
    },
    correlationId: 'correlation-id',
    durationMs: 42,
    idempotencyKey: '018f0d3e-0000-7000-8000-000000000000',
    identifier: 'analytics.events',
    operation: 'dropTable',
    outcome: 'success',
    status: 204,
  } as const;

  it('writes one redacted line per catalog mutation', (): void => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    auditLog(mutation);

    const [entry] = stderrLines(write);
    expect(entry).toMatchObject({
      correlation_id: 'correlation-id',
      duration_ms: 42,
      event: 'catalog.mutation',
      idempotency_key: '018f0d3e-0000-7000-8000-000000000000',
      identifier: 'analytics.events',
      level: 'info',
      operation: 'dropTable',
      outcome: 'success',
      status: 204,
    });
    expect(entry?.['args']).toEqual({
      namespace: ['analytics'],
      properties: { 'gcs.oauth2.token': '[REDACTED]', owner: 'data-eng' },
      token: '[REDACTED]',
    });
    expect(JSON.stringify(entry)).not.toContain('catalog-secret');
    expect(JSON.stringify(entry)).not.toContain('private');
  });

  it('defaults optional fields and stays silent when only errors are wanted', (): void => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    auditLog(
      { durationMs: 3, identifier: 'analytics', operation: 'createNamespace', outcome: 'failure' },
      'debug',
    );
    auditLog(mutation, 'error');

    const entries = stderrLines(write);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      args: null,
      correlation_id: null,
      idempotency_key: null,
      outcome: 'failure',
      status: null,
    });
  });
});

describe('abort-aware sleep', (): void => {
  it('resolves after the delay and detaches its abort listener', async (): Promise<void> => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(1_000, controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBeUndefined();
    controller.abort();
    vi.useRealTimers();
  });

  it('resolves immediately for a non-positive delay', async (): Promise<void> => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it('rejects with the signal reason when it is already aborted', async (): Promise<void> => {
    const controller = new AbortController();
    controller.abort(new InputError('gone'));

    await expect(sleep(1_000, controller.signal)).rejects.toThrow(/gone/u);
  });

  it('rejects promptly when the signal aborts while waiting', async (): Promise<void> => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/u);
    vi.useRealTimers();
  });

  it('rejects with a plain abort error when the reason is not an Error', async (): Promise<void> => {
    const controller = new AbortController();
    controller.abort('stop');

    await expect(sleep(1_000, controller.signal)).rejects.toBeInstanceOf(DOMException);
  });
});

describe('Secret', (): void => {
  it('keeps the credential out of every accidental rendering path', (): void => {
    const secret = new Secret('catalog-secret');

    expect(secret.value()).toBe('catalog-secret');
    expect(JSON.stringify({ token: secret })).toBe('{"token":"[REDACTED]"}');
    // ESLint's restrict-template-expressions already refuses `${secret}` at compile time; these
    // cover the runtime coercions that reach a log line.
    expect(String(secret)).toBe('[REDACTED]');
    expect(format('%s: %o', secret, secret)).toBe('[REDACTED]: [REDACTED]');
    expect(inspect(secret)).toBe('[REDACTED]');
    expect(inspect({ nested: { token: secret } }, { depth: null })).not.toContain('catalog-secret');
    expect(Object.keys(secret)).toEqual([]);
    expect(JSON.stringify(Object.assign({}, secret))).toBe('{}');
  });
});
