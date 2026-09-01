import { ResourceTemplate } from '@modelcontextprotocol/server';

import type { McpServer, Variables } from '@modelcontextprotocol/server';

import type { ApiService } from '../api/api-service.js';
import type { CatalogClient } from '../catalog/client.js';
import { InputError, LimitError } from '../shared/errors.js';

function variable(variables: Variables, name: string): string {
  const value = variables[name];
  if (typeof value !== 'string') {
    throw new InputError(`Resource variable ${name} must be a single string`);
  }
  return value;
}

interface JsonResourceResult {
  [key: string]: unknown;
  contents: { mimeType: string; text: string; uri: string }[];
}

function jsonResource(uri: URL, value: unknown, maxResponseChars: number): JsonResourceResult {
  const text = JSON.stringify(value, null, 2);
  if (text.length > maxResponseChars) {
    throw new LimitError(
      `Resource response exceeds ${maxResponseChars} characters; use the paginated tools with a smaller limit`,
    );
  }
  return {
    contents: [
      {
        mimeType: 'application/json',
        text,
        uri: uri.href,
      },
    ],
  };
}

export interface ResourceDependencies {
  readonly api: ApiService;
  readonly catalog: CatalogClient | undefined;
  readonly maxResponseChars: number;
}

export function registerResources(server: McpServer, dependencies: ResourceDependencies): void {
  server.registerResource(
    'iceberg-api-package',
    new ResourceTemplate('iceberg://api/{version}/package/{package}', { list: undefined }),
    {
      cacheHint: { cacheScope: 'public', ttlMs: 300_000 },
      description: 'A bounded view of exact published types in one Iceberg Java package.',
      mimeType: 'application/json',
      title: 'Iceberg Java package',
    },
    async (uri, variables) =>
      jsonResource(
        uri,
        await dependencies.api.browse({
          kind: 'type',
          limit: 100,
          packageName: variable(variables, 'package'),
          version: variable(variables, 'version'),
        }),
        dependencies.maxResponseChars,
      ),
  );

  server.registerResource(
    'iceberg-api-type',
    new ResourceTemplate('iceberg://api/{version}/type/{type}', { list: undefined }),
    {
      cacheHint: { cacheScope: 'public', ttlMs: 300_000 },
      description: 'Exact Javadoc documentation and stability evidence for one Iceberg Java type.',
      mimeType: 'application/json',
      title: 'Iceberg Java type',
    },
    async (uri, variables) =>
      jsonResource(
        uri,
        await dependencies.api.getType({
          fullyQualifiedName: variable(variables, 'type'),
          memberLimit: 100,
          version: variable(variables, 'version'),
        }),
        dependencies.maxResponseChars,
      ),
  );

  server.registerResource(
    'iceberg-source-type',
    new ResourceTemplate('iceberg://source/type/{type}', { list: undefined }),
    {
      cacheHint: { cacheScope: 'private', ttlMs: 0 },
      description: 'A bounded source window from the configured local Iceberg checkout.',
      mimeType: 'application/json',
      title: 'Iceberg Java source type',
    },
    async (uri, variables) =>
      jsonResource(
        uri,
        await dependencies.api.getSourceType({
          fullyQualifiedName: variable(variables, 'type'),
          lineCount: 500,
          startLine: 1,
        }),
        dependencies.maxResponseChars,
      ),
  );

  const catalog = dependencies.catalog;
  if (catalog !== undefined) {
    server.registerResource(
      'iceberg-catalog-config',
      'iceberg://catalog/config',
      {
        cacheHint: { cacheScope: 'private', ttlMs: 0 },
        description: 'Sanitized discovered REST Catalog configuration and endpoint capabilities.',
        mimeType: 'application/json',
        title: 'Iceberg REST Catalog configuration',
      },
      (uri) => jsonResource(uri, catalog.configResult(), dependencies.maxResponseChars),
    );
  }
}
