# Capability coverage matrix

Status legend: planned, implemented, contract-tested, protocol-tested.

## Java API and source coverage

| Surface                           | Provider evidence                             | MCP capability                                              | Status          |
| --------------------------------- | --------------------------------------------- | ----------------------------------------------------------- | --------------- |
| Available Javadoc/source versions | Configured providers and source Git identity  | `iceberg_api_list_versions`                                 | implemented     |
| Packages                          | `package-search-index.js`                     | `iceberg_api_browse`, package resource                      | protocol-tested |
| Types                             | `type-search-index.js`, type HTML             | `iceberg_api_search`, `iceberg_api_get_type`, type resource | protocol-tested |
| Members and overloads             | `member-search-index.js`, member details HTML | `iceberg_api_search`, `iceberg_api_get_member`              | implemented     |
| Deprecation/inheritance/details   | Type HTML                                     | `iceberg_api_get_type`, `iceberg_api_get_member`            | implemented     |
| Cross-version additions/removals  | Two immutable published index sets            | `iceberg_api_compare_versions`                              | implemented     |
| Source module/path/revision       | Configured checkout index                     | `iceberg_source_get_type`, source resource                  | protocol-tested |
| Literal source evidence           | Configured production Java files              | `iceberg_source_search`                                     | implemented     |
| Implementations/extensions        | Javadoc inheritance plus lexical declarations | `iceberg_source_find_implementations`                       | implemented     |
| Stability classification          | Source module and upstream RevAPI module set  | Included in type/source results                             | implemented     |

The matrix covers the full index rather than a curated class list. Pagination, filtering, and output
budgets are part of each capability's contract.

## REST Catalog 1.11.0 operations

The deprecated catalog-local OAuth token and remote-signing operations are deliberately not
model-callable because their outputs are credentials. The other 30 released operations map to typed
tools. Mutation tools are registered only after explicit operator opt-in.

|   # | Operation ID            | Method and path                                                            | MCP capability                                      | Mode                 | Status             |
| --: | ----------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- | -------------------- | ------------------ |
|   1 | `getConfig`             | `GET /v1/config`                                                           | `iceberg_catalog_get_config`                        | read                 | implemented        |
|   2 | `getToken`              | `POST /v1/oauth/tokens`                                                    | excluded; explicit external OAuth is supported      | credential-bearing   | not model-callable |
|   3 | `listNamespaces`        | `GET /v1/{prefix}/namespaces`                                              | `iceberg_catalog_list_namespaces`                   | read                 | implemented        |
|   4 | `createNamespace`       | `POST /v1/{prefix}/namespaces`                                             | `iceberg_catalog_create_namespace`                  | mutation             | implemented        |
|   5 | `loadNamespaceMetadata` | `GET /v1/{prefix}/namespaces/{namespace}`                                  | `iceberg_catalog_get_namespace`                     | read                 | implemented        |
|   6 | `namespaceExists`       | `HEAD /v1/{prefix}/namespaces/{namespace}`                                 | `iceberg_catalog_namespace_exists`                  | read                 | implemented        |
|   7 | `dropNamespace`         | `DELETE /v1/{prefix}/namespaces/{namespace}`                               | `iceberg_catalog_drop_namespace`                    | destructive          | implemented        |
|   8 | `updateProperties`      | `POST /v1/{prefix}/namespaces/{namespace}/properties`                      | `iceberg_catalog_update_namespace`                  | mutation             | implemented        |
|   9 | `listTables`            | `GET /v1/{prefix}/namespaces/{namespace}/tables`                           | `iceberg_catalog_list_tables`                       | read                 | implemented        |
|  10 | `createTable`           | `POST /v1/{prefix}/namespaces/{namespace}/tables`                          | `iceberg_catalog_create_table`                      | mutation             | implemented        |
|  11 | `planTableScan`         | `POST /v1/{prefix}/namespaces/{namespace}/tables/{table}/plan`             | `iceberg_catalog_plan_table_scan`                   | read/idempotent POST | implemented        |
|  12 | `fetchPlanningResult`   | `GET /v1/{prefix}/namespaces/{namespace}/tables/{table}/plan/{plan-id}`    | `iceberg_catalog_get_scan_plan`                     | read                 | implemented        |
|  13 | `cancelPlanning`        | `DELETE /v1/{prefix}/namespaces/{namespace}/tables/{table}/plan/{plan-id}` | `iceberg_catalog_cancel_scan_plan`                  | mutation             | implemented        |
|  14 | `fetchScanTasks`        | `POST /v1/{prefix}/namespaces/{namespace}/tables/{table}/tasks`            | `iceberg_catalog_get_scan_tasks`                    | read/idempotent POST | implemented        |
|  15 | `registerTable`         | `POST /v1/{prefix}/namespaces/{namespace}/register`                        | `iceberg_catalog_register_table`                    | mutation             | implemented        |
|  16 | `loadTable`             | `GET /v1/{prefix}/namespaces/{namespace}/tables/{table}`                   | `iceberg_catalog_get_table`                         | read                 | implemented        |
|  17 | `updateTable`           | `POST /v1/{prefix}/namespaces/{namespace}/tables/{table}`                  | `iceberg_catalog_commit_table`                      | mutation             | implemented        |
|  18 | `dropTable`             | `DELETE /v1/{prefix}/namespaces/{namespace}/tables/{table}`                | `iceberg_catalog_drop_table`                        | destructive          | implemented        |
|  19 | `tableExists`           | `HEAD /v1/{prefix}/namespaces/{namespace}/tables/{table}`                  | `iceberg_catalog_table_exists`                      | read                 | implemented        |
|  20 | `loadCredentials`       | `GET /v1/{prefix}/namespaces/{namespace}/tables/{table}/credentials`       | `iceberg_catalog_get_credential_scopes` (redacted)  | sensitive read       | implemented        |
|  21 | `signRequest`           | `POST /v1/{prefix}/namespaces/{namespace}/tables/{table}/sign`             | excluded; signed authorization is not model-visible | credential-bearing   | not model-callable |
|  22 | `renameTable`           | `POST /v1/{prefix}/tables/rename`                                          | `iceberg_catalog_rename_table`                      | mutation             | implemented        |
|  23 | `reportMetrics`         | `POST /v1/{prefix}/namespaces/{namespace}/tables/{table}/metrics`          | `iceberg_catalog_report_metrics`                    | mutation             | implemented        |
|  24 | `commitTransaction`     | `POST /v1/{prefix}/transactions/commit`                                    | `iceberg_catalog_commit_transaction`                | mutation             | implemented        |
|  25 | `listViews`             | `GET /v1/{prefix}/namespaces/{namespace}/views`                            | `iceberg_catalog_list_views`                        | read                 | implemented        |
|  26 | `createView`            | `POST /v1/{prefix}/namespaces/{namespace}/views`                           | `iceberg_catalog_create_view`                       | mutation             | implemented        |
|  27 | `loadView`              | `GET /v1/{prefix}/namespaces/{namespace}/views/{view}`                     | `iceberg_catalog_get_view`                          | read                 | implemented        |
|  28 | `replaceView`           | `POST /v1/{prefix}/namespaces/{namespace}/views/{view}`                    | `iceberg_catalog_replace_view`                      | mutation             | implemented        |
|  29 | `dropView`              | `DELETE /v1/{prefix}/namespaces/{namespace}/views/{view}`                  | `iceberg_catalog_drop_view`                         | destructive          | implemented        |
|  30 | `viewExists`            | `HEAD /v1/{prefix}/namespaces/{namespace}/views/{view}`                    | `iceberg_catalog_view_exists`                       | read                 | implemented        |
|  31 | `renameView`            | `POST /v1/{prefix}/views/rename`                                           | `iceberg_catalog_rename_view`                       | mutation             | implemented        |
|  32 | `registerView`          | `POST /v1/{prefix}/namespaces/{namespace}/register-view`                   | `iceberg_catalog_register_view`                     | mutation             | implemented        |

Both excluded operations remain in the operation inventory and automated OpenAPI coverage diff so
their deliberate policy is visible. External OAuth client credentials are implemented separately in
the auth provider.

## Current-main extensions

These operations are not in the 1.11.0 release baseline and execute only when the catalog advertises
their exact endpoints.

| Operation ID      | MCP capability                     | Mode        | Status                       |
| ----------------- | ---------------------------------- | ----------- | ---------------------------- |
| `listFunctions`   | `iceberg_catalog_list_functions`   | read        | implemented; advertised only |
| `loadFunction`    | `iceberg_catalog_get_function`     | read        | implemented; advertised only |
| `unregisterTable` | `iceberg_catalog_unregister_table` | destructive | implemented; advertised only |

## Cross-cutting verification

| Requirement                                      | Evidence at completion                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Every capability has strict input/output schemas | Protocol `tools/list`, direct definition, and invalid-input tests             |
| Correct annotations                              | Protocol metadata and mutation-mode assertions                                |
| Complete released REST mapping                   | Automated OpenAPI `operationId` diff with only documented internal exclusions |
| Context-safe pagination                          | unit and integration tests at item/character limits                           |
| Current and legacy MCP eras                      | protocol tests through `createMcpHandler` and spawned `serveStdio`            |
| Safe documentation-only startup                  | integration test without source/catalog configuration                         |
| Capability gating                                | mock `/v1/config` endpoint subsets                                            |
| No secret output                                 | recursive redaction and credential-scope assertions                           |
