import { TextDecoder } from 'node:util';

import type { JavadocConfig } from '../config.js';
import type { CachedDocument } from './javadoc-cache.js';
import { JavadocDiskCache } from './javadoc-cache.js';
import { AsyncTtlCache } from '../shared/cache.js';
import { BoundedFetcher } from '../shared/fetch.js';
import { InputError, LimitError, NotFoundError, UpstreamError } from '../shared/errors.js';
import type { ErrorReporter } from '../shared/logging.js';
import { stderrReporter } from '../shared/logging.js';
import { isIcebergVersion } from '../shared/iceberg-version.js';
import { USER_AGENT } from '../version.js';
import {
  parseMemberIndex,
  parsePackageIndex,
  parseTypeDocumentation,
  parseTypeIndex,
} from './javadoc-parser.js';
import type { JavadocIndex, TypeDocumentation, TypeRecord } from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
/**
 * Ceiling on one downloaded search index. Iceberg's member index is around 32 MB, which is what the
 * default admits; `ICEBERG_JAVADOC_INDEX_MAX_BYTES` moves it for a fork with a larger API surface.
 */
export const DEFAULT_JAVADOC_INDEX_MAX_BYTES = 32_000_000;

export interface JavadocProviderOptions {
  readonly config: JavadocConfig;
  readonly fetch?: typeof globalThis.fetch;
  readonly reporter?: ErrorReporter | undefined;
  readonly requestTimeoutMs: number;
}

function versionTtl(version: string): number {
  return version === 'nightly' ? 5 * 60_000 : 24 * 60 * 60_000;
}

/** The validators that let the host answer `304` instead of resending an unchanged body. */
function conditionalHeaders(cached: CachedDocument): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (cached.etag !== undefined) {
    headers['if-none-match'] = cached.etag;
  }
  if (cached.lastModified !== undefined) {
    headers['if-modified-since'] = cached.lastModified;
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

/**
 * A body the Javadoc host sent that is not valid UTF-8 is an upstream problem, not caller input: a
 * truncated transfer decodes exactly this way, so the failure is reported as retryable.
 */
function decodeBody(body: Uint8Array, label: string): string {
  try {
    return decoder.decode(body);
  } catch (error) {
    throw new UpstreamError(`${label} is not valid UTF-8`, 502, true, { cause: error });
  }
}

export class JavadocProvider {
  readonly #baseUrl: URL;
  readonly #cache: JavadocDiskCache | undefined;
  readonly #fetcher: BoundedFetcher;
  readonly #indexMaxBytes: number;
  readonly #reporter: ErrorReporter;
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
    this.#indexMaxBytes = options.config.indexMaxBytes;
    this.#reporter = options.reporter ?? stderrReporter;
    this.#cache =
      options.config.cache === undefined
        ? undefined
        : new JavadocDiskCache({ config: options.config.cache, reporter: this.#reporter });
    this.#fetcher = new BoundedFetcher({
      allowedBaseUrl: this.#baseUrl,
      concurrency: 4,
      fetch: options.fetch,
      timeoutMs: options.requestTimeoutMs,
      userAgent: USER_AGENT,
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
        this.#loadIndexFile(root, 'package-search-index.js', 512_000, version, signal),
        this.#loadIndexFile(root, 'type-search-index.js', 4_000_000, version, signal),
        this.#loadIndexFile(root, 'member-search-index.js', this.#indexMaxBytes, version, signal),
      ]);
      const parseOptions = { reporter: this.#reporter };
      return {
        loadedAt: new Date(),
        members: parseMemberIndex(members, root, parseOptions),
        packages: parsePackageIndex(packages, root, parseOptions),
        types: parseTypeIndex(types, root, parseOptions),
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
    const documentation = await cache.getOrLoad(record.url, async () =>
      parseTypeDocumentation(
        await this.#retrieve({
          acceptedContentTypes: ['text/html'],
          label: 'Javadoc page',
          maxBytes: 2_000_000,
          signal,
          url: new URL(record.url),
          version,
        }),
      ),
    );
    return { documentation, record };
  }

  async #loadIndexFile(
    root: URL,
    filename: string,
    maxBytes: number,
    version: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    try {
      return await this.#retrieve({
        acceptedContentTypes: ['application/javascript', 'text/javascript'],
        label: filename,
        maxBytes,
        signal,
        url: new URL(filename, root),
        version,
      });
    } catch (error) {
      if (error instanceof LimitError) {
        this.#reporter.warn?.('javadoc.index.too_large', { filename, maxBytes });
      }
      throw error;
    }
  }

  /**
   * One Javadoc document, from the on-disk cache when it is still fresh, revalidated with the stored
   * validators when it is not, and downloaded otherwise. Only a body that downloaded, decoded, and
   * stayed inside its byte bound is stored, so an error response is never cached.
   */
  async #retrieve(options: {
    readonly acceptedContentTypes: readonly string[];
    readonly label: string;
    readonly maxBytes: number;
    readonly signal: AbortSignal | undefined;
    readonly url: URL;
    readonly version: string;
  }): Promise<string> {
    const key = options.url.href;
    const cached = await this.#cache?.read(options.version, key);
    if (cached !== undefined && Date.now() - cached.storedAt < this.#cacheTtlMs(options.version)) {
      return decodeBody(cached.body, options.label);
    }
    const conditional = cached === undefined ? undefined : conditionalHeaders(cached);
    const result = await this.#fetcher.get(options.url, {
      acceptedContentTypes: options.acceptedContentTypes,
      maxBytes: options.maxBytes,
      signal: options.signal,
      ...(conditional === undefined ? {} : { allowNotModified: true, headers: conditional }),
    });
    if (result.notModified && cached !== undefined) {
      await this.#cache?.touch(options.version, key, cached);
      return decodeBody(cached.body, options.label);
    }
    const text = decodeBody(result.body, options.label);
    await this.#cache?.write(options.version, key, {
      body: result.body,
      etag: result.etag,
      lastModified: result.lastModified,
      storedAt: Date.now(),
    });
    return text;
  }

  /** Nightly Javadoc is republished continuously, so it revalidates long before the configured TTL. */
  #cacheTtlMs(version: string): number {
    return Math.min(this.#cache?.ttlMs ?? 0, versionTtl(version));
  }

  #assertVersion(version: string): void {
    if (!isIcebergVersion(version)) {
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
