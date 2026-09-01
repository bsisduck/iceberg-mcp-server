import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installShutdownHandlers: vi.fn(),
  loadConfig: vi.fn(),
  startRuntime: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../../src/runtime.js', () => ({
  installShutdownHandlers: mocks.installShutdownHandlers,
  startRuntime: mocks.startRuntime,
}));

import { isMainModule, main, parseArgs, USAGE } from '../../src/cli.js';

afterEach((): void => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('parseArgs', (): void => {
  it('recognizes an npm-style symlink as the executable module', async (): Promise<void> => {
    const directory = await mkdtemp(path.join(tmpdir(), 'iceberg-cli-test-'));
    const target = path.join(directory, 'cli.js');
    const link = path.join(directory, 'iceberg-mcp-server');
    try {
      await writeFile(target, '');
      await symlink(target, link);

      expect(isMainModule(link, pathToFileURL(target).href)).toBe(true);
      expect(isMainModule(undefined, pathToFileURL(target).href)).toBe(false);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('uses start with no transport override by default', (): void => {
    expect(parseArgs([])).toEqual({
      client: undefined,
      command: 'start',
      javadocVersion: '1.11.0',
      serverPath: undefined,
      sourceDir: undefined,
      transport: undefined,
    });
  });

  it('parses help, version, and transport options', (): void => {
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-v']).command).toBe('version');
    expect(parseArgs(['--transport', 'http'])).toMatchObject({
      command: 'start',
      transport: 'http',
    });
  });

  it('parses non-mutating client configuration output options', (): void => {
    expect(
      parseArgs([
        '--print-client-config',
        'codex',
        '--server-path',
        '/opt/iceberg-mcp-server/dist/cli.js',
        '--source-dir',
        '/opt/iceberg',
        '--javadoc-version',
        '1.10.1',
      ]),
    ).toEqual({
      client: 'codex',
      command: 'client-config',
      javadocVersion: '1.10.1',
      serverPath: '/opt/iceberg-mcp-server/dist/cli.js',
      sourceDir: '/opt/iceberg',
      transport: undefined,
    });
  });

  it('rejects unknown and incomplete options', (): void => {
    expect(() => parseArgs(['--unknown'])).toThrow(/Unknown argument/u);
    expect(() => parseArgs(['--transport'])).toThrow(/must be stdio or http/u);
    expect(() => parseArgs(['--transport', 'tcp'])).toThrow(/must be stdio or http/u);
    expect(() => parseArgs(['--print-client-config', 'unknown'])).toThrow(/must be one of/u);
    expect(() => parseArgs(['--source-dir', '/opt/iceberg'])).toThrow(
      /require --print-client-config/u,
    );
    expect(() => parseArgs(['--print-client-config', 'codex', '--source-dir', 'relative'])).toThrow(
      /absolute path/u,
    );
    expect(() => parseArgs(['--print-client-config', 'codex', '--transport', 'stdio'])).toThrow(
      /cannot be combined/u,
    );
  });

  it('prints help and version without starting a runtime', async (): Promise<void> => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await main(['--help']);
    await main(['--version']);

    expect(write).toHaveBeenNthCalledWith(1, USAGE);
    expect(write).toHaveBeenNthCalledWith(2, '0.1.0\n');
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it('prints client setup without loading runtime configuration', async (): Promise<void> => {
    const directory = await mkdtemp(path.join(tmpdir(), 'iceberg-client-setup-test-'));
    const entry = path.join(directory, 'cli.js');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await writeFile(entry, '');
      await main([
        '--print-client-config',
        'codex',
        '--server-path',
        entry,
        '--source-dir',
        '/opt/iceberg',
      ]);

      expect(write).toHaveBeenCalledWith(expect.stringContaining('codex mcp add iceberg'));
      expect(write).toHaveBeenCalledWith(expect.stringContaining(entry));
      expect(mocks.loadConfig).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('loads an overridden transport, starts, and reports an HTTP address', async (): Promise<void> => {
    const loaded = { transport: 'http' };
    const handle = {
      address: new URL('http://127.0.0.1:3000/mcp'),
      close: vi.fn(),
    };
    mocks.loadConfig.mockResolvedValue(loaded);
    mocks.startRuntime.mockResolvedValue(handle);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await main(['--transport', 'http']);

    expect(mocks.loadConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ICEBERG_MCP_TRANSPORT: 'http' }),
    );
    expect(mocks.startRuntime).toHaveBeenCalledWith(loaded, expect.any(Object));
    expect(mocks.installShutdownHandlers).toHaveBeenCalledWith(handle, expect.any(Object));
    expect(write).toHaveBeenCalledWith(
      'Iceberg MCP server listening at http://127.0.0.1:3000/mcp\n',
    );
  });

  it('keeps stdio stdout protocol-only when starting without an address', async (): Promise<void> => {
    mocks.loadConfig.mockResolvedValue({ transport: 'stdio' });
    mocks.startRuntime.mockResolvedValue({ address: undefined, close: vi.fn() });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await main([]);

    expect(write).not.toHaveBeenCalled();
  });
});
