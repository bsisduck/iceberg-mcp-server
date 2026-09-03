import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { hostHeaderName, isLoopbackHost, loadConfig } from '../../src/config.js';

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
  it('configures the Javadoc disk cache and the index bounds', async (): Promise<void> => {
    const cwd = await temporaryDirectory();

    const defaults = await loadConfig({}, cwd);
    const custom = await loadConfig(
      {
        ICEBERG_JAVADOC_CACHE_DIR: 'javadoc-cache',
        ICEBERG_JAVADOC_CACHE_MAX_BYTES: '2000000',
        ICEBERG_JAVADOC_CACHE_TTL_MS: '60000',
        ICEBERG_JAVADOC_INDEX_MAX_BYTES: '48000000',
        ICEBERG_SOURCE_INDEX_MAX_BYTES: '0',
      },
      cwd,
    );
    const disabled = await loadConfig({ ICEBERG_JAVADOC_CACHE: 'off' }, cwd);

    expect(defaults.javadoc.indexMaxBytes).toBe(32_000_000);
    expect(defaults.sourceIndexMaxBytes).toBe(64_000_000);
    expect(defaults.javadoc.cache).toMatchObject({
      maxBytes: 268_435_456,
      ttlMs: 86_400_000,
    });
    expect(
      defaults.javadoc.cache?.directory.endsWith(path.join('iceberg-mcp-server', 'javadoc')),
    ).toBe(true);
    expect(custom.javadoc.cache).toEqual({
      directory: path.join(cwd, 'javadoc-cache'),
      maxBytes: 2_000_000,
      ttlMs: 60_000,
    });
    expect(custom.javadoc.indexMaxBytes).toBe(48_000_000);
    expect(custom.sourceIndexMaxBytes).toBe(0);
    expect(disabled.javadoc.cache).toBeUndefined();
    await expect(loadConfig({ ICEBERG_JAVADOC_CACHE: 'yes' }, cwd)).rejects.toThrow(/on or off/u);
    await expect(loadConfig({ ICEBERG_JAVADOC_INDEX_MAX_BYTES: '10' }, cwd)).rejects.toThrow(
      /must be between/u,
    );
  });

  it('loads safe defaults without optional integrations', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const config = await loadConfig({}, cwd);

    expect(config.transport).toBe('stdio');
    expect(config.logLevel).toBe('info');
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

    expect(config.catalog.token?.value()).toBe('catalog-secret');
  });

  it('rejects unreadable, empty, non-file, and oversized secret mounts', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const empty = path.join(cwd, 'empty-token');
    const directory = path.join(cwd, 'token-directory');
    const oversized = path.join(cwd, 'oversized-token');
    await writeFile(empty, '\n');
    await mkdir(directory);
    await writeFile(oversized, 'x'.repeat(16_385));

    await expect(
      loadConfig({ ICEBERG_CATALOG_TOKEN_FILE: path.join(cwd, 'missing') }, cwd),
    ).rejects.toThrow(/not readable/u);
    await expect(loadConfig({ ICEBERG_CATALOG_TOKEN_FILE: empty }, cwd)).rejects.toThrow(
      /must not be empty/u,
    );
    await expect(loadConfig({ ICEBERG_CATALOG_TOKEN_FILE: directory }, cwd)).rejects.toThrow(
      /regular file/u,
    );
    await expect(loadConfig({ ICEBERG_CATALOG_TOKEN_FILE: oversized }, cwd)).rejects.toThrow(
      /regular file/u,
    );
    await expect(loadConfig({ ICEBERG_CATALOG_TOKEN: 'é'.repeat(8_193) }, cwd)).rejects.toThrow(
      /at most 16384 bytes/u,
    );
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

  it('accepts loopback variants, deduplicates origins, and parses bounded limits', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const config = await loadConfig(
      {
        ICEBERG_MAX_RESPONSE_CHARS: '4096',
        ICEBERG_MCP_ALLOWED_ORIGINS:
          'http://localhost:4321,http://localhost:4321,http://127.0.0.1:4321',
        ICEBERG_MCP_HOST: '[::1]',
        ICEBERG_MCP_LOG_LEVEL: 'debug',
        ICEBERG_MCP_MAX_REQUEST_BYTES: '4096',
        ICEBERG_MCP_PORT: '4321',
        ICEBERG_MCP_TRANSPORT: 'http',
        ICEBERG_REQUEST_TIMEOUT_MS: '1000',
      },
      cwd,
    );

    expect(config.http.allowedOrigins).toEqual(['http://localhost:4321', 'http://127.0.0.1:4321']);
    expect(config.http).toMatchObject({ host: '::1', maxRequestBytes: 4096, port: 4321 });
    expect(config.limits).toEqual({ maxResponseChars: 4096, requestTimeoutMs: 1000 });
    expect(config.logLevel).toBe('debug');
  });

  it('requires complete, exclusive catalog authentication and catalog scope', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    await expect(
      loadConfig(
        {
          ICEBERG_CATALOG_URI: 'https://catalog.example.test',
          ICEBERG_OAUTH2_URI: 'https://id.example.test/token',
        },
        cwd,
      ),
    ).rejects.toThrow(/configured together/u);
    await expect(
      loadConfig(
        {
          ICEBERG_CATALOG_TOKEN: 'bearer',
          ICEBERG_CATALOG_URI: 'https://catalog.example.test',
          ICEBERG_OAUTH2_CREDENTIAL: 'client:secret',
          ICEBERG_OAUTH2_URI: 'https://id.example.test/token',
        },
        cwd,
      ),
    ).rejects.toThrow(/mutually exclusive/u);
    await expect(loadConfig({ ICEBERG_CATALOG_TOKEN: 'bearer' }, cwd)).rejects.toThrow(
      /require ICEBERG_CATALOG_URI/u,
    );
    await expect(loadConfig({ ICEBERG_CATALOG_WAREHOUSE: 'x'.repeat(2_049) }, cwd)).rejects.toThrow(
      /at most 2048/u,
    );
  });

  it('accepts external OAuth and normalizes blank optional values', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const config = await loadConfig(
      {
        ICEBERG_CATALOG_URI: 'https://catalog.example.test',
        ICEBERG_CATALOG_WAREHOUSE: '   ',
        ICEBERG_OAUTH2_CREDENTIAL: 'client:secret',
        ICEBERG_OAUTH2_URI: 'https://id.example.test/token',
      },
      cwd,
    );

    expect(config.catalog.oauth2Credential?.value()).toBe('client:secret');
    expect(config.catalog).toMatchObject({ token: undefined, warehouse: undefined });
  });

  it.each([
    [{ ICEBERG_JAVADOC_VERSION: 'latest' }, /JAVADOC_VERSION/u],
    [{ ICEBERG_JAVADOC_BASE_URL: 'http://docs.example.test' }, /must use https/u],
    [{ ICEBERG_CATALOG_URI: 'http://catalog.example.test' }, /must use https/u],
    [{ ICEBERG_MCP_PORT: '0' }, /between 1 and 65535/u],
    [{ ICEBERG_CATALOG_ALLOW_MUTATIONS: 'yes' }, /must be true or false/u],
    [{ ICEBERG_MCP_ALLOWED_ORIGINS: '*' }, /does not support wildcards/u],
    [{ ICEBERG_MCP_PORT: 'abc' }, /must be an integer/u],
    [{ ICEBERG_REQUEST_TIMEOUT_MS: '999' }, /between 1000 and 120000/u],
    [{ ICEBERG_JAVADOC_BASE_URL: 'not-a-url' }, /absolute URL/u],
    [{ ICEBERG_JAVADOC_BASE_URL: 'ftp://docs.example.test' }, /http or https/u],
    [{ ICEBERG_JAVADOC_BASE_URL: 'https://user:pass@docs.example.test' }, /credentials/u],
    [{ ICEBERG_JAVADOC_BASE_URL: 'https://docs.example.test/?query=1' }, /query or fragment/u],
    [{ ICEBERG_MCP_HOST: 'bad host' }, /not a valid bind/u],
    [{ ICEBERG_MCP_HOST: '[not-an-address]' }, /not a valid bind/u],
    [{ ICEBERG_MCP_HOST: '[127.0.0.1]' }, /not a valid bind/u],
    [{ ICEBERG_MCP_HOST: `${'a'.repeat(64)}.example.test` }, /not a valid bind/u],
    [{ ICEBERG_MCP_ALLOWED_ORIGINS: 'https://client.example.test/path' }, /exact origins/u],
    [{ ICEBERG_MCP_TRANSPORT: 'tcp' }, /must be stdio or http/u],
    [{ ICEBERG_MCP_LOG_LEVEL: 'trace' }, /ICEBERG_MCP_LOG_LEVEL must be one of/u],
  ])('rejects invalid environment input %#', async (env, expected): Promise<void> => {
    const cwd = await temporaryDirectory();
    await expect(loadConfig(env, cwd)).rejects.toThrow(expected);
  });

  it('keeps every configured secret out of serialization and inspection', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const config = await loadConfig(
      {
        ICEBERG_CATALOG_URI: 'https://catalog.example.test',
        ICEBERG_MCP_ALLOWED_ORIGINS: 'https://client.example.test',
        ICEBERG_MCP_AUTH_TOKEN: 'inbound-secret',
        ICEBERG_MCP_HOST: '0.0.0.0',
        ICEBERG_MCP_TRANSPORT: 'http',
        ICEBERG_OAUTH2_CREDENTIAL: 'client-id:client-secret',
        ICEBERG_OAUTH2_URI: 'https://id.example.test/token',
      },
      cwd,
    );
    const rendered = [JSON.stringify(config), inspect(config, { depth: null })];

    for (const output of rendered) {
      expect(output).not.toContain('inbound-secret');
      expect(output).not.toContain('client-secret');
      expect(output).toContain('[REDACTED]');
    }
    expect(config.http.authToken?.value()).toBe('inbound-secret');
    expect(config.catalog.oauth2Credential?.value()).toBe('client-id:client-secret');
  });

  it.each([
    ['[::1]', '::1', true],
    ['::1', '::1', true],
    ['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:1', true],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.1', true],
    ['localhost', 'localhost', true],
    ['LocalHost', 'localhost', true],
    ['127.0.0.1', '127.0.0.1', true],
    ['0.0.0.0', '0.0.0.0', false],
    ['catalog-host.example.test', 'catalog-host.example.test', false],
  ])(
    'normalizes bind host %s and classifies loopback consistently',
    async (input, expected, loopback): Promise<void> => {
      const cwd = await temporaryDirectory();
      const env: NodeJS.ProcessEnv = { ICEBERG_MCP_HOST: input, ICEBERG_MCP_TRANSPORT: 'http' };
      if (!loopback) {
        env['ICEBERG_MCP_ALLOWED_ORIGINS'] = 'https://client.example.test';
        env['ICEBERG_MCP_AUTH_TOKEN'] = 'inbound-secret';
      }

      const config = await loadConfig(env, cwd);

      expect(config.http.host).toBe(expected);
      expect(isLoopbackHost(config.http.host)).toBe(loopback);
    },
  );

  it('brackets only IPv6 literals for Host header comparison', (): void => {
    expect(hostHeaderName('::1')).toBe('[::1]');
    expect(hostHeaderName('2001:db8::1')).toBe('[2001:db8::1]');
    expect(hostHeaderName('127.0.0.1')).toBe('127.0.0.1');
    expect(hostHeaderName('catalog-host.example.test')).toBe('catalog-host.example.test');
  });

  it('treats a blank value as unset for every variable', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const blank: NodeJS.ProcessEnv = {
      ICEBERG_CATALOG_ALLOW_MUTATIONS: '',
      ICEBERG_CATALOG_TOKEN: '',
      ICEBERG_CATALOG_URI: '',
      ICEBERG_CATALOG_WAREHOUSE: '',
      ICEBERG_JAVADOC_BASE_URL: '',
      ICEBERG_JAVADOC_VERSION: '',
      ICEBERG_MAX_RESPONSE_CHARS: '',
      ICEBERG_MCP_ALLOWED_ORIGINS: '',
      ICEBERG_MCP_AUTH_TOKEN: '',
      ICEBERG_MCP_HOST: '',
      ICEBERG_MCP_LOG_LEVEL: '',
      ICEBERG_MCP_MAX_REQUEST_BYTES: '',
      ICEBERG_MCP_PORT: '',
      ICEBERG_MCP_TRANSPORT: '',
      ICEBERG_OAUTH2_CREDENTIAL: '',
      ICEBERG_OAUTH2_URI: '',
      ICEBERG_REQUEST_TIMEOUT_MS: '',
      ICEBERG_SOURCE_DIR: '',
    };

    const config = await loadConfig(blank, cwd);

    // The three that used to raise instead of falling back.
    expect(config.javadoc.version).toBe('1.11.0');
    expect(config.javadoc.baseUrl.href).toBe('https://iceberg.apache.org/javadoc/');
    expect(config.transport).toBe('stdio');
    // The variables that already accepted a blank value keep doing so.
    expect(config.logLevel).toBe('info');
    expect(config.sourceDir).toBeUndefined();
    expect(config.catalog).toMatchObject({
      allowMutations: false,
      oauth2Credential: undefined,
      oauth2Uri: undefined,
      token: undefined,
      uri: undefined,
      warehouse: undefined,
    });
    expect(config.http).toMatchObject({ authToken: undefined, host: '127.0.0.1', port: 3000 });
    expect(config.limits).toEqual({ maxResponseChars: 30_000, requestTimeoutMs: 15_000 });
  });

  it('caps the configured origin count', async (): Promise<void> => {
    const cwd = await temporaryDirectory();
    const origins = Array.from(
      { length: 33 },
      (_value, index) => `https://client-${index}.example.test`,
    ).join(',');

    await expect(loadConfig({ ICEBERG_MCP_ALLOWED_ORIGINS: origins }, cwd)).rejects.toThrow(
      /at most 32/u,
    );
  });
});
