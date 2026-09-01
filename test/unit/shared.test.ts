import { describe, expect, it, vi } from 'vitest';

import { AsyncTtlCache } from '../../src/shared/cache.js';
import { BoundedFetcher } from '../../src/shared/fetch.js';
import { InputError, UpstreamError } from '../../src/shared/errors.js';
import {
  decodeCursor,
  decodeTokenCursor,
  encodeCursor,
  encodeTokenCursor,
  paginate,
} from '../../src/shared/pagination.js';
import { executeTool } from '../../src/shared/responses.js';

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

describe('tool responses', (): void => {
  it('returns bounded structured success content', async (): Promise<void> => {
    const reporter = { report: vi.fn() };
    const response = await executeTool(
      () => Promise.resolve({ count: 1 }),
      (result) => `Count: ${result.count}`,
      reporter,
      100,
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
      100,
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
      100,
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
      100,
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
});
