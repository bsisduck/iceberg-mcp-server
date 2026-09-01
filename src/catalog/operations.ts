export type CatalogOperationMode = 'destructive' | 'internal' | 'mutation' | 'read';

export type CatalogOperationId =
  | 'cancelPlanning'
  | 'commitTransaction'
  | 'createNamespace'
  | 'createTable'
  | 'createView'
  | 'dropNamespace'
  | 'dropTable'
  | 'dropView'
  | 'fetchPlanningResult'
  | 'fetchScanTasks'
  | 'getConfig'
  | 'getToken'
  | 'listFunctions'
  | 'listNamespaces'
  | 'listTables'
  | 'listViews'
  | 'loadCredentials'
  | 'loadFunction'
  | 'loadNamespaceMetadata'
  | 'loadTable'
  | 'loadView'
  | 'namespaceExists'
  | 'planTableScan'
  | 'registerTable'
  | 'registerView'
  | 'renameTable'
  | 'renameView'
  | 'replaceView'
  | 'reportMetrics'
  | 'signRequest'
  | 'tableExists'
  | 'updateProperties'
  | 'updateTable'
  | 'unregisterTable'
  | 'viewExists';

export interface CatalogOperation {
  readonly id: CatalogOperationId;
  readonly method: 'DELETE' | 'GET' | 'HEAD' | 'POST';
  readonly mode: CatalogOperationMode;
  readonly paginated: boolean;
  readonly path: string;
  readonly toolName: string | undefined;
}

export const CATALOG_OPERATIONS: readonly CatalogOperation[] = [
  {
    id: 'getConfig',
    method: 'GET',
    mode: 'read',
    paginated: false,
    path: '/v1/config',
    toolName: 'iceberg_catalog_get_config',
  },
  {
    id: 'getToken',
    method: 'POST',
    mode: 'internal',
    paginated: false,
    path: '/v1/oauth/tokens',
    toolName: undefined,
  },
  {
    id: 'listNamespaces',
    method: 'GET',
    mode: 'read',
    paginated: true,
    path: '/v1/{prefix}/namespaces',
    toolName: 'iceberg_catalog_list_namespaces',
  },
  {
    id: 'createNamespace',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces',
    toolName: 'iceberg_catalog_create_namespace',
  },
  {
    id: 'loadNamespaceMetadata',
    method: 'GET',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}',
    toolName: 'iceberg_catalog_get_namespace',
  },
  {
    id: 'namespaceExists',
    method: 'HEAD',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}',
    toolName: 'iceberg_catalog_namespace_exists',
  },
  {
    id: 'dropNamespace',
    method: 'DELETE',
    mode: 'destructive',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}',
    toolName: 'iceberg_catalog_drop_namespace',
  },
  {
    id: 'updateProperties',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/properties',
    toolName: 'iceberg_catalog_update_namespace',
  },
  {
    id: 'listTables',
    method: 'GET',
    mode: 'read',
    paginated: true,
    path: '/v1/{prefix}/namespaces/{namespace}/tables',
    toolName: 'iceberg_catalog_list_tables',
  },
  {
    id: 'createTable',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables',
    toolName: 'iceberg_catalog_create_table',
  },
  {
    id: 'planTableScan',
    method: 'POST',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}/plan',
    toolName: 'iceberg_catalog_plan_table_scan',
  },
  {
    id: 'fetchPlanningResult',
    method: 'GET',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}/plan/{plan-id}',
    toolName: 'iceberg_catalog_get_scan_plan',
  },
  {
    id: 'cancelPlanning',
    method: 'DELETE',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}/plan/{plan-id}',
    toolName: 'iceberg_catalog_cancel_scan_plan',
  },
  {
    id: 'fetchScanTasks',
    method: 'POST',
    mode: 'read',
    paginated: true,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}/tasks',
    toolName: 'iceberg_catalog_get_scan_tasks',
  },
  {
    id: 'registerTable',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/register',
    toolName: 'iceberg_catalog_register_table',
  },
  {
    id: 'loadTable',
    method: 'GET',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}',
    toolName: 'iceberg_catalog_get_table',
  },
  {
    id: 'updateTable',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}',
    toolName: 'iceberg_catalog_commit_table',
  },
  {
    id: 'dropTable',
    method: 'DELETE',
    mode: 'destructive',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}',
    toolName: 'iceberg_catalog_drop_table',
  },
  {
    id: 'tableExists',
    method: 'HEAD',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}',
    toolName: 'iceberg_catalog_table_exists',
  },
  {
    id: 'loadCredentials',
    method: 'GET',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}/credentials',
    toolName: 'iceberg_catalog_get_credential_scopes',
  },
  {
    id: 'signRequest',
    method: 'POST',
    mode: 'internal',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}/sign',
    toolName: undefined,
  },
  {
    id: 'renameTable',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/tables/rename',
    toolName: 'iceberg_catalog_rename_table',
  },
  {
    id: 'reportMetrics',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}/metrics',
    toolName: 'iceberg_catalog_report_metrics',
  },
  {
    id: 'commitTransaction',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/transactions/commit',
    toolName: 'iceberg_catalog_commit_transaction',
  },
  {
    id: 'listViews',
    method: 'GET',
    mode: 'read',
    paginated: true,
    path: '/v1/{prefix}/namespaces/{namespace}/views',
    toolName: 'iceberg_catalog_list_views',
  },
  {
    id: 'createView',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/views',
    toolName: 'iceberg_catalog_create_view',
  },
  {
    id: 'loadView',
    method: 'GET',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/views/{view}',
    toolName: 'iceberg_catalog_get_view',
  },
  {
    id: 'replaceView',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/views/{view}',
    toolName: 'iceberg_catalog_replace_view',
  },
  {
    id: 'dropView',
    method: 'DELETE',
    mode: 'destructive',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/views/{view}',
    toolName: 'iceberg_catalog_drop_view',
  },
  {
    id: 'viewExists',
    method: 'HEAD',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/views/{view}',
    toolName: 'iceberg_catalog_view_exists',
  },
  {
    id: 'renameView',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/views/rename',
    toolName: 'iceberg_catalog_rename_view',
  },
  {
    id: 'registerView',
    method: 'POST',
    mode: 'mutation',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/register-view',
    toolName: 'iceberg_catalog_register_view',
  },
];

export const DEFAULT_CATALOG_ENDPOINTS = new Set([
  'GET /v1/{prefix}/namespaces',
  'POST /v1/{prefix}/namespaces',
  'GET /v1/{prefix}/namespaces/{namespace}',
  'DELETE /v1/{prefix}/namespaces/{namespace}',
  'POST /v1/{prefix}/namespaces/{namespace}/properties',
  'GET /v1/{prefix}/namespaces/{namespace}/tables',
  'POST /v1/{prefix}/namespaces/{namespace}/tables',
  'GET /v1/{prefix}/namespaces/{namespace}/tables/{table}',
  'POST /v1/{prefix}/namespaces/{namespace}/tables/{table}',
  'DELETE /v1/{prefix}/namespaces/{namespace}/tables/{table}',
  'POST /v1/{prefix}/namespaces/{namespace}/register',
  'POST /v1/{prefix}/namespaces/{namespace}/tables/{table}/metrics',
  'POST /v1/{prefix}/tables/rename',
  'POST /v1/{prefix}/transactions/commit',
]);

// Keep this list aligned with RESTSessionCatalog.VIEW_ENDPOINTS. Iceberg uses it only when a
// server omits endpoint discovery and enables the legacy view-endpoints-supported property.
export const DEFAULT_VIEW_ENDPOINTS = new Set([
  'GET /v1/{prefix}/namespaces/{namespace}/views',
  'POST /v1/{prefix}/namespaces/{namespace}/views',
  'GET /v1/{prefix}/namespaces/{namespace}/views/{view}',
  'POST /v1/{prefix}/namespaces/{namespace}/views/{view}',
  'DELETE /v1/{prefix}/namespaces/{namespace}/views/{view}',
  'POST /v1/{prefix}/views/rename',
]);

export const CURRENT_CATALOG_EXTENSION_OPERATIONS: readonly CatalogOperation[] = [
  {
    id: 'listFunctions',
    method: 'GET',
    mode: 'read',
    paginated: true,
    path: '/v1/{prefix}/namespaces/{namespace}/functions',
    toolName: 'iceberg_catalog_list_functions',
  },
  {
    id: 'loadFunction',
    method: 'GET',
    mode: 'read',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/functions/{function}',
    toolName: 'iceberg_catalog_get_function',
  },
  {
    id: 'unregisterTable',
    method: 'POST',
    mode: 'destructive',
    paginated: false,
    path: '/v1/{prefix}/namespaces/{namespace}/tables/{table}/unregister',
    toolName: 'iceberg_catalog_unregister_table',
  },
];

export const ALL_CATALOG_OPERATIONS: readonly CatalogOperation[] = [
  ...CATALOG_OPERATIONS,
  ...CURRENT_CATALOG_EXTENSION_OPERATIONS,
];

export function operationById(id: CatalogOperationId): CatalogOperation {
  const operation = ALL_CATALOG_OPERATIONS.find((candidate) => candidate.id === id);
  if (operation === undefined) {
    throw new Error(`Unknown catalog operation: ${id}`);
  }
  return operation;
}
