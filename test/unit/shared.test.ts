import { describe, expect, it, vi } from 'vitest';

import { AsyncTtlCache } from '../../src/shared/cache.js';
import { BoundedFetcher } from '../../src/shared/fetch.js';
import { decodeCursor, encodeCursor, paginate } from '../../src/shared/pagination.js';

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
});
