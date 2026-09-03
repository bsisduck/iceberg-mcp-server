import { describe, expect, it, vi } from 'vitest';

import { JavadocProvider } from '../../src/api/javadoc-provider.js';

function javascript(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/javascript' } });
}

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

  it('rejects unbounded version identifiers before fetching', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new JavadocProvider({
      config: {
        baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
        version: '1.11.0',
      },
      fetch,
      requestTimeoutMs: 1_000,
    });

    await expect(provider.loadIndex('../nightly')).rejects.toThrow(/release number or nightly/u);
    expect(fetch).not.toHaveBeenCalled();
  });
});
