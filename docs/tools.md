# Tool and workflow reference

The server registers tools dynamically. Java API tools are always present. Source tools are present
but require a configured source checkout when called. Catalog tools exist only after successful
`/v1/config` discovery; state-changing tools additionally require operator opt-in.

The schemas returned by MCP `tools/list` are the authoritative argument reference. All schemas are
strict: unknown fields, malformed identifiers, and mismatched cursors are rejected.

## Java API and source tools

| Tool                                  | Main inputs                                               | Use                                                                               |
| ------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `iceberg_api_list_versions`           | none                                                      | Show the configured release/nightly identity and optional source Git identity.    |
| `iceberg_api_browse`                  | `kind`, optional package/prefix, version, limit/cursor    | Deterministically browse package, type, or member indexes.                        |
| `iceberg_api_search`                  | query, scope, optional package, version, limit/cursor     | Rank matching package, type, member-name, signature, and qualified-name records.  |
| `iceberg_api_get_type`                | exact fully qualified name, version, member limit/cursor  | Read declaration, prose, deprecation, members, links, and stability evidence.     |
| `iceberg_api_get_member`              | exact type plus published member label or anchor, version | Read one overload/member without guessing from a search hit.                      |
| `iceberg_api_compare_versions`        | from/to versions, kind, optional package, limit/cursor    | Find exact added and removed package, type, or member identities.                 |
| `iceberg_source_get_type`             | exact fully qualified name, start line, line count        | Read a bounded, line-numbered source window with module/path/revision provenance. |
| `iceberg_source_search`               | literal, limit/cursor                                     | Search production Java files literally; regular expressions are not accepted.     |
| `iceberg_source_find_implementations` | exact fully qualified name, limit/cursor                  | Find lexical `extends`/`implements` evidence in production source.                |

Recommended lookup flow:

1. Search or browse to establish an exact published identity.
2. Call the exact type tool and follow its returned member labels and Javadoc URL.
3. Call the member tool for the relevant overload.
4. Use source evidence only when behavior is not explicit in the published contract.
5. Treat `stable-module` as compatibility evidence, not a synthesized guarantee for every public
   type.

For migrations, compare package/type/member identities separately. An index-level addition or
removal is evidence about published identity, not proof that runtime behavior is unchanged.

## REST Catalog tools

Every catalog result contains `operation_id`, upstream HTTP `status`, sanitized `data`, and an
opaque `next_cursor` when the upstream returns `next-page-token`. Multipart namespaces are arrays of
unencoded segments, for example `{"namespace":["company","finance"]}`. Table, view, and function
names are also supplied unencoded; the server performs path encoding.

### Released read tools

| Tool                                    | REST operation                                                        |
| --------------------------------------- | --------------------------------------------------------------------- |
| `iceberg_catalog_get_config`            | Sanitized result of `GET /v1/config` and the effective capability set |
| `iceberg_catalog_list_namespaces`       | List namespaces, optionally under a multipart parent                  |
| `iceberg_catalog_get_namespace`         | Load namespace metadata                                               |
| `iceberg_catalog_namespace_exists`      | Check namespace existence with `HEAD`                                 |
| `iceberg_catalog_list_tables`           | List table identifiers in a namespace                                 |
| `iceberg_catalog_plan_table_scan`       | Submit a read-only scan plan                                          |
| `iceberg_catalog_get_scan_plan`         | Fetch an asynchronous plan result                                     |
| `iceberg_catalog_get_scan_tasks`        | Fetch paginated scan tasks                                            |
| `iceberg_catalog_get_table`             | Load table metadata/configuration                                     |
| `iceberg_catalog_table_exists`          | Check table existence with `HEAD`                                     |
| `iceberg_catalog_get_credential_scopes` | Return credential prefixes and config key names, never values         |
| `iceberg_catalog_list_views`            | List view identifiers in a namespace                                  |
| `iceberg_catalog_get_view`              | Load view metadata/configuration                                      |
| `iceberg_catalog_view_exists`           | Check view existence with `HEAD`                                      |

`plan_table_scan` and `get_scan_tasks` use POST in the REST protocol but are classified and
annotated as read-only workflows.

### Released mutation tools

These are registered only with `ICEBERG_CATALOG_ALLOW_MUTATIONS=true` and only when supported by
discovery.

| Tool                                 | Class       | Purpose                                              |
| ------------------------------------ | ----------- | ---------------------------------------------------- |
| `iceberg_catalog_create_namespace`   | mutation    | Create a namespace.                                  |
| `iceberg_catalog_update_namespace`   | mutation    | Atomically set/remove namespace properties.          |
| `iceberg_catalog_drop_namespace`     | destructive | Drop an empty namespace.                             |
| `iceberg_catalog_create_table`       | mutation    | Create or stage a table.                             |
| `iceberg_catalog_cancel_scan_plan`   | mutation    | Cancel an asynchronous scan plan.                    |
| `iceberg_catalog_register_table`     | mutation    | Register existing table metadata.                    |
| `iceberg_catalog_commit_table`       | mutation    | Commit typed table requirements and updates.         |
| `iceberg_catalog_drop_table`         | destructive | Drop a table, optionally requesting data-file purge. |
| `iceberg_catalog_rename_table`       | mutation    | Rename a table identifier.                           |
| `iceberg_catalog_report_metrics`     | mutation    | Submit table metrics.                                |
| `iceberg_catalog_commit_transaction` | mutation    | Commit changes to multiple tables.                   |
| `iceberg_catalog_create_view`        | mutation    | Create a view.                                       |
| `iceberg_catalog_replace_view`       | mutation    | Replace a view with requirements and updates.        |
| `iceberg_catalog_drop_view`          | destructive | Drop a view.                                         |
| `iceberg_catalog_rename_view`        | mutation    | Rename a view identifier.                            |
| `iceberg_catalog_register_view`      | mutation    | Register existing view metadata.                     |

The server never accepts caller-provided idempotency keys. If discovery advertises an
`idempotency-key-lifetime`, it generates one UUIDv7 per logical mutation and may reuse that key for
eligible transient retries. Without that advertisement, mutations are attempted once. HTTP 409
conflicts are never retried.

### Current-main extensions

These are outside the 1.11.0 baseline and are registered only for an exact explicit endpoint
advertisement:

- `iceberg_catalog_list_functions` — read, paginated;
- `iceberg_catalog_get_function` — read;
- `iceberg_catalog_unregister_table` — destructive and mutation-gated.

The deprecated catalog-local OAuth token and remote-signing REST operations are tracked in the
operation inventory but are deliberately not model-callable. Outbound OAuth uses the separately
configured external token URI. Signed authorization material must not enter model context.

The full operation/method/path mapping is maintained in [coverage.md](coverage.md).

## Pagination and output bounds

Use the returned cursor unchanged with the same immutable query arguments. It does not replace MCP
or catalog authentication, but catalog cursors can contain a private upstream page token. Changing
the version, filter, namespace, operation, or other bound input causes an error instead of silently
changing the page.

Choose smaller pages or source windows when a result reaches `ICEBERG_MAX_RESPONSE_CHARS`. The
server does not silently cut JSON or source in the middle of a response; it returns a `LimitError`
with guidance.

## Resources

| Resource                                    | Availability                                 | Content                                   |
| ------------------------------------------- | -------------------------------------------- | ----------------------------------------- |
| `iceberg://api/{version}/package/{package}` | always                                       | Up to 100 exact types in one package      |
| `iceberg://api/{version}/type/{type}`       | always                                       | Exact type details with up to 100 members |
| `iceberg://source/type/{type}`              | always registered; source required when read | Up to 500 source lines for an exact type  |
| `iceberg://catalog/config`                  | catalog configured                           | Sanitized discovery and capability result |

Use paginated tools when a bounded resource is too large.

## Prompts

| Prompt                          | Arguments                                | Intended workflow                                        |
| ------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `iceberg-java-usage`            | goal, optional type/version              | Ground implementation advice in exact APIs and evidence. |
| `iceberg-api-migration`         | goal, from/to versions, optional package | Compare identities before planning a migration.          |
| `iceberg-catalog-investigation` | question                                 | Start with read-only discovery and metadata evidence.    |

Prompts are user-selected templates. They do not grant authority, add credentials, or bypass the
mutation registration boundary.
