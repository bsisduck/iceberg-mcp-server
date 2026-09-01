import { setTimeout as delay } from 'node:timers/promises';

import { LimitError, UpstreamError } from './errors.js';

export interface BoundedFetchOptions {
  readonly acceptedContentTypes: readonly string[];
  readonly maxBytes: number;
  readonly retries?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface BoundedFetchResult {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly retrievedAt: Date;
  readonly url: URL;
}

export interface BoundedFetcherOptions {
  readonly allowedBaseUrl: URL;
  readonly concurrency: number;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly timeoutMs: number;
  readonly userAgent: string;
}

class Semaphore {
  readonly #waiting: (() => void)[] = [];
  #available: number;

  public constructor(concurrency: number) {
    this.#available = concurrency;
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

function contentTypeMatches(actual: string, accepted: readonly string[]): boolean {
  const mediaType = actual.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return accepted.some((candidate) => candidate.toLowerCase() === mediaType);
}

function retryDelay(attempt: number): number {
  return Math.min(1_000, 100 * 2 ** attempt) + Math.floor(Math.random() * 50);
}

function cancelBody(response: Response): void {
  if (response.body !== null) {
    void response.body.cancel().catch(() => undefined);
  }
}

export class BoundedFetcher {
  readonly #allowedBaseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #semaphore: Semaphore;
  readonly #timeoutMs: number;
  readonly #userAgent: string;

  public constructor(options: BoundedFetcherOptions) {
    this.#allowedBaseUrl = new URL(options.allowedBaseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#semaphore = new Semaphore(options.concurrency);
    this.#timeoutMs = options.timeoutMs;
    this.#userAgent = options.userAgent;
  }

  public async get(url: URL, options: BoundedFetchOptions): Promise<BoundedFetchResult> {
    this.#assertAllowed(url);
    return this.#semaphore.use(async () => {
      const retries = options.retries ?? 2;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          return await this.#getOnce(url, options);
        } catch (error) {
          if (!(error instanceof UpstreamError) || !error.retryable || attempt >= retries) {
            throw error;
          }
          await delay(retryDelay(attempt), undefined, { signal: options.signal });
        }
      }
      throw new UpstreamError('Upstream retry limit exceeded', 502, false);
    });
  }

  async #getOnce(url: URL, options: BoundedFetchOptions): Promise<BoundedFetchResult> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.#timeoutMs);
    const combinedSignal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]);
    try {
      let current = new URL(url);
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const response = await this.#fetch(current, {
          headers: {
            accept: options.acceptedContentTypes.join(', '),
            'user-agent': this.#userAgent,
          },
          redirect: 'manual',
          signal: combinedSignal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location === null || redirects === 3) {
            cancelBody(response);
            throw new UpstreamError(
              'Upstream returned an invalid redirect',
              response.status,
              false,
            );
          }
          cancelBody(response);
          current = new URL(location, current);
          this.#assertAllowed(current);
          continue;
        }
        if (!response.ok) {
          cancelBody(response);
          throw new UpstreamError(
            `Upstream returned HTTP ${response.status}`,
            response.status,
            response.status === 429 || response.status >= 500,
          );
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentTypeMatches(contentType, options.acceptedContentTypes)) {
          throw new UpstreamError(
            'Upstream returned an unexpected content type',
            response.status,
            false,
          );
        }
        const declaredLength = response.headers.get('content-length');
        if (declaredLength !== null && Number(declaredLength) > options.maxBytes) {
          throw new LimitError(`Upstream response exceeds ${options.maxBytes} bytes`);
        }
        const body = await this.#readBody(response, options.maxBytes);
        return { body, contentType, retrievedAt: new Date(), url: current };
      }
      throw new UpstreamError('Upstream redirect limit exceeded', 502, false);
    } catch (error) {
      if (timeoutController.signal.aborted && !options.signal?.aborted) {
        throw new UpstreamError('Upstream request timed out', 504, true, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #readBody(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (response.body === null) {
      return new Uint8Array();
    }
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const chunks: Uint8Array[] = [];
    let length = 0;
    let result = await reader.read();
    while (!result.done) {
      length += result.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new LimitError(`Upstream response exceeds ${maxBytes} bytes`);
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
    return output;
  }

  #assertAllowed(url: URL): void {
    if (
      url.origin !== this.#allowedBaseUrl.origin ||
      !url.pathname.startsWith(this.#allowedBaseUrl.pathname)
    ) {
      throw new UpstreamError('Upstream URL is outside the configured boundary', 400, false);
    }
    if (url.username !== '' || url.password !== '') {
      throw new UpstreamError('Upstream URL contains credentials', 400, false);
    }
  }
}
