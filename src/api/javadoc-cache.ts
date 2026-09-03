import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { errorMessage } from '../shared/errors.js';
import type { ErrorReporter } from '../shared/logging.js';
import { stderrReporter } from '../shared/logging.js';

export const DEFAULT_JAVADOC_CACHE_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_JAVADOC_CACHE_MAX_BYTES = 268_435_456;

const ENTRY_SUFFIX = '.cache';
/** Bumped when the on-disk layout changes; an entry written by another layout is ignored. */
const ENTRY_LAYOUT = 1;

/** `~/.cache` keeps a re-downloadable artifact out of the way of backups and of the repository. */
export function defaultJavadocCacheDirectory(): string {
  return path.join(homedir(), '.cache', 'iceberg-mcp-server', 'javadoc');
}

export interface JavadocCacheConfig {
  readonly directory: string;
  readonly maxBytes: number;
  readonly ttlMs: number;
}

export interface CachedDocument {
  readonly body: Uint8Array;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  readonly storedAt: number;
}

interface EntryHeader {
  readonly etag?: string;
  readonly lastModified?: string;
  readonly layout: number;
  readonly length: number;
  readonly storedAt: number;
  readonly url: string;
  readonly version: string;
}

function isEntryHeader(value: unknown): value is EntryHeader {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<EntryHeader>;
  return (
    candidate.layout === ENTRY_LAYOUT &&
    typeof candidate.length === 'number' &&
    typeof candidate.storedAt === 'number' &&
    typeof candidate.url === 'string' &&
    typeof candidate.version === 'string'
  );
}

/**
 * A content-addressed cache for downloaded Javadoc bodies, so a restart does not re-download the
 * 32 MB member index. One entry is one file: a single-line JSON header — the version, URL, validators
 * and body length it was stored with — then a newline, then the body bytes, written to a temporary
 * name and renamed into place so a reader never sees a partial entry.
 *
 * The cache is an optimization, never a dependency: any failure to write disables it for the process
 * after one warning, and any unreadable entry is treated as a miss.
 */
export class JavadocDiskCache {
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #reporter: ErrorReporter;
  readonly #ttlMs: number;
  #disabled = false;

  public constructor(options: {
    readonly config: JavadocCacheConfig;
    readonly reporter?: ErrorReporter | undefined;
  }) {
    this.#directory = options.config.directory;
    this.#maxBytes = options.config.maxBytes;
    this.#reporter = options.reporter ?? stderrReporter;
    this.#ttlMs = options.config.ttlMs;
  }

  public get directory(): string {
    return this.#directory;
  }

  public get ttlMs(): number {
    return this.#ttlMs;
  }

  public async read(version: string, url: string): Promise<CachedDocument | undefined> {
    if (this.#disabled) {
      return undefined;
    }
    let raw: Buffer;
    try {
      raw = await readFile(this.#entryPath(version, url));
    } catch {
      return undefined;
    }
    const newline = raw.indexOf(0x0a);
    if (newline <= 0 || raw.byteLength > this.#maxBytes) {
      return undefined;
    }
    let header: unknown;
    try {
      header = JSON.parse(raw.subarray(0, newline).toString('utf8'));
    } catch {
      return undefined;
    }
    const body = raw.subarray(newline + 1);
    if (!isEntryHeader(header) || header.url !== url || header.version !== version) {
      return undefined;
    }
    if (body.byteLength !== header.length) {
      return undefined;
    }
    return {
      body,
      etag: header.etag,
      lastModified: header.lastModified,
      storedAt: header.storedAt,
    };
  }

  public async write(version: string, url: string, document: CachedDocument): Promise<void> {
    if (this.#disabled || document.body.byteLength > this.#maxBytes) {
      return;
    }
    const header: EntryHeader = {
      ...(document.etag === undefined ? {} : { etag: document.etag }),
      ...(document.lastModified === undefined ? {} : { lastModified: document.lastModified }),
      layout: ENTRY_LAYOUT,
      length: document.body.byteLength,
      storedAt: document.storedAt,
      url,
      version,
    };
    const temporary = path.join(this.#directory, `${randomUUID()}.tmp`);
    try {
      await mkdir(this.#directory, { recursive: true });
      await writeFile(
        temporary,
        Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), document.body]),
        { mode: 0o600 },
      );
      await rename(temporary, this.#entryPath(version, url));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      this.#disable(error);
      return;
    }
    await this.#evict();
  }

  /** Records that a revalidated entry is fresh again, without downloading the body a second time. */
  public async touch(version: string, url: string, document: CachedDocument): Promise<void> {
    await this.write(version, url, { ...document, storedAt: Date.now() });
  }

  #entryPath(version: string, url: string): string {
    const key = createHash('sha256').update(`${version}\n${url}`).digest('hex');
    return path.join(this.#directory, `${key}${ENTRY_SUFFIX}`);
  }

  #disable(error: unknown): void {
    if (this.#disabled) {
      return;
    }
    this.#disabled = true;
    this.#reporter.warn?.('javadoc.cache.disabled', {
      directory: this.#directory,
      message: errorMessage(error),
    });
  }

  /** Keeps the directory under its ceiling by dropping the least recently written entries. */
  async #evict(): Promise<void> {
    try {
      const names = await readdir(this.#directory);
      const entries: { modifiedMs: number; name: string; size: number }[] = [];
      let total = 0;
      for (const name of names) {
        if (!name.endsWith(ENTRY_SUFFIX)) {
          continue;
        }
        const metadata = await stat(path.join(this.#directory, name)).catch(() => undefined);
        if (metadata?.isFile() !== true) {
          continue;
        }
        entries.push({ modifiedMs: metadata.mtimeMs, name, size: metadata.size });
        total += metadata.size;
      }
      if (total <= this.#maxBytes) {
        return;
      }
      entries.sort((left, right) => left.modifiedMs - right.modifiedMs);
      for (const entry of entries) {
        if (total <= this.#maxBytes) {
          return;
        }
        await rm(path.join(this.#directory, entry.name), { force: true });
        total -= entry.size;
      }
    } catch {
      // An eviction that cannot run leaves the cache larger than configured, which is not worth
      // failing a request over; the next write tries again.
    }
  }
}
