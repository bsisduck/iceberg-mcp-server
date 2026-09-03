import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultJavadocCacheDirectory, JavadocDiskCache } from '../../src/api/javadoc-cache.js';

const temporaryDirectories: string[] = [];

async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'iceberg-javadoc-cache-unit-'));
  temporaryDirectories.push(directory);
  return directory;
}

function body(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('JavadocDiskCache', (): void => {
  it('round-trips a body with its validators and keys entries by version and URL', async (): Promise<void> => {
    const directory = await cacheDirectory();
    const cache = new JavadocDiskCache({
      config: { directory, maxBytes: 1_000_000, ttlMs: 60_000 },
    });
    const url = 'https://iceberg.apache.org/javadoc/1.11.0/type-search-index.js';

    await cache.write('1.11.0', url, {
      body: body('typeSearchIndex = [];'),
      etag: '"abc"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      storedAt: 1_000,
    });

    const stored = await cache.read('1.11.0', url);
    expect(stored).toMatchObject({
      etag: '"abc"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      storedAt: 1_000,
    });
    expect(new TextDecoder().decode(stored?.body)).toBe('typeSearchIndex = [];');
    expect(await cache.read('1.12.0', url)).toBeUndefined();
    expect(await cache.read('1.11.0', `${url}?other`)).toBeUndefined();

    await cache.touch('1.11.0', url, { ...stored!, storedAt: 1_000 });
    expect((await cache.read('1.11.0', url))?.storedAt).toBeGreaterThan(1_000);
  });

  it('drops the least recently written entries once the directory exceeds its bound', async (): Promise<void> => {
    const directory = await cacheDirectory();
    const cache = new JavadocDiskCache({ config: { directory, maxBytes: 600, ttlMs: 60_000 } });

    for (const name of ['first', 'second', 'third']) {
      await cache.write('1.11.0', `https://iceberg.apache.org/javadoc/1.11.0/${name}.js`, {
        body: body('x'.repeat(250)),
        etag: undefined,
        lastModified: undefined,
        storedAt: Date.now(),
      });
    }

    const entries = (await readdir(directory)).filter((name) => name.endsWith('.cache'));
    expect(entries.length).toBeLessThan(3);
    expect(
      await cache.read('1.11.0', 'https://iceberg.apache.org/javadoc/1.11.0/third.js'),
    ).toBeDefined();
    expect(
      await cache.read('1.11.0', 'https://iceberg.apache.org/javadoc/1.11.0/first.js'),
    ).toBeUndefined();
  });

  it('treats a truncated or foreign entry as a miss and refuses an oversized body', async (): Promise<void> => {
    const directory = await cacheDirectory();
    const cache = new JavadocDiskCache({ config: { directory, maxBytes: 1_000, ttlMs: 60_000 } });
    const url = 'https://iceberg.apache.org/javadoc/1.11.0/member-search-index.js';
    await cache.write('1.11.0', url, {
      body: body('memberSearchIndex = [];'),
      etag: undefined,
      lastModified: undefined,
      storedAt: Date.now(),
    });
    const [entry] = (await readdir(directory)).filter((name) => name.endsWith('.cache'));
    const file = path.join(directory, entry ?? '');
    const raw = await readFile(file);

    await writeFile(file, raw.subarray(0, raw.byteLength - 3));
    expect(await cache.read('1.11.0', url)).toBeUndefined();

    await writeFile(file, 'not json\nbody');
    expect(await cache.read('1.11.0', url)).toBeUndefined();

    await cache.write('1.11.0', url, {
      body: body('y'.repeat(2_000)),
      etag: undefined,
      lastModified: undefined,
      storedAt: Date.now(),
    });
    expect(await cache.read('1.11.0', url)).toBeUndefined();
  });

  it('stops writing after one warning when the directory cannot be created', async (): Promise<void> => {
    const directory = await cacheDirectory();
    const blocked = path.join(directory, 'file', 'javadoc');
    await writeFile(path.join(directory, 'file'), 'not a directory');
    const warn = vi.fn<(event: string, details: Record<string, unknown>) => void>();
    const cache = new JavadocDiskCache({
      config: { directory: blocked, maxBytes: 1_000, ttlMs: 60_000 },
      reporter: { report: vi.fn(), warn },
    });
    const document = {
      body: body('typeSearchIndex = [];'),
      etag: undefined,
      lastModified: undefined,
      storedAt: Date.now(),
    };

    await cache.write('1.11.0', 'https://iceberg.apache.org/javadoc/1.11.0/a.js', document);
    await cache.write('1.11.0', 'https://iceberg.apache.org/javadoc/1.11.0/b.js', document);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe('javadoc.cache.disabled');
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ directory: blocked });
    expect(
      await cache.read('1.11.0', 'https://iceberg.apache.org/javadoc/1.11.0/a.js'),
    ).toBeUndefined();
  });

  it('defaults to a directory under the user cache home', (): void => {
    expect(
      defaultJavadocCacheDirectory().endsWith(path.join('iceberg-mcp-server', 'javadoc')),
    ).toBe(true);
  });
});
