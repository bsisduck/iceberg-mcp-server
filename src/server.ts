import { McpServer } from '@modelcontextprotocol/server';

import type { AppConfig } from './config.js';

export const SERVER_NAME = 'iceberg-mcp-server';
export const SERVER_VERSION = '0.1.0';

export interface ServerDependencies {
  readonly config: AppConfig;
}

export function createIcebergServer(dependencies: ServerDependencies): McpServer {
  void dependencies;
  return new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {},
      instructions:
        'Use Iceberg API tools for Java documentation and source evidence. Catalog tools are available only when configured.',
    },
  );
}
