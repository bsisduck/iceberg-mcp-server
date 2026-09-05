import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JavadocCacheConfig } from '../../src/api/javadoc-cache.js';
import { JavadocProvider } from '../../src/api/javadoc-provider.js';

const temporaryDirectories: string[] = [];

function javascript(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { 'content-type': 'application/javascript', ...headers },
  });
}

const indexBodies = new Map<string, string>([
  ['package-search-index.js', 'packageSearchIndex = [{"l":"org.apache.iceberg"}];'],
  ['type-search-index.js', 'typeSearchIndex = [{"p":"org.apache.iceberg","l":"Table"}];'],
  [
    'member-search-index.js',
    'memberSearchIndex = [{"p":"org.apache.iceberg","c":"Table","l":"schema()"}];',
  ],
]);

/** Serves the three index files with an `ETag`, answering `304` once a validator is presented. */
function indexHost(
  bodies: ReadonlyMap<string, string> = indexBodies,
): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const filename = url.pathname.split('/').at(-1) ?? '';
    const body = bodies.get(filename);
    if (body === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    const headers = new Headers(init?.headers);
    if (headers.get('if-none-match') === `"${filename}"`) {
      return Promise.resolve(
        new Response(null, { status: 304, headers: { etag: `"${filename}"` } }),
      );
    }
    return Promise.resolve(javascript(`${body}updateSearchResults();`, { etag: `"${filename}"` }));
  });
}

async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'iceberg-javadoc-cache-'));
  temporaryDirectories.push(directory);
  return directory;
}

function cacheConfig(directory: string, ttlMs = 60_000): JavadocCacheConfig {
  return { directory, maxBytes: 1_000_000, ttlMs };
}

afterEach(async (): Promise<void> => {
  for (const directory of temporaryDirectories.splice(0)) {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { force: true, recursive: true });
  }
});

describe('JavadocProvider', (): void => {
  it('shares concurrent immutable index loads and caches type pages', async (): Promise<void> => {
    const responses = new Map<string, Response>([
      [
        'package-search-index.js',
        javascript('packageSearchIndex = [{"l":"org.apache.iceberg"}];updateSearchResults();'),
      ],
      [
        'type-search-index.js',
        javascript(
          'typeSearchIndex = [{"p":"org.apache.iceberg","l":"Table"}];updateSearchResults();',
        ),
      ],
      [
        'member-search-index.js',
        javascript(
          'memberSearchIndex = [{"p":"org.apache.iceberg","c":"Table","l":"schema()"}];updateSearchResults();',
        ),
      ],
      [
        'Table.html',
        new Response('<main><h1 class="title">Interface Table</h1></main>', {
          headers: { 'content-type': 'text/html' },
        }),
      ],
    ]);
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const response = [...responses].find(([suffix]) => url.pathname.endsWith(suffix))?.[1];
      return Promise.resolve(response?.clone() ?? new Response('not found', { status: 404 }));
    });
    const provider = new JavadocProvider({
      config: {
        baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
        cache: undefined,
        indexMaxBytes: 32_000_000,
        version: '1.11.0',
      },
      fetch,
      requestTimeoutMs: 1_000,
    });

    const [first, second] = await Promise.all([
      provider.loadIndex('1.11.0'),
      provider.loadIndex('1.11.0'),
    ]);
    expect(first).toBe(second);
    expect(first).toMatchObject({ version: '1.11.0' });
    expect(fetch).toHaveBeenCalledTimes(3);

    const [type, cachedType] = await Promise.all([
      provider.getType('1.11.0', 'org.apache.iceberg.Table'),
      provider.getType('1.11.0', 'org.apache.iceberg.Table'),
    ]);
    expect(type.documentation.title).toBe('Interface Table');
    expect(cachedType).toEqual(type);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('reports an undecodable index body as a retryable upstream failure', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(new Uint8Array([0xff, 0xfe, 0xfd]), {
          headers: { 'content-type': 'application/javascript' },
        }),
      ),
    );
    const provider = new JavadocProvider({
      config: {
        baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
        cache: undefined,
        indexMaxBytes: 32_000_000,
        version: '1.11.0',
      },
      fetch,
      requestTimeoutMs: 1_000,
    });

    await expect(provider.loadIndex('1.11.0')).rejects.toMatchObject({
      name: 'UpstreamError',
      retryable: true,
      status: 502,
    });
  });

  it('warns and fails when a search index exceeds the configured ceiling', async (): Promise<void> => {
    const warn = vi.fn<(event: string, details: Record<string, unknown>) => void>();
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        javascript('memberSearchIndex = [{"p":"org.apache.iceberg","c":"Table","l":"schema()"}];'),
      ),
    );
    const provider = new JavadocProvider({
      config: {
        baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
        cache: undefined,
        indexMaxBytes: 16,
        version: '1.11.0',
      },
      fetch,
      reporter: { report: vi.fn(), warn },
      requestTimeoutMs: 1_000,
    });

    await expect(provider.loadIndex('1.11.0')).rejects.toMatchObject({ name: 'LimitError' });
    expect(warn).toHaveBeenCalledWith('javadoc.index.too_large', {
      filename: 'member-search-index.js',
      maxBytes: 16,
    });
  });

  it('serves a fresh index from disk across provider restarts', async (): Promise<void> => {
    const directory = await cacheDirectory();
    const fetch = indexHost();
    const options = {
      config: {
        baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
        cache: cacheConfig(directory),
        indexMaxBytes: 32_000_000,
        version: '1.11.0',
      },
      fetch,
      requestTimeoutMs: 1_000,
    };

    await new JavadocProvider(options).loadIndex('1.11.0');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await readdir(directory)).filter((name) => name.endsWith('.cache'))).toHaveLength(3);

    const restarted = await new JavadocProvider(options).loadIndex('1.11.0');
    expect(restarted.types[0]?.fullyQualifiedName).toBe('org.apache.iceberg.Table');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('revalidates a stale entry and reuses the stored body on 304', async (): Promise<void> => {
    const directory = await cacheDirectory();
    const fetch = indexHost();
    const options = {
      config: {
        baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
        cache: cacheConfig(directory, 0),
        indexMaxBytes: 32_000_000,
        version: '1.11.0',
      },
      fetch,
      requestTimeoutMs: 1_000,
    };

    await new JavadocProvider(options).loadIndex('1.11.0');
    const revalidated = await new JavadocProvider(options).loadIndex('1.11.0');

    expect(fetch).toHaveBeenCalledTimes(6);
    expect(revalidated.members[0]?.label).toBe('schema()');
    const conditional = fetch.mock.calls.filter(
      ([, init]) => new Headers(init?.headers).get('if-none-match') !== null,
    );
    expect(conditional).toHaveLength(3);
  });

  it.each([60_000, 0])(
    'enforces a lowered index limit after restarting with cache TTL %i',
    async (ttlMs): Promise<void> => {
      const directory = await cacheDirectory();
      const bodies = new Map(indexBodies);
      const filename = 'member-search-index.js';
      bodies.set(filename, bodies.get(filename)!.replace('];', `${' '.repeat(1_010_000)}];`));
      const fetch = indexHost(bodies);
      const warn = vi.fn<(event: string, details: Record<string, unknown>) => void>();
      const options = {
        config: {
          baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
          cache: { directory, maxBytes: 10_000_000, ttlMs },
          indexMaxBytes: 2_000_000,
          version: '1.11.0',
        },
        fetch,
        reporter: { report: vi.fn(), warn },
        requestTimeoutMs: 1_000,
      };
      await new JavadocProvider(options).loadIndex('1.11.0');
      fetch.mockClear();

      const restarted = new JavadocProvider({
        ...options,
        config: { ...options.config, indexMaxBytes: 1_000_000 },
      });
      await expect(restarted.loadIndex('1.11.0')).rejects.toMatchObject({ name: 'LimitError' });
      expect(warn).toHaveBeenCalledWith('javadoc.index.too_large', {
        filename,
        maxBytes: 1_000_000,
      });
      const memberRequests = fetch.mock.calls.filter(([input]) =>
        new URL(input instanceof Request ? input.url : input).pathname.endsWith(filename),
      );
      expect(memberRequests).toHaveLength(1);
      expect(new Headers(memberRequests[0]?.[1]?.headers).has('if-none-match')).toBe(false);

      // A smaller upstream replacement can still be loaded with the same cache and limit.
      bodies.set(filename, indexBodies.get(filename)!);
      const recovered = await new JavadocProvider({
        ...options,
        config: { ...options.config, indexMaxBytes: 1_000_000 },
      }).loadIndex('1.11.0');
      expect(recovered.members[0]?.label).toBe('schema()');
    },
  );

  it('writes nothing when the cache is disabled', async (): Promise<void> => {
    const directory = await cacheDirectory();
    const fetch = indexHost();

    await new JavadocProvider({
      config: {
        baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
        cache: undefined,
        indexMaxBytes: 32_000_000,
        version: '1.11.0',
      },
      fetch,
      requestTimeoutMs: 1_000,
    }).loadIndex('1.11.0');

    expect(await readdir(directory)).toHaveLength(0);
  });

  it('warns once and keeps serving when the cache directory cannot be written', async (): Promise<void> => {
    const directory = await cacheDirectory();
    await chmod(directory, 0o500);
    const warn = vi.fn<(event: string, details: Record<string, unknown>) => void>();
    const fetch = indexHost();

    const index = await new JavadocProvider({
      config: {
        baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
        cache: cacheConfig(path.join(directory, 'javadoc')),
        indexMaxBytes: 32_000_000,
        version: '1.11.0',
      },
      fetch,
      reporter: { report: vi.fn(), warn },
      requestTimeoutMs: 1_000,
    }).loadIndex('1.11.0');

    expect(index.packages[0]?.name).toBe('org.apache.iceberg');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe('javadoc.cache.disabled');
  });

  it('rejects unbounded version identifiers before fetching', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new JavadocProvider({
      config: {
        baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
        cache: undefined,
        indexMaxBytes: 32_000_000,
        version: '1.11.0',
      },
      fetch,
      requestTimeoutMs: 1_000,
    });

    await expect(provider.loadIndex('../nightly')).rejects.toThrow(/release number or nightly/u);
    expect(fetch).not.toHaveBeenCalled();
  });
});
