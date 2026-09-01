import { TextDecoder } from 'node:util';

import type { JavadocConfig } from '../config.js';
import { AsyncTtlCache } from '../shared/cache.js';
import { BoundedFetcher } from '../shared/fetch.js';
import { InputError, NotFoundError } from '../shared/errors.js';
import {
  parseMemberIndex,
  parsePackageIndex,
  parseTypeDocumentation,
  parseTypeIndex,
} from './javadoc-parser.js';
import type { JavadocIndex, TypeDocumentation, TypeRecord } from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const VERSION_PATTERN = /^(?:nightly|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

export interface JavadocProviderOptions {
  readonly config: JavadocConfig;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs: number;
}

function versionTtl(version: string): number {
  return version === 'nightly' ? 5 * 60_000 : 24 * 60 * 60_000;
}

function decodeBody(body: Uint8Array, label: string): string {
  try {
    return decoder.decode(body);
  } catch (error) {
    throw new InputError(`${label} is not valid UTF-8`, { cause: error });
  }
}

export class JavadocProvider {
  readonly #baseUrl: URL;
  readonly #fetcher: BoundedFetcher;
  readonly #nightlyIndexCache = new AsyncTtlCache<JavadocIndex>({
    maxEntries: 1,
    negativeTtlMs: 10_000,
    ttlMs: versionTtl('nightly'),
  });
  readonly #nightlyPageCache = new AsyncTtlCache<TypeDocumentation>({
    maxEntries: 32,
    negativeTtlMs: 10_000,
    ttlMs: versionTtl('nightly'),
  });
  readonly #releaseIndexCache = new AsyncTtlCache<JavadocIndex>({
    maxEntries: 8,
    negativeTtlMs: 10_000,
    ttlMs: versionTtl('1.0.0'),
  });
  readonly #releasePageCache = new AsyncTtlCache<TypeDocumentation>({
    maxEntries: 128,
    negativeTtlMs: 10_000,
    ttlMs: versionTtl('1.0.0'),
  });

  public constructor(options: JavadocProviderOptions) {
    this.#baseUrl = new URL(options.config.baseUrl);
    this.#fetcher = new BoundedFetcher({
      allowedBaseUrl: this.#baseUrl,
      concurrency: 4,
      fetch: options.fetch,
      timeoutMs: options.requestTimeoutMs,
      userAgent: 'iceberg-mcp-server/0.1.0',
    });
  }

  public clear(): void {
    this.#nightlyIndexCache.clear();
    this.#nightlyPageCache.clear();
    this.#releaseIndexCache.clear();
    this.#releasePageCache.clear();
  }

  public rootUrl(version: string): URL {
    this.#assertVersion(version);
    return new URL(`${version}/`, this.#baseUrl);
  }

  public async loadIndex(version: string, signal?: AbortSignal): Promise<JavadocIndex> {
    this.#assertVersion(version);
    const cache = this.#indexCache(version);
    return cache.getOrLoad(version, async () => {
      const root = this.rootUrl(version);
      const [packages, types, members] = await Promise.all([
        this.#loadIndexFile(root, 'package-search-index.js', 512_000, signal),
        this.#loadIndexFile(root, 'type-search-index.js', 4_000_000, signal),
        this.#loadIndexFile(root, 'member-search-index.js', 32_000_000, signal),
      ]);
      return {
        loadedAt: new Date(),
        members: parseMemberIndex(members, root),
        packages: parsePackageIndex(packages, root),
        types: parseTypeIndex(types, root),
        version,
      };
    });
  }

  public async getType(
    version: string,
    fullyQualifiedName: string,
    signal?: AbortSignal,
  ): Promise<{ documentation: TypeDocumentation; record: TypeRecord }> {
    const index = await this.loadIndex(version, signal);
    const record = index.types.find(
      (candidate) => candidate.fullyQualifiedName === fullyQualifiedName,
    );
    if (record === undefined) {
      throw new NotFoundError(`Java type not found: ${fullyQualifiedName}`);
    }
    const cache = this.#pageCache(version);
    const documentation = await cache.getOrLoad(record.url, async () => {
      const result = await this.#fetcher.get(new URL(record.url), {
        acceptedContentTypes: ['text/html'],
        maxBytes: 2_000_000,
        signal,
      });
      return parseTypeDocumentation(decodeBody(result.body, 'Javadoc page'));
    });
    return { documentation, record };
  }

  async #loadIndexFile(
    root: URL,
    filename: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = await this.#fetcher.get(new URL(filename, root), {
      acceptedContentTypes: ['application/javascript', 'text/javascript'],
      maxBytes,
      signal,
    });
    return decodeBody(result.body, filename);
  }

  #assertVersion(version: string): void {
    if (!VERSION_PATTERN.test(version)) {
      throw new InputError('Iceberg version must be a release number or nightly');
    }
  }

  #indexCache(version: string): AsyncTtlCache<JavadocIndex> {
    return version === 'nightly' ? this.#nightlyIndexCache : this.#releaseIndexCache;
  }

  #pageCache(version: string): AsyncTtlCache<TypeDocumentation> {
    return version === 'nightly' ? this.#nightlyPageCache : this.#releasePageCache;
  }
}
