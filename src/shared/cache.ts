export interface CacheOptions {
  readonly maxEntries: number;
  readonly negativeTtlMs: number;
  readonly ttlMs: number;
}

interface CacheEntry<T> {
  readonly expiresAt: number;
  readonly promise: Promise<T>;
}

export class AsyncTtlCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #options: CacheOptions;

  public constructor(options: CacheOptions) {
    this.#options = options;
  }

  public get size(): number {
    return this.#entries.size;
  }

  public clear(): void {
    this.#entries.clear();
  }

  public getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.#entries.get(key);
    if (cached !== undefined && cached.expiresAt > now) {
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return cached.promise;
    }
    if (cached !== undefined) {
      this.#entries.delete(key);
    }

    const entry: CacheEntry<T> = {
      expiresAt: now + this.#options.ttlMs,
      promise: loader(),
    };
    this.#entries.set(key, entry);
    this.#evict();
    void entry.promise.catch(() => {
      const current = this.#entries.get(key);
      if (current === entry) {
        this.#entries.set(key, {
          expiresAt: Date.now() + this.#options.negativeTtlMs,
          promise: entry.promise,
        });
      }
    });
    return entry.promise;
  }

  #evict(): void {
    while (this.#entries.size > this.#options.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.#entries.delete(oldest);
    }
  }
}
