import { serveStdio } from '@modelcontextprotocol/server/stdio';

import type { Transport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import type { ServerDependencies } from '../server.js';
import { createIcebergServer } from '../server.js';
import type { ErrorReporter } from '../shared/logging.js';

export function startStdio(
  dependencies: ServerDependencies,
  reporter: ErrorReporter,
  transport?: Transport,
): StdioServerHandle {
  return serveStdio(() => createIcebergServer(dependencies), {
    legacy: 'serve',
    onerror(error): void {
      reporter.report(error, 'transport.stdio');
    },
    ...(transport === undefined ? {} : { transport }),
  });
}
