import { serveStdio } from '@modelcontextprotocol/server/stdio';

import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import type { ServerDependencies } from '../server.js';
import { createIcebergServer } from '../server.js';
import type { ErrorReporter } from '../shared/logging.js';

export function startStdio(
  dependencies: ServerDependencies,
  reporter: ErrorReporter,
): StdioServerHandle {
  return serveStdio(() => createIcebergServer(dependencies), {
    legacy: 'serve',
    onerror(error): void {
      reporter.report(error, 'stdio transport');
    },
  });
}
