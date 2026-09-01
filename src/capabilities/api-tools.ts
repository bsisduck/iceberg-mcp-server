import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { ApiService } from '../api/api-service.js';
import type { ErrorReporter } from '../shared/logging.js';
import { executeTool } from '../shared/responses.js';

const versionSchema = z
  .string()
  .regex(/^(?:nightly|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u)
  .describe('Published Iceberg release such as 1.11.0, or nightly.');
const cursorSchema = z
  .string()
  .max(2_048)
  .optional()
  .describe('Opaque cursor from the prior page.');
const limitSchema = z.number().int().min(1).max(100).default(25);
const provenanceSchema = z.strictObject({
  iceberg_version: z.string(),
  kind: z.enum(['javadoc', 'source']),
  retrieved_at: z.iso.datetime(),
  source: z.string(),
});
const errorSchema = z.strictObject({
  error: z.strictObject({
    correlation_id: z.string().nullable(),
    message: z.string(),
    retryable: z.boolean(),
    status: z.number().int().nullable(),
    type: z.string(),
  }),
});
const browseItemSchema = z.strictObject({
  container: z.string().optional(),
  fully_qualified_name: z.string().optional(),
  kind: z.enum(['package', 'type', 'member']),
  label: z.string(),
  package_name: z.string(),
  url: z.url(),
});
const searchItemSchema = browseItemSchema.extend({ score: z.number().int().min(1).max(100) });
const memberDocumentationSchema = z.strictObject({
  anchor: z.string(),
  declaration: z.string().optional(),
  description: z.string().optional(),
  name: z.string(),
});
const sourceMatchSchema = z.strictObject({
  column: z.number().int().min(1),
  fullyQualifiedName: z.string(),
  line: z.number().int().min(1),
  module: z.string(),
  preview: z.string(),
  relativePath: z.string(),
});

function pageSchema<T extends z.ZodType>(item: T): z.ZodType {
  return z.strictObject({
    count: z.number().int().min(0),
    has_more: z.boolean(),
    items: z.array(item),
    next_cursor: z.string().nullable(),
    provenance: provenanceSchema,
    truncated: z.boolean(),
  });
}

const readOnlyRemote = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
} as const;
const readOnlyLocal = { ...readOnlyRemote, openWorldHint: false } as const;

export interface ApiToolDependencies {
  readonly api: ApiService;
  readonly defaultVersion: string;
  readonly reporter: ErrorReporter;
}

export function registerApiTools(server: McpServer, dependencies: ApiToolDependencies): void {
  const { api, defaultVersion, reporter } = dependencies;

  server.registerTool(
    'iceberg_api_list_versions',
    {
      annotations: readOnlyLocal,
      description:
        'List the configured stable/nightly Javadoc identities and optional local source revision.',
      inputSchema: z.strictObject({}),
      outputSchema: z.union([
        z.strictObject({
          count: z.number().int().min(0),
          items: z.array(
            z.strictObject({
              kind: z.enum(['release', 'nightly', 'source']),
              label: z.string(),
              mutable: z.boolean(),
              source: z.string(),
            }),
          ),
        }),
        errorSchema,
      ]),
      title: 'List Iceberg API versions',
    },
    async () =>
      executeTool(
        () => api.listVersions(),
        (result) => `Found ${result.count} configured Iceberg API identities.`,
        reporter,
      ),
  );

  server.registerTool(
    'iceberg_api_browse',
    {
      annotations: readOnlyRemote,
      description:
        'Browse the complete published package, type, or member index with exact package and label-prefix filters.',
      inputSchema: z.strictObject({
        cursor: cursorSchema,
        kind: z.enum(['package', 'type', 'member']).describe('Index surface to browse.'),
        limit: limitSchema,
        package_name: z.string().max(500).optional().describe('Exact Java package filter.'),
        prefix: z.string().min(1).max(200).optional().describe('Case-insensitive label prefix.'),
        version: versionSchema.default(defaultVersion),
      }),
      outputSchema: z.union([pageSchema(browseItemSchema), errorSchema]),
      title: 'Browse Iceberg Java API',
    },
    async ({ cursor, kind, limit, package_name: packageName, prefix, version }) =>
      executeTool(
        () => api.browse({ cursor, kind, limit, packageName, prefix, version }),
        (result) =>
          `Returned ${result.count} ${kind} records${result.has_more ? '; another page is available.' : '.'}`,
        reporter,
      ),
  );

  server.registerTool(
    'iceberg_api_search',
    {
      annotations: readOnlyRemote,
      description:
        'Ranked case-insensitive search across published Iceberg packages, types, member names, signatures, and identities.',
      inputSchema: z.strictObject({
        cursor: cursorSchema,
        limit: limitSchema,
        package_name: z.string().max(500).optional().describe('Exact Java package filter.'),
        query: z
          .string()
          .trim()
          .min(2)
          .max(200)
          .describe('Name, signature, or qualified-name fragment.'),
        scope: z.enum(['all', 'package', 'type', 'member']).default('all'),
        version: versionSchema.default(defaultVersion),
      }),
      outputSchema: z.union([pageSchema(searchItemSchema), errorSchema]),
      title: 'Search Iceberg Java API',
    },
    async ({ cursor, limit, package_name: packageName, query, scope, version }) =>
      executeTool(
        () => api.search({ cursor, limit, packageName, query, scope, version }),
        (result) =>
          `Found ${result.count} results for “${query}”${result.has_more ? '; another page is available.' : '.'}`,
        reporter,
      ),
  );

  server.registerTool(
    'iceberg_api_get_type',
    {
      annotations: readOnlyRemote,
      description:
        'Get one exact published Java type with declaration, description, deprecation, detailed members, links, and stability evidence.',
      inputSchema: z.strictObject({
        fully_qualified_name: z.string().min(3).max(1_000).describe('Exact Javadoc type identity.'),
        member_cursor: cursorSchema,
        member_limit: z.number().int().min(1).max(200).default(50),
        version: versionSchema.default(defaultVersion),
      }),
      outputSchema: z.union([
        z.strictObject({
          declaration: z.string().nullable(),
          deprecated: z.string().nullable(),
          description: z.string().nullable(),
          fully_qualified_name: z.string(),
          has_more_members: z.boolean(),
          members: z.array(memberDocumentationSchema),
          next_member_cursor: z.string().nullable(),
          package_name: z.string(),
          provenance: provenanceSchema,
          stability: z.strictObject({
            classification: z.enum(['stable-module', 'public-unclassified']),
            module: z.string().nullable(),
            reason: z.string(),
            source_revision: z.string().nullable(),
          }),
          title: z.string(),
          url: z.url(),
        }),
        errorSchema,
      ]),
      title: 'Get Iceberg Java type',
    },
    async ({
      fully_qualified_name: fullyQualifiedName,
      member_cursor: cursor,
      member_limit: memberLimit,
      version,
    }) =>
      executeTool(
        () => api.getType({ cursor, fullyQualifiedName, memberLimit, version }),
        (result) =>
          `${result.title}: ${result.description ?? 'No type description is published.'}${result.has_more_members ? ' More members are available.' : ''}`,
        reporter,
      ),
  );

  server.registerTool(
    'iceberg_api_get_member',
    {
      annotations: readOnlyRemote,
      description:
        'Get one exact member by its published label or Javadoc anchor within an exact Java type.',
      inputSchema: z.strictObject({
        fully_qualified_name: z.string().min(3).max(1_000),
        member: z.string().min(1).max(4_000).describe('Published label or exact Javadoc anchor.'),
        version: versionSchema.default(defaultVersion),
      }),
      outputSchema: z.union([
        z.strictObject({
          anchor: z.string(),
          container: z.string(),
          declaration: z.string().nullable(),
          description: z.string().nullable(),
          label: z.string(),
          package_name: z.string(),
          provenance: provenanceSchema,
          type_fully_qualified_name: z.string(),
          url: z.url(),
        }),
        errorSchema,
      ]),
      title: 'Get Iceberg Java member',
    },
    async ({ fully_qualified_name: fullyQualifiedName, member, version }) =>
      executeTool(
        () => api.getMember({ fullyQualifiedName, member, version }),
        (result) =>
          `${result.type_fully_qualified_name}#${result.label}: ${result.description ?? 'No member description is published.'}`,
        reporter,
      ),
  );

  server.registerTool(
    'iceberg_api_compare_versions',
    {
      annotations: readOnlyRemote,
      description:
        'Compare exact published package, type, or member identities between two Iceberg Javadoc versions.',
      inputSchema: z.strictObject({
        cursor: cursorSchema,
        from_version: versionSchema,
        kind: z.enum(['package', 'type', 'member']).default('type'),
        limit: limitSchema,
        package_name: z.string().max(500).optional(),
        to_version: versionSchema,
      }),
      outputSchema: z.union([
        pageSchema(
          z.strictObject({
            identity: z.string(),
            kind: z.enum(['package', 'type', 'member']),
            status: z.enum(['added', 'removed']),
          }),
        ),
        errorSchema,
      ]),
      title: 'Compare Iceberg API versions',
    },
    async ({
      cursor,
      from_version: fromVersion,
      kind,
      limit,
      package_name: packageName,
      to_version: toVersion,
    }) =>
      executeTool(
        () =>
          api.compareVersions({
            cursor,
            fromVersion,
            kind,
            limit,
            packageName,
            toVersion,
          }),
        (result) =>
          `Returned ${result.count} ${kind} identity changes from ${fromVersion} to ${toVersion}.`,
        reporter,
      ),
  );

  server.registerTool(
    'iceberg_source_get_type',
    {
      annotations: readOnlyLocal,
      description:
        'Read a bounded, line-numbered source window for an indexed Java type from the configured Iceberg checkout.',
      inputSchema: z.strictObject({
        fully_qualified_name: z.string().min(3).max(1_000),
        line_count: z.number().int().min(1).max(500).default(200),
        start_line: z.number().int().min(1).default(1),
      }),
      outputSchema: z.union([
        z.strictObject({
          endLine: z.number().int().min(1),
          fullyQualifiedName: z.string(),
          lines: z.array(z.string()),
          module: z.string(),
          provenance: provenanceSchema,
          relativePath: z.string(),
          revision: z.string().optional(),
          stableModule: z.boolean(),
          startLine: z.number().int().min(1),
        }),
        errorSchema,
      ]),
      title: 'Get Iceberg Java source',
    },
    async ({
      fully_qualified_name: fullyQualifiedName,
      line_count: lineCount,
      start_line: startLine,
    }) =>
      executeTool(
        () => api.getSourceType({ fullyQualifiedName, lineCount, startLine }),
        (result) =>
          `${result.fullyQualifiedName} from ${result.relativePath}, lines ${result.startLine}-${result.endLine}.`,
        reporter,
      ),
  );

  server.registerTool(
    'iceberg_source_search',
    {
      annotations: readOnlyLocal,
      description:
        'Perform a bounded literal (not regex) search across indexed production Java source files.',
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(100).default(25),
        literal: z.string().min(2).max(200),
      }),
      outputSchema: z.union([
        z.strictObject({
          count: z.number().int().min(0),
          items: z.array(sourceMatchSchema),
          provenance: provenanceSchema,
          truncated: z.boolean(),
        }),
        errorSchema,
      ]),
      title: 'Search Iceberg Java source',
    },
    async ({ limit, literal }) =>
      executeTool(
        () => api.searchSource({ limit, literal }),
        (result) => `Found ${result.count} literal source matches for “${literal}”.`,
        reporter,
      ),
  );

  server.registerTool(
    'iceberg_source_find_implementations',
    {
      annotations: readOnlyLocal,
      description:
        'Find bounded lexical extends/implements declarations for a Java type; results are evidence, not semantic compiler analysis.',
      inputSchema: z.strictObject({
        fully_qualified_name: z.string().min(3).max(1_000),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      outputSchema: z.union([
        z.strictObject({
          count: z.number().int().min(0),
          items: z.array(sourceMatchSchema),
          provenance: provenanceSchema,
          truncated: z.boolean(),
        }),
        errorSchema,
      ]),
      title: 'Find Iceberg source implementations',
    },
    async ({ fully_qualified_name: fullyQualifiedName, limit }) =>
      executeTool(
        () => api.findSourceImplementations({ fullyQualifiedName, limit }),
        (result) =>
          `Found ${result.count} lexical implementation declarations for ${fullyQualifiedName}.`,
        reporter,
      ),
  );
}
