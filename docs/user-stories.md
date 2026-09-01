# Supported user stories and use cases

No finite list can represent every question an agent may ask. This catalog instead traces every
shipped capability to realistic user outcomes and identifies the boundaries that should not be
presented as supported. The exact tool schemas and REST operation mapping remain authoritative in
[tools.md](tools.md) and [coverage.md](coverage.md).

## Java developer and library-maintainer stories

| ID  | User story                                                                                                            | Primary workflow                                         | Acceptance evidence                          |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| J1  | As a developer, I can see which pinned Javadoc and source identities are available before relying on an answer.       | `iceberg_api_list_versions`                              | Protocol call and version-provider tests     |
| J2  | As a developer, I can browse every published package, type, or member without knowing a search term.                  | `iceberg_api_browse`, cursor paging                      | Real-index evaluations and paging tests      |
| J3  | As a developer, I can search names, signatures, and qualified identities and narrow by surface/package.               | `iceberg_api_search`                                     | Search ranking, filters, and cursor tests    |
| J4  | As a developer, I can inspect one exact type's declaration, prose, deprecation, members, URL, and stability evidence. | search then `iceberg_api_get_type`                       | Protocol tool execution and parser tests     |
| J5  | As a developer, I can select an exact overload rather than inventing a method signature.                              | type result then `iceberg_api_get_member`                | Multi-hop evaluations 1 to 8                 |
| J6  | As a maintainer, I can compare exact package/type/member identities across two releases.                              | `iceberg_api_compare_versions`                           | Evaluation 10 and cross-cache tests          |
| J7  | As a developer, I can read a bounded, line-numbered source window for an indexed public type.                         | `iceberg_source_get_type`                                | Source boundary, symlink, and protocol tests |
| J8  | As a debugger, I can find bounded literal evidence in production Java without supplying a regular expression.         | `iceberg_source_search`                                  | Literal, adversarial-input, and cursor tests |
| J9  | As a developer, I can find lexical `extends`/`implements` candidates for an exact indexed type.                       | `iceberg_source_find_implementations`                    | Evaluation 9 and injection/target tests      |
| J10 | As an API reviewer, I can distinguish stable-module evidence from public-but-unclassified API.                        | type/source stability fields                             | Module mapping and real-index tests          |
| J11 | As a migration owner, I can produce a staged evidence-backed upgrade plan.                                            | `iceberg-api-migration` prompt plus compare/detail tools | Prompt and evaluation protocol tests         |
| J12 | As a developer, I can start a guided implementation investigation without bypassing exact lookups.                    | `iceberg-java-usage` prompt                              | Prompt get/list protocol tests               |

Representative use cases include implementing append/incremental scans, selecting update/commit
contracts, auditing deprecations before dependency upgrades, locating extension implementations, and
reviewing whether an API belongs to one of Iceberg's RevAPI-checked modules.

## Catalog reader and data-platform stories

| ID  | User story                                                                                                                      | Primary workflow                        | Preconditions                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------- |
| R1  | As an operator, I can inspect sanitized merged config and the exact advertised capability set.                                  | `iceberg_catalog_get_config`            | Catalog configured; discovery succeeds                   |
| R2  | As an operator, I can list, load, and check multipart namespaces.                                                               | namespace list/get/exists tools         | Corresponding endpoints advertised                       |
| R3  | As an operator, I can list, load, and check tables without constructing encoded paths.                                          | table list/get/exists tools             | Corresponding endpoints advertised                       |
| R4  | As an operator, I can list, load, and check views.                                                                              | view list/get/exists tools              | View endpoints advertised or legacy view support enabled |
| R5  | As an operator, I can list/load functions on a catalog implementing the current extension.                                      | function list/get tools                 | Exact current-main endpoints explicitly advertised       |
| R6  | As a query planner, I can submit a read-only scan plan and fetch an asynchronous result.                                        | plan/get scan tools                     | Scan-planning endpoints advertised                       |
| R7  | As a query planner, I can page through bounded scan tasks without exposing a raw REST request tool.                             | `iceberg_catalog_get_scan_tasks`        | Plan task obtained from the catalog                      |
| R8  | As a security reviewer, I can inspect credential prefixes and property key names without model-visible secret values.           | `iceberg_catalog_get_credential_scopes` | Credential endpoint advertised and authorized            |
| R9  | As a client, I can page namespaces/tables/views/functions/tasks with query-bound opaque cursors.                                | list tools with returned cursor         | Cursor reused with unchanged arguments                   |
| R10 | As an operator, I receive structured Iceberg status/type/code errors without authorization headers, response bodies, or stacks. | any catalog call                        | Expected or normalized upstream failure                  |
| R11 | As an operator, I can start a guided read-only investigation before considering a catalog mutation.                             | `iceberg-catalog-investigation` prompt  | Prompt get/list protocol tests                           |

The server validates discovery before operation I/O. Explicit endpoint advertisements are
authoritative; an absent or empty list uses only Iceberg's documented legacy defaults.

## Catalog mutation stories

Every story in this section requires all three controls: the catalog is configured and advertises
the endpoint, `ICEBERG_CATALOG_ALLOW_MUTATIONS=true`, and the catalog principal is authorized. The
client/user must still review the action. Mutation registration is an availability control, not an
authorization system.

| ID  | User story                                                    | Tool family                  | Safety behavior                                        |
| --- | ------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| M1  | Create, update, or drop an empty namespace.                   | namespace create/update/drop | Drop is destructive; exact multipart segments required |
| M2  | Create or stage a table from a spec-shaped schema/spec/order. | create table                 | Strict bounded JSON; no invented defaults              |
| M3  | Register existing table metadata.                             | register table               | Exact metadata location and identifier required        |
| M4  | Commit typed table requirements and updates.                  | commit table                 | 409 conflicts surfaced and never retried               |
| M5  | Rename a table atomically.                                    | rename table                 | Separate exact source/destination identifiers          |
| M6  | Drop a table with an explicit optional purge request.         | drop table                   | Destructive annotation; purge is never implicit        |
| M7  | Unregister a table on a supporting current catalog.           | unregister table             | Destructive, extension-gated, no data purge promise    |
| M8  | Submit scan/commit metrics.                                   | report metrics               | State-changing, spec-shaped report                     |
| M9  | Commit identifier-bearing changes to multiple tables.         | commit transaction           | One catalog transaction body; conflicts preserved      |
| M10 | Cancel an asynchronous server-held scan plan.                 | cancel scan plan             | State-changing cleanup of exact plan ID                |
| M11 | Create or register a view.                                    | create/register view         | Strict schema/version or metadata location             |
| M12 | Replace a view with typed requirements and updates.           | replace view                 | Conflict semantics preserved                           |
| M13 | Rename or drop a view.                                        | rename/drop view             | Drop marked destructive                                |

Eligible transient mutation retries occur only when discovery advertises the idempotency-key
lifetime. The server generates UUIDv7 keys internally per logical request. Callers cannot supply or
reuse a key, and conflicts are never treated as transient.

## Client, security, and operations stories

| ID  | User story                                                               | Supported path                                                             |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| O1  | Install without guessing a client schema.                                | `--print-client-config` for seven target formats                           |
| O2  | Use documentation without credentials or an Iceberg checkout.            | Default stdio, official pinned Javadocs                                    |
| O3  | Add local implementation evidence without arbitrary file access.         | Absolute `ICEBERG_SOURCE_DIR`, indexed type tools only                     |
| O4  | Keep catalog access read-only by default.                                | Mutation tools unregistered unless explicitly enabled                      |
| O5  | Run locally without an open port.                                        | stdio transport, protocol-only stdout                                      |
| O6  | Run remotely with bounded input/output and exact origin/host checks.     | Stateless Streamable HTTP `/mcp` endpoint                                  |
| O7  | Rotate secrets through mounted files.                                    | `_FILE` variants loaded once at startup                                    |
| O8  | Diagnose failures without leaking credentials.                           | Structured tool errors plus redacted stderr correlation logs               |
| O9  | Keep model context bounded.                                              | discovery-gated tools, concise instructions, filters, limits, and cursors  |
| O10 | Verify the package before adoption.                                      | check, coverage, OpenAPI, evaluations, client-template, pack/install gates |
| O11 | Address canonical package/type/source/config data without a search call. | Three Java/source templates plus conditional catalog config resource       |

## Deliberate non-stories

- The server does not build or publish Apache Iceberg itself; `iceberg/` is an unmodified evidence
  checkout. It builds this MCP integration around Iceberg's public documentation, source, and REST
  protocol.
- It is not a SQL engine, Spark/Flink runtime, table-file reader, object-store proxy, or catalog
  implementation.
- It does not provide semantic Java call graphs. Source search and implementation discovery are
  lexical evidence.
- It does not expose a generic URL, filesystem path, REST request, OAuth token exchange, remote
  signing, or vended-secret tool.
- It does not support undocumented vendor endpoints merely because discovery returns them.
- It does not make a single process multi-tenant. Use isolated processes/principals and an
  OAuth-aware gateway for multi-user deployment.
- It cannot prove a vendor catalog conforms without that catalog. Contract tests use a deterministic
  mock; deployment-specific conformance remains an operator acceptance task.

These boundaries are part of the product contract: adding one requires a new threat-model review,
typed schemas, protocol tests, documentation, and explicit compatibility evidence.
