import { z } from 'zod';

import { UpstreamError } from '../shared/errors.js';
import type { CatalogOperationId } from './operations.js';

const namespaceSchema = z.array(z.string());
const identifierSchema = z.looseObject({ name: z.string(), namespace: namespaceSchema });
const pageTokenSchema = z.string().nullable().optional();
const namespaceResultSchema = z.looseObject({
  namespace: namespaceSchema,
  properties: z.record(z.string(), z.string()).nullable().optional(),
});
const listNamespacesSchema = z.looseObject({
  namespaces: z.array(namespaceSchema).optional(),
  'next-page-token': pageTokenSchema,
});
const listIdentifiersSchema = z.looseObject({
  identifiers: z.array(identifierSchema).optional(),
  'next-page-token': pageTokenSchema,
});
const metadataResultSchema = z.looseObject({
  config: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()),
  'metadata-location': z.string().nullable().optional(),
});
const credentialsSchema = z.looseObject({
  'storage-credentials': z.array(
    z.looseObject({
      config: z.record(z.string(), z.string()),
      prefix: z.string(),
    }),
  ),
});
const objectResultSchema = z.record(z.string(), z.unknown());

const RESPONSE_SCHEMAS: Partial<Record<CatalogOperationId, z.ZodType>> = {
  createNamespace: namespaceResultSchema,
  createTable: metadataResultSchema,
  createView: metadataResultSchema,
  fetchPlanningResult: objectResultSchema,
  fetchScanTasks: objectResultSchema,
  getConfig: objectResultSchema,
  listFunctions: listIdentifiersSchema,
  listNamespaces: listNamespacesSchema,
  listTables: listIdentifiersSchema,
  listViews: listIdentifiersSchema,
  loadCredentials: credentialsSchema,
  loadFunction: metadataResultSchema,
  loadNamespaceMetadata: namespaceResultSchema,
  loadTable: metadataResultSchema,
  loadView: metadataResultSchema,
  planTableScan: objectResultSchema,
  replaceView: metadataResultSchema,
  unregisterTable: metadataResultSchema,
  updateProperties: objectResultSchema,
  updateTable: metadataResultSchema,
};

export function validateCatalogResponse(operationId: CatalogOperationId, data: unknown): unknown {
  const schema = RESPONSE_SCHEMAS[operationId];
  if (schema === undefined || data === null) {
    return data;
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new UpstreamError(
      `Catalog ${operationId} response does not match the Iceberg REST contract`,
      502,
      false,
    );
  }
  return parsed.data;
}
