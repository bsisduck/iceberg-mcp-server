import { PassThrough } from 'node:stream';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/config.js';
import type { Services } from '../../src/services.js';
import { createServices } from '../../src/services.js';
import type { ErrorReporter } from '../../src/shared/logging.js';
import { SERVER_INSTRUCTIONS } from '../../src/server.js';
import { startStdio } from '../../src/transport/stdio.js';

interface Fixture {
  readonly close: () => Promise<void>;
  readonly input: PassThrough;
  readonly output: PassThrough;
}

const fixtures: Fixture[] = [];
const reporter: ErrorReporter = {
  report(error): void {
    throw error;
  },
};

function config(): AppConfig {
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
    transport: 'stdio',
  };
}

async function fixture(): Promise<Fixture> {
  const input = new PassThrough();
  const output = new PassThrough();
  const services: Services = await createServices(config());
  const transport = new StdioServerTransport(input, output);
  const handle = startStdio({ config: config(), reporter, services }, reporter, transport);
  const result = {
    close: async (): Promise<void> => {
      await handle.close();
      await services.close();
      input.destroy();
      output.destroy();
    },
    input,
    output,
  };
  fixtures.push(result);
  return result;
}

function readMessage(output: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for stdio response'));
    }, 2_000);
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline === -1) {
        return;
      }
      cleanup();
      resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      output.off('data', onData);
    };
    output.on('data', onData);
  });
}

async function exchange(
  connection: Fixture,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = readMessage(connection.output);
  connection.input.write(`${JSON.stringify(message)}\n`);
  return response;
}

afterEach(async (): Promise<void> => {
  await Promise.all(fixtures.splice(0).map((item) => item.close()));
});

describe('stdio transport', (): void => {
  it('pins and serves a legacy initialize connection', async (): Promise<void> => {
    const connection = await fixture();
    const initialized = await exchange(connection, {
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'legacy-stdio-test', version: '1.0.0' },
        protocolVersion: '2025-11-25',
      },
    });

    const initializeResult = initialized['result'] as {
      instructions?: string;
      serverInfo: { name: string };
    };
    expect(initializeResult.serverInfo.name).toBe('iceberg-mcp-server');
    expect(initializeResult.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    const tools = await exchange(connection, {
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    });
    expect((tools['result'] as { tools: unknown[] }).tools).toHaveLength(9);
  });

  it('negotiates and serves the modern per-request envelope', async (): Promise<void> => {
    const connection = await fixture();
    const envelope = {
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'modern-stdio-test', version: '1.0.0' },
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    };
    const discovered = await exchange(connection, {
      id: 1,
      jsonrpc: '2.0',
      method: 'server/discover',
      params: { _meta: envelope },
    });
    expect(discovered['error']).toBeUndefined();
    expect(JSON.stringify(discovered['result'])).toContain('iceberg-mcp-server');

    const tools = await exchange(connection, {
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: { _meta: envelope },
    });
    expect((tools['result'] as { tools: unknown[] }).tools).toHaveLength(9);
  });
});
