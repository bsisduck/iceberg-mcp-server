import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { CatalogClient } from '../catalog/client.js';
import type { CatalogOperationId } from '../catalog/operations.js';
import { operationById } from '../catalog/operations.js';
import type { CatalogCall } from '../catalog/types.js';
import type { ErrorReporter } from '../shared/logging.js';
import { executeTool } from '../shared/responses.js';

const segmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes('/') &&
      !value.includes('\\') &&
      ![...value].some((character) => character.charCodeAt(0) <= 31),
    'must not contain controls or slashes',
  );
const namespaceSchema = z
  .array(segmentSchema)
  .min(1)
  .max(20)
  .describe('Multipart namespace as ordered, unencoded segments.');
const identifierSchema = segmentSchema.describe('Unencoded table or view name.');
const cursorSchema = z
  .string()
  .max(24_000)
  .optional()
  .describe('Opaque cursor from the prior page.');
const pageSizeSchema = z.number().int().min(1).max(1_000).default(100);
const stringMapSchema = z.record(z.string().min(1).max(1_000), z.string().max(20_000));
const jsonObjectSchema = z.record(z.string(), z.json());
const errorSchema = z.strictObject({
  error: z.strictObject({
    correlation_id: z.string().nullable(),
    iceberg_code: z.number().int().nullable(),
    iceberg_type: z.string().nullable(),
    message: z.string(),
    retryable: z.boolean(),
    status: z.number().int().nullable(),
    type: z.string(),
  }),
});
const catalogResultSchema = z.strictObject({
  data: z.unknown(),
  next_cursor: z.string().nullable(),
  operation_id: z.string(),
  status: z.number().int().min(100).max(599),
});

type CatalogInputSchema = z.ZodObject<z.ZodRawShape>;

interface CatalogToolDefinition {
  readonly build: (args: Record<string, unknown>) => CatalogCall;
  readonly description: string;
  readonly inputSchema: CatalogInputSchema;
  readonly operationId: CatalogOperationId;
  readonly title: string;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  return z.string().parse(args[name]);
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  return z.string().optional().parse(args[name]);
}

function requiredNamespace(args: Record<string, unknown>, name = 'namespace'): readonly string[] {
  return namespaceSchema.parse(args[name]);
}

function optionalNamespace(
  args: Record<string, unknown>,
  name: string,
): readonly string[] | undefined {
  return namespaceSchema.optional().parse(args[name]);
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  return z.number().optional().parse(args[name]);
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  return z.boolean().optional().parse(args[name]);
}

function jsonObject(args: Record<string, unknown>, name: string): Record<string, unknown> {
  return jsonObjectSchema.parse(args[name]);
}

function optionalJsonObject(
  args: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  return jsonObjectSchema.optional().parse(args[name]);
}

function compact(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function pathFor(
  args: Record<string, unknown>,
  options: { plan?: boolean; table?: boolean; view?: boolean } = {},
): Record<string, string | readonly string[]> {
  return compact({
    namespace: requiredNamespace(args),
    'plan-id': options.plan === true ? requiredString(args, 'plan_id') : undefined,
    table: options.table === true ? requiredString(args, 'table') : undefined,
    view: options.view === true ? requiredString(args, 'view') : undefined,
  }) as Record<string, string | readonly string[]>;
}

function identifier(namespace: readonly string[], name: string): Record<string, unknown> {
  return { name, namespace };
}

function paginatedCall(
  operationId: CatalogOperationId,
  args: Record<string, unknown>,
  path: Readonly<Record<string, string | readonly string[]>>,
  body?: unknown,
  extraQuery: Readonly<Record<string, string | readonly string[] | undefined>> = {},
): CatalogCall {
  return {
    body,
    cursor: optionalString(args, 'cursor'),
    operationId,
    path,
    query: compact({ pageSize: optionalNumber(args, 'page_size'), ...extraQuery }) as Record<
      string,
      number | string | readonly string[] | undefined
    >,
  };
}

const namespacePathSchema = z.strictObject({ namespace: namespaceSchema });
const tablePathSchema = z.strictObject({ namespace: namespaceSchema, table: identifierSchema });
const viewPathSchema = z.strictObject({ namespace: namespaceSchema, view: identifierSchema });
const paginatedNamespacePathSchema = z.strictObject({
  cursor: cursorSchema,
  namespace: namespaceSchema,
  page_size: pageSizeSchema,
});

const DEFINITIONS: readonly CatalogToolDefinition[] = [
  {
    build: () => ({ operationId: 'getConfig', path: {} }),
    description:
      'Return sanitized merged REST Catalog configuration, advertised endpoint capabilities, namespace separator, and idempotency support.',
    inputSchema: z.strictObject({}),
    operationId: 'getConfig',
    title: 'Get Iceberg catalog configuration',
  },
  {
    build: (args) =>
      paginatedCall('listNamespaces', args, {}, undefined, {
        parent: optionalNamespace(args, 'parent'),
      }),
    description: 'List namespaces, optionally below a multipart parent namespace.',
    inputSchema: z.strictObject({
      cursor: cursorSchema,
      page_size: pageSizeSchema,
      parent: namespaceSchema.optional(),
    }),
    operationId: 'listNamespaces',
    title: 'List Iceberg namespaces',
  },
  {
    build: (args) => ({
      body: compact({
        namespace: requiredNamespace(args),
        properties: stringMapSchema.optional().parse(args['properties']),
      }),
      operationId: 'createNamespace',
      path: {},
    }),
    description: 'Create a multipart namespace with optional string properties.',
    inputSchema: z.strictObject({
      namespace: namespaceSchema,
      properties: stringMapSchema.optional(),
    }),
    operationId: 'createNamespace',
    title: 'Create Iceberg namespace',
  },
  {
    build: (args) => ({
      operationId: 'loadNamespaceMetadata',
      path: pathFor(args),
    }),
    description: 'Load stored metadata properties for an exact namespace.',
    inputSchema: namespacePathSchema,
    operationId: 'loadNamespaceMetadata',
    title: 'Get Iceberg namespace',
  },
  {
    build: (args) => ({ operationId: 'namespaceExists', path: pathFor(args) }),
    description: 'Check whether an exact namespace exists.',
    inputSchema: namespacePathSchema,
    operationId: 'namespaceExists',
    title: 'Check Iceberg namespace',
  },
  {
    build: (args) => ({ operationId: 'dropNamespace', path: pathFor(args) }),
    description: 'Drop an empty namespace. This is destructive and requires mutation opt-in.',
    inputSchema: namespacePathSchema,
    operationId: 'dropNamespace',
    title: 'Drop Iceberg namespace',
  },
  {
    build: (args) => ({
      body: compact({
        removals: z.array(z.string()).max(1_000).optional().parse(args['removals']),
        updates: stringMapSchema.optional().parse(args['updates']),
      }),
      operationId: 'updateProperties',
      path: pathFor(args),
    }),
    description: 'Set and remove namespace properties in one atomic catalog request.',
    inputSchema: z.strictObject({
      namespace: namespaceSchema,
      removals: z.array(z.string().min(1).max(1_000)).max(1_000).optional(),
      updates: stringMapSchema.optional(),
    }),
    operationId: 'updateProperties',
    title: 'Update Iceberg namespace',
  },
  {
    build: (args) => paginatedCall('listTables', args, pathFor(args)),
    description: 'List table identifiers in an exact namespace.',
    inputSchema: paginatedNamespacePathSchema,
    operationId: 'listTables',
    title: 'List Iceberg tables',
  },
  {
    build: (args) => paginatedCall('listFunctions', args, pathFor(args)),
    description:
      'List function identifiers in a namespace when a newer catalog advertises the extension.',
    inputSchema: paginatedNamespacePathSchema,
    operationId: 'listFunctions',
    title: 'List Iceberg functions',
  },
  {
    build: (args) => ({
      operationId: 'loadFunction',
      path: {
        function: requiredString(args, 'function'),
        namespace: requiredNamespace(args),
      },
    }),
    description: 'Load all overloads for a function when a newer catalog advertises the extension.',
    inputSchema: z.strictObject({
      function: identifierSchema,
      namespace: namespaceSchema,
    }),
    operationId: 'loadFunction',
    title: 'Get Iceberg function',
  },
  {
    build: (args) => ({
      body: compact({
        location: optionalString(args, 'location'),
        name: requiredString(args, 'name'),
        'partition-spec': optionalJsonObject(args, 'partition_spec'),
        properties: stringMapSchema.optional().parse(args['properties']),
        schema: jsonObject(args, 'schema'),
        'stage-create': optionalBoolean(args, 'stage_create'),
        'write-order': optionalJsonObject(args, 'write_order'),
      }),
      operationId: 'createTable',
      path: { namespace: requiredNamespace(args) },
    }),
    description:
      'Create or stage an Iceberg table from a typed top-level request and Iceberg schema JSON.',
    inputSchema: z.strictObject({
      location: z.string().max(8_000).optional(),
      name: identifierSchema,
      namespace: namespaceSchema,
      partition_spec: jsonObjectSchema.optional(),
      properties: stringMapSchema.optional(),
      schema: jsonObjectSchema,
      stage_create: z.boolean().optional(),
      write_order: jsonObjectSchema.optional(),
    }),
    operationId: 'createTable',
    title: 'Create Iceberg table',
  },
  {
    build: (args) => ({
      body: compact({
        'case-sensitive': optionalBoolean(args, 'case_sensitive'),
        'end-snapshot-id': optionalNumber(args, 'end_snapshot_id'),
        filter: args['filter'],
        'min-rows-requested': optionalNumber(args, 'min_rows_requested'),
        select: z.array(z.string()).optional().parse(args['select']),
        'snapshot-id': optionalNumber(args, 'snapshot_id'),
        'start-snapshot-id': optionalNumber(args, 'start_snapshot_id'),
        'use-snapshot-schema': optionalBoolean(args, 'use_snapshot_schema'),
      }),
      operationId: 'planTableScan',
      path: pathFor(args, { table: true }),
    }),
    description: 'Plan an Iceberg table scan; this is a read-only idempotent POST workflow.',
    inputSchema: z.strictObject({
      case_sensitive: z.boolean().optional(),
      end_snapshot_id: z.number().int().safe().optional(),
      filter: z.json().optional(),
      min_rows_requested: z.number().int().min(0).safe().optional(),
      namespace: namespaceSchema,
      select: z.array(z.string().min(1).max(1_000)).max(10_000).optional(),
      snapshot_id: z.number().int().safe().optional(),
      start_snapshot_id: z.number().int().safe().optional(),
      table: identifierSchema,
      use_snapshot_schema: z.boolean().optional(),
    }),
    operationId: 'planTableScan',
    title: 'Plan Iceberg table scan',
  },
  {
    build: (args) => ({
      operationId: 'fetchPlanningResult',
      path: pathFor(args, { plan: true, table: true }),
    }),
    description: 'Fetch the current result of an asynchronous table scan plan.',
    inputSchema: z.strictObject({
      namespace: namespaceSchema,
      plan_id: z.string().min(1).max(2_000),
      table: identifierSchema,
    }),
    operationId: 'fetchPlanningResult',
    title: 'Get Iceberg scan plan',
  },
  {
    build: (args) => ({
      operationId: 'cancelPlanning',
      path: pathFor(args, { plan: true, table: true }),
    }),
    description: 'Cancel a server-held scan plan and release its resources.',
    inputSchema: z.strictObject({
      namespace: namespaceSchema,
      plan_id: z.string().min(1).max(2_000),
      table: identifierSchema,
    }),
    operationId: 'cancelPlanning',
    title: 'Cancel Iceberg scan plan',
  },
  {
    build: (args) =>
      paginatedCall('fetchScanTasks', args, pathFor(args, { table: true }), {
        'plan-task': requiredString(args, 'plan_task'),
      }),
    description: 'Fetch bounded scan tasks for an opaque plan task.',
    inputSchema: z.strictObject({
      cursor: cursorSchema,
      namespace: namespaceSchema,
      page_size: pageSizeSchema,
      plan_task: z.string().min(1).max(20_000),
      table: identifierSchema,
    }),
    operationId: 'fetchScanTasks',
    title: 'Get Iceberg scan tasks',
  },
  {
    build: (args) => ({
      body: compact({
        'metadata-location': requiredString(args, 'metadata_location'),
        name: requiredString(args, 'name'),
        overwrite: optionalBoolean(args, 'overwrite'),
      }),
      operationId: 'registerTable',
      path: { namespace: requiredNamespace(args) },
    }),
    description: 'Register an existing table metadata location in a namespace.',
    inputSchema: z.strictObject({
      metadata_location: z.string().min(1).max(8_000),
      name: identifierSchema,
      namespace: namespaceSchema,
      overwrite: z.boolean().optional(),
    }),
    operationId: 'registerTable',
    title: 'Register Iceberg table',
  },
  {
    build: (args) => ({
      operationId: 'loadTable',
      path: pathFor(args, { table: true }),
      query: compact({ snapshots: optionalString(args, 'snapshots') }) as Record<string, string>,
    }),
    description:
      'Load table metadata and sanitized configuration; credential-like fields are recursively redacted.',
    inputSchema: z.strictObject({
      namespace: namespaceSchema,
      snapshots: z.enum(['all', 'refs']).optional(),
      table: identifierSchema,
    }),
    operationId: 'loadTable',
    title: 'Get Iceberg table',
  },
  {
    build: (args) => ({
      body: {
        requirements: z.array(jsonObjectSchema).max(10_000).parse(args['requirements']),
        updates: z.array(jsonObjectSchema).max(10_000).parse(args['updates']),
      },
      operationId: 'updateTable',
      path: pathFor(args, { table: true }),
    }),
    description:
      'Commit typed Iceberg requirements and metadata updates. A 409 conflict is returned without automatic retry.',
    inputSchema: z.strictObject({
      namespace: namespaceSchema,
      requirements: z.array(jsonObjectSchema).max(10_000),
      table: identifierSchema,
      updates: z.array(jsonObjectSchema).max(10_000),
    }),
    operationId: 'updateTable',
    title: 'Commit Iceberg table',
  },
  {
    build: (args) => ({
      operationId: 'dropTable',
      path: pathFor(args, { table: true }),
      query: compact({ purgeRequested: optionalBoolean(args, 'purge_requested') }) as Record<
        string,
        boolean
      >,
    }),
    description: 'Drop a table, optionally requesting data-file purge. This is destructive.',
    inputSchema: tablePathSchema.extend({ purge_requested: z.boolean().optional() }),
    operationId: 'dropTable',
    title: 'Drop Iceberg table',
  },
  {
    build: (args) => ({
      operationId: 'unregisterTable',
      path: pathFor(args, { table: true }),
    }),
    description:
      'Unregister a table without deleting data or metadata when a newer catalog advertises the extension. This is destructive.',
    inputSchema: tablePathSchema,
    operationId: 'unregisterTable',
    title: 'Unregister Iceberg table',
  },
  {
    build: (args) => ({ operationId: 'tableExists', path: pathFor(args, { table: true }) }),
    description: 'Check whether an exact table exists.',
    inputSchema: tablePathSchema,
    operationId: 'tableExists',
    title: 'Check Iceberg table',
  },
  {
    build: (args) => ({
      operationId: 'loadCredentials',
      path: pathFor(args, { table: true }),
    }),
    description:
      'Return only credential prefixes and configuration-key scopes; secret credential values never reach the model.',
    inputSchema: tablePathSchema,
    operationId: 'loadCredentials',
    title: 'Get Iceberg credential scopes',
  },
  {
    build: (args) => ({
      body: {
        destination: identifier(
          requiredNamespace(args, 'destination_namespace'),
          requiredString(args, 'destination_name'),
        ),
        source: identifier(
          requiredNamespace(args, 'source_namespace'),
          requiredString(args, 'source_name'),
        ),
      },
      operationId: 'renameTable',
      path: {},
    }),
    description: 'Atomically rename a table identifier.',
    inputSchema: z.strictObject({
      destination_name: identifierSchema,
      destination_namespace: namespaceSchema,
      source_name: identifierSchema,
      source_namespace: namespaceSchema,
    }),
    operationId: 'renameTable',
    title: 'Rename Iceberg table',
  },
  {
    build: (args) => ({
      body: jsonObject(args, 'report'),
      operationId: 'reportMetrics',
      path: pathFor(args, { table: true }),
    }),
    description: 'Submit a spec-shaped scan or commit metrics report for a table.',
    inputSchema: z.strictObject({
      namespace: namespaceSchema,
      report: jsonObjectSchema.refine(
        (value) => typeof value['report-type'] === 'string',
        'report-type is required',
      ),
      table: identifierSchema,
    }),
    operationId: 'reportMetrics',
    title: 'Report Iceberg table metrics',
  },
  {
    build: (args) => ({
      body: {
        'table-changes': z.array(jsonObjectSchema).min(1).max(1_000).parse(args['table_changes']),
      },
      operationId: 'commitTransaction',
      path: {},
    }),
    description: 'Commit multiple identifier-bearing table changes as one catalog transaction.',
    inputSchema: z.strictObject({
      table_changes: z.array(jsonObjectSchema).min(1).max(1_000),
    }),
    operationId: 'commitTransaction',
    title: 'Commit Iceberg transaction',
  },
  {
    build: (args) => paginatedCall('listViews', args, pathFor(args)),
    description: 'List view identifiers in an exact namespace.',
    inputSchema: paginatedNamespacePathSchema,
    operationId: 'listViews',
    title: 'List Iceberg views',
  },
  {
    build: (args) => ({
      body: compact({
        location: optionalString(args, 'location'),
        name: requiredString(args, 'name'),
        properties: stringMapSchema.parse(args['properties']),
        schema: jsonObject(args, 'schema'),
        'view-version': jsonObject(args, 'view_version'),
      }),
      operationId: 'createView',
      path: { namespace: requiredNamespace(args) },
    }),
    description: 'Create a view from Iceberg schema and view-version JSON.',
    inputSchema: z.strictObject({
      location: z.string().max(8_000).optional(),
      name: identifierSchema,
      namespace: namespaceSchema,
      properties: stringMapSchema,
      schema: jsonObjectSchema,
      view_version: jsonObjectSchema,
    }),
    operationId: 'createView',
    title: 'Create Iceberg view',
  },
  {
    build: (args) => ({ operationId: 'loadView', path: pathFor(args, { view: true }) }),
    description: 'Load view metadata and recursively sanitized configuration.',
    inputSchema: viewPathSchema,
    operationId: 'loadView',
    title: 'Get Iceberg view',
  },
  {
    build: (args) => ({
      body: compact({
        requirements: z.array(jsonObjectSchema).max(10_000).optional().parse(args['requirements']),
        updates: z.array(jsonObjectSchema).max(10_000).parse(args['updates']),
      }),
      operationId: 'replaceView',
      path: pathFor(args, { view: true }),
    }),
    description: 'Commit Iceberg view requirements and metadata updates.',
    inputSchema: z.strictObject({
      namespace: namespaceSchema,
      requirements: z.array(jsonObjectSchema).max(10_000).optional(),
      updates: z.array(jsonObjectSchema).max(10_000),
      view: identifierSchema,
    }),
    operationId: 'replaceView',
    title: 'Replace Iceberg view',
  },
  {
    build: (args) => ({ operationId: 'dropView', path: pathFor(args, { view: true }) }),
    description: 'Drop an exact view. This is destructive.',
    inputSchema: viewPathSchema,
    operationId: 'dropView',
    title: 'Drop Iceberg view',
  },
  {
    build: (args) => ({ operationId: 'viewExists', path: pathFor(args, { view: true }) }),
    description: 'Check whether an exact view exists.',
    inputSchema: viewPathSchema,
    operationId: 'viewExists',
    title: 'Check Iceberg view',
  },
  {
    build: (args) => ({
      body: {
        destination: identifier(
          requiredNamespace(args, 'destination_namespace'),
          requiredString(args, 'destination_name'),
        ),
        source: identifier(
          requiredNamespace(args, 'source_namespace'),
          requiredString(args, 'source_name'),
        ),
      },
      operationId: 'renameView',
      path: {},
    }),
    description: 'Atomically rename a view identifier.',
    inputSchema: z.strictObject({
      destination_name: identifierSchema,
      destination_namespace: namespaceSchema,
      source_name: identifierSchema,
      source_namespace: namespaceSchema,
    }),
    operationId: 'renameView',
    title: 'Rename Iceberg view',
  },
  {
    build: (args) => ({
      body: {
        'metadata-location': requiredString(args, 'metadata_location'),
        name: requiredString(args, 'name'),
      },
      operationId: 'registerView',
      path: { namespace: requiredNamespace(args) },
    }),
    description: 'Register an existing view metadata location in a namespace.',
    inputSchema: z.strictObject({
      metadata_location: z.string().min(1).max(8_000),
      name: identifierSchema,
      namespace: namespaceSchema,
    }),
    operationId: 'registerView',
    title: 'Register Iceberg view',
  },
];

export function catalogToolDefinitions(): readonly CatalogToolDefinition[] {
  return DEFINITIONS;
}

export function registerCatalogTools(
  server: McpServer,
  client: CatalogClient,
  allowMutations: boolean,
  reporter: ErrorReporter,
): void {
  for (const definition of DEFINITIONS) {
    const operation = operationById(definition.operationId);
    if (
      operation.toolName === undefined ||
      !client.supports(operation) ||
      (operation.mode !== 'read' && !allowMutations)
    ) {
      continue;
    }
    const destructive = operation.mode === 'destructive';
    server.registerTool(
      operation.toolName,
      {
        annotations: {
          destructiveHint: destructive,
          idempotentHint:
            operation.mode === 'read' || client.discovery.idempotencyKeyLifetime !== undefined,
          openWorldHint: true,
          readOnlyHint: operation.mode === 'read',
        },
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: z.union([catalogResultSchema, errorSchema]),
        title: definition.title,
      },
      async (rawArgs) => {
        const args = definition.inputSchema.parse(rawArgs);
        return executeTool(
          () => client.call(definition.build(args)),
          (result) =>
            `${definition.title} completed with HTTP ${result.status}${result.next_cursor === null ? '.' : '; another page is available.'}`,
          reporter,
        );
      },
    );
  }
}
