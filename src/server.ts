import { McpServer } from '@modelcontextprotocol/server';

import type { AppConfig } from './config.js';
import type { Services } from './services.js';
import type { ErrorReporter } from './shared/logging.js';
import { registerApiTools } from './capabilities/api-tools.js';
import { registerCatalogTools } from './capabilities/catalog-tools.js';
import { registerPrompts } from './capabilities/prompts.js';
import { registerResources } from './capabilities/resources.js';

export const SERVER_NAME = 'iceberg-mcp-server';
export const SERVER_VERSION = '0.1.0';
export const SERVER_INSTRUCTIONS =
  'Start read-only. For Java API questions, search or browse first, then inspect exact types and members; use source only as lexical evidence and compare explicit versions for migrations. For catalogs, inspect iceberg_catalog_get_config first and use only advertised tools. Never expose credentials. Mutations require operator opt-in, catalog support, and user confirmation. Preserve opaque cursors unchanged, paginate bounded results, and never retry 409 conflicts.';

export interface ServerDependencies {
  readonly config: AppConfig;
  readonly reporter: ErrorReporter;
  readonly services: Services;
}

export function createIcebergServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {},
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerApiTools(server, {
    api: dependencies.services.api,
    defaultVersion: dependencies.config.javadoc.version,
    maxResponseChars: dependencies.config.limits.maxResponseChars,
    reporter: dependencies.reporter,
  });
  if (dependencies.services.catalog !== undefined) {
    registerCatalogTools(
      server,
      dependencies.services.catalog,
      dependencies.config.catalog.allowMutations,
      dependencies.reporter,
      dependencies.config.limits.maxResponseChars,
    );
  }
  registerResources(server, {
    api: dependencies.services.api,
    catalog: dependencies.services.catalog,
    maxResponseChars: dependencies.config.limits.maxResponseChars,
  });
  registerPrompts(server, dependencies.config.javadoc.version);
  return server;
}
