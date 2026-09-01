import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'iceberg-mcp-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('loadConfig', (): void => {
  it('loads safe defaults without optional integrations', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const config = await loadConfig({}, cwd);

    expect(config.transport).toBe('stdio');
    expect(config.javadoc.version).toBe('1.11.0');
    expect(config.javadoc.baseUrl.href).toBe('https://iceberg.apache.org/javadoc/');
    expect(config.sourceDir).toBeUndefined();
    expect(config.catalog.uri).toBeUndefined();
    expect(config.catalog.allowMutations).toBe(false);
    expect(config.http).toMatchObject({
      authToken: undefined,
      host: '127.0.0.1',
      maxRequestBytes: 1_048_576,
      port: 3000,
    });
    expect(config.http.allowedOrigins).toEqual([
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://[::1]:3000',
    ]);
  });

  it('canonicalizes an explicitly configured Iceberg checkout', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const source = path.join(cwd, 'source');
    await mkdir(path.join(source, 'api', 'src', 'main', 'java'), { recursive: true });

    const config = await loadConfig({ ICEBERG_SOURCE_DIR: source }, cwd);

    expect(config.sourceDir).toBe(await realpath(source));
  });

  it('reads a mounted secret without its trailing line ending', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const tokenFile = path.join(cwd, 'token');
    await writeFile(tokenFile, 'catalog-secret\r\n');

    const config = await loadConfig(
      {
        ICEBERG_CATALOG_TOKEN_FILE: tokenFile,
        ICEBERG_CATALOG_URI: 'http://127.0.0.1:8181',
      },
      cwd,
    );

    expect(config.catalog.token).toBe('catalog-secret');
  });

  it('rejects ambiguous secret sources', async (): Promise<void> => {
    const cwd = await temporaryDirectory();

    await expect(
      loadConfig(
        {
          ICEBERG_CATALOG_TOKEN: 'direct',
          ICEBERG_CATALOG_TOKEN_FILE: '/not/read',
        },
        cwd,
      ),
    ).rejects.toThrow(/mutually exclusive/u);
  });

  it('requires authentication and explicit origins for a non-loopback bind', async (): Promise<void> => {
    const cwd = await temporaryDirectory();

    await expect(
      loadConfig(
        {
          ICEBERG_MCP_HOST: '0.0.0.0',
          ICEBERG_MCP_TRANSPORT: 'http',
        },
        cwd,
      ),
    ).rejects.toThrow(/requires ICEBERG_MCP_AUTH_TOKEN/u);

    await expect(
      loadConfig(
        {
          ICEBERG_MCP_AUTH_TOKEN: 'inbound-secret',
          ICEBERG_MCP_HOST: '0.0.0.0',
          ICEBERG_MCP_TRANSPORT: 'http',
        },
        cwd,
      ),
    ).rejects.toThrow(/requires ICEBERG_MCP_ALLOWED_ORIGINS/u);
  });

  it('accepts a secured non-loopback bind and HTTPS catalog', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const config = await loadConfig(
      {
        ICEBERG_CATALOG_ALLOW_MUTATIONS: 'true',
        ICEBERG_CATALOG_URI: 'https://catalog.example.test/prefix',
        ICEBERG_MCP_ALLOWED_ORIGINS: 'https://client.example.test',
        ICEBERG_MCP_AUTH_TOKEN: 'inbound-secret',
        ICEBERG_MCP_HOST: '0.0.0.0',
        ICEBERG_MCP_TRANSPORT: 'http',
      },
      cwd,
    );

    expect(config.catalog.allowMutations).toBe(true);
    expect(config.catalog.uri?.href).toBe('https://catalog.example.test/prefix');
    expect(config.http.allowedOrigins).toEqual(['https://client.example.test']);
  });

  it.each([
    [{ ICEBERG_JAVADOC_VERSION: 'latest' }, /JAVADOC_VERSION/u],
    [{ ICEBERG_JAVADOC_BASE_URL: 'http://docs.example.test' }, /must use https/u],
    [{ ICEBERG_CATALOG_URI: 'http://catalog.example.test' }, /must use https/u],
    [{ ICEBERG_MCP_PORT: '0' }, /between 1 and 65535/u],
    [{ ICEBERG_CATALOG_ALLOW_MUTATIONS: 'yes' }, /must be true or false/u],
    [{ ICEBERG_MCP_ALLOWED_ORIGINS: '*' }, /does not support wildcards/u],
  ])('rejects invalid environment input %#', async (env, expected): Promise<void> => {
    const cwd = await temporaryDirectory();
    await expect(loadConfig(env, cwd)).rejects.toThrow(expected);
  });
});
