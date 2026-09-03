import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/config.js';

const mocks = vi.hoisted(() => ({
  closeHttp: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  closeServices: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  closeStdio: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  createServices: vi.fn(),
  startHttp: vi.fn(),
  startStdio: vi.fn(),
}));

vi.mock('../../src/services.js', () => ({ createServices: mocks.createServices }));
vi.mock('../../src/transport/http.js', () => ({ startHttp: mocks.startHttp }));
vi.mock('../../src/transport/stdio.js', () => ({ startStdio: mocks.startStdio }));

import { installShutdownHandlers, startRuntime } from '../../src/runtime.js';

function config(transport: 'http' | 'stdio'): AppConfig {
  return {
    catalog: {
      allowMutations: false,
      oauth2Credential: undefined,
      oauth2Uri: undefined,
      token: undefined,
      uri: undefined,
      warehouse: undefined,
    },
    http: {
      allowedOrigins: [],
      authToken: undefined,
      host: '127.0.0.1',
      maxRequestBytes: 1_048_576,
      port: 0,
    },
    javadoc: {
      baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
      version: '1.11.0',
    },
    limits: { maxResponseChars: 30_000, requestTimeoutMs: 1_000 },
    logLevel: 'info',
    sourceDir: undefined,
    transport,
  };
}

afterEach((): void => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('runtime lifecycle', (): void => {
  it('starts and closes stdio before shared services', async (): Promise<void> => {
    const services = { api: {}, catalog: undefined, close: mocks.closeServices };
    mocks.createServices.mockResolvedValue(services);
    mocks.startStdio.mockReturnValue({ close: mocks.closeStdio });

    const handle = await startRuntime(config('stdio'), { report: vi.fn() });

    expect(handle.address).toBeUndefined();
    expect(mocks.startStdio).toHaveBeenCalledOnce();
    await handle.close();
    expect(mocks.closeStdio).toHaveBeenCalledOnce();
    expect(mocks.closeServices).toHaveBeenCalledOnce();
  });

  it('starts and closes HTTP before shared services', async (): Promise<void> => {
    const services = { api: {}, catalog: undefined, close: mocks.closeServices };
    const address = new URL('http://127.0.0.1:3000/mcp');
    mocks.createServices.mockResolvedValue(services);
    mocks.startHttp.mockResolvedValue({ address, close: mocks.closeHttp });

    const handle = await startRuntime(config('http'), { report: vi.fn() });

    expect(handle.address).toEqual(address);
    await handle.close();
    expect(mocks.closeHttp).toHaveBeenCalledOnce();
    expect(mocks.closeServices).toHaveBeenCalledOnce();
  });

  it('installs idempotent signal shutdown and reports close failures', async (): Promise<void> => {
    const close = vi.fn<() => Promise<void>>(() => Promise.reject(new Error('close failed')));
    const reporter = { report: vi.fn() };
    const remove = installShutdownHandlers({ address: undefined, close }, reporter);

    process.emit('SIGINT');
    process.emit('SIGTERM');
    await vi.waitFor(() => expect(reporter.report).toHaveBeenCalledOnce());

    expect(close).toHaveBeenCalledOnce();
    expect(reporter.report).toHaveBeenCalledWith(expect.any(Error), 'runtime.shutdown');
    expect(process.exitCode).toBe(1);
    remove();
  });
});
