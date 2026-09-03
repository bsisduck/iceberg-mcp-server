import type { AppConfig } from './config.js';
import type { HttpServerHandle } from './transport/http.js';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import type { ErrorReporter } from './shared/logging.js';
import { stderrReporter } from './shared/logging.js';
import { createServices } from './services.js';
import { startHttp } from './transport/http.js';
import { startStdio } from './transport/stdio.js';

export interface RuntimeHandle {
  readonly address: URL | undefined;
  close(): Promise<void>;
}

function wrapStdio(handle: StdioServerHandle): RuntimeHandle {
  return {
    address: undefined,
    async close(): Promise<void> {
      await handle.close();
    },
  };
}

function wrapHttp(handle: HttpServerHandle): RuntimeHandle {
  return {
    address: handle.address,
    async close(): Promise<void> {
      await handle.close();
    },
  };
}

export async function startRuntime(
  config: AppConfig,
  reporter: ErrorReporter = stderrReporter,
): Promise<RuntimeHandle> {
  const services = await createServices(config);
  const dependencies = { config, reporter, services };
  if (config.transport === 'stdio') {
    const handle = wrapStdio(startStdio(dependencies, reporter));
    return {
      address: handle.address,
      async close(): Promise<void> {
        await handle.close();
        await services.close();
      },
    };
  }
  const handle = wrapHttp(await startHttp(dependencies, reporter));
  return {
    address: handle.address,
    async close(): Promise<void> {
      await handle.close();
      await services.close();
    },
  };
}

export function installShutdownHandlers(
  handle: RuntimeHandle,
  reporter: ErrorReporter,
): () => void {
  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void handle.close().catch((error: unknown) => {
      reporter.report(error, 'runtime.shutdown');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return (): void => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
}
