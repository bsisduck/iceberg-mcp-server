# Architecture

## Goals

- Make the complete published Iceberg Java API discoverable without flooding an agent's context.
- Resolve structured Javadoc records to detailed documentation and, when a source checkout is
  configured, to implementation source and module stability.
- Compare released API surfaces by exact package, type, and member identity.
- Cover the stable REST Catalog protocol with composable, typed tools while respecting
  server-advertised capabilities.
- Serve both local stdio clients and remote Streamable HTTP clients through the current MCP
  TypeScript SDK.
- Start safely and remain useful with no catalog, credentials, or source checkout.

## Non-goals

- Executing Java, SQL, Spark, Flink, or arbitrary shell commands.
- Reading Iceberg table data files or manifest files directly.
- Exposing arbitrary filesystem paths, HTTP requests, or OpenAPI operations.
- Treating every public Javadoc type as a compatibility-guaranteed API.
- Implementing an OAuth authorization server or returning delegated credentials.
- Supporting vendor-specific catalog extensions without an explicit typed adapter.

## Component model

```mermaid
flowchart LR
  Client[MCP client] --> Transport[stdio or Streamable HTTP]
  Transport --> Factory[MCP server factory]
  Factory --> Tools[tools, resources, prompts]
  Tools --> Api[API intelligence service]
  Tools --> Catalog[REST catalog service]
  Api --> Javadoc[Javadoc provider and cache]
  Api --> Source[local source provider]
  Catalog --> Discovery[/v1/config discovery]
  Catalog --> Auth[Bearer or OAuth token provider]
  Catalog --> Rest[bounded REST client]
  Javadoc --> IcebergDocs[iceberg.apache.org]
  Source --> Checkout[configured Iceberg checkout]
  Rest --> CatalogServer[configured REST Catalog]
```

The MCP layer depends on application services, not on network or filesystem implementations. This
keeps tool handlers small and makes every boundary testable.

## Runtime lifecycle

1. Parse and validate all operator configuration before starting a transport.
2. Build shared, bounded providers and caches. Index the optional source checkout without following
   symbolic links outside its canonical root.
3. Build a fresh `McpServer` from the server factory. Providers are closed over and shared; no
   caller-specific mutable state is stored on the MCP instance.
4. `serveStdio(factory)` pins one instance after protocol-era negotiation.
5. `createMcpHandler(factory)` creates a fresh instance for every HTTP request and serves current
   and legacy stateless protocol eras.
6. On shutdown, close the MCP handler/stdio handle, close the catalog auth provider, and clear
   Javadoc/source caches.

HTTP uses `node:http`, the SDK's `toNodeHandler`, host validation, and origin validation. It binds
to `127.0.0.1` by default. A non-loopback bind requires an explicit allowed-origin list and inbound
bearer authentication configuration.

## Project structure

```text
src/
  cli.ts                     executable and argument parsing
  client-config.ts           non-mutating MCP client setup rendering
  config.ts                  strict environment/runtime configuration
  server.ts                  MCP factory and capability registration
  version.ts                 package name, version, and User-Agent read from package.json
  transport/
    http.ts                  current stateless HTTP serving entry
    stdio.ts                 negotiated stdio serving entry
  api/
    javadoc-provider.ts      index and HTML retrieval
    javadoc-parser.ts        safe JS-index and HTML parsing
    source-provider.ts       canonical local source index
    api-service.ts           search, lookup, comparison workflows
    types.ts                 domain records and provenance
  catalog/
    auth.ts                  bearer/OAuth token lifecycle
    client.ts                bounded REST request execution
    operations.ts            operation inventory and legacy endpoint sets
    response-schemas.ts      operation-specific response validation
    types.ts                 catalog domain and error types
  capabilities/
    api-tools.ts
    catalog-tools.ts         typed REST Catalog tool mappings
    resources.ts
    prompts.ts
  shared/
    errors.ts
    iceberg-version.ts       shared Iceberg version pattern, schema, and default
    pagination.ts
    responses.ts
    redaction.ts
    fetch.ts                 bounded same-root HTTP retrieval and bounded body readers
    semaphore.ts             FIFO, abort-aware concurrency permits
test/
  unit/
  integration/
evaluations/                ten protocol-level read-only questions
scripts/                    package cleanup and OpenAPI coverage checks
```

## Provider contracts

### Javadoc provider

The provider accepts a configured version identifier, never a URL supplied by a tool call. It loads
these JSON-compatible JavaScript assignments without executing them:

- `package-search-index.js`
- `type-search-index.js`
- `member-search-index.js`

The parser removes only the exact expected assignment wrapper, parses the payload with `JSON.parse`,
validates every record, and rejects trailing executable content. Type/member HTML URLs are derived
only from validated index records. Redirects are revalidated against the configured origin and path
prefix.

Each version cache is immutable after load. Concurrent loads share one promise. Failures are
negatively cached briefly to avoid retry storms; successful indexes use a bounded TTL and entry
count. Individual HTML pages have separate byte and TTL limits.

### Source provider

The provider walks `*/src/main/java/**/*.java` from a canonical configured root. It does not follow
directory symlinks. It records:

- module and relative path;
- declared package;
- top-level and nested type names discoverable from the source;
- Git revision and branch when they can be read without mutating the checkout.

Callers select a fully qualified indexed type. No capability accepts a raw path. Source retrieval
returns a bounded line window with line numbers and provenance. Lexical implementation search is
labeled as such. Every indexed path is canonicalized again immediately before it is opened.

### REST Catalog client

The client is created only when `ICEBERG_CATALOG_URI` is configured. Initialization calls
`/v1/config`, applies server defaults, local configuration, then server overrides, and builds a
capability set from advertised endpoints or the spec's documented default set.

Requests use:

- an operator-configured URI and warehouse only;
- strict path-segment encoding for namespaces and identifiers;
- a total deadline and abort signal;
- bounded response bytes and concurrency;
- explicit accepted content types;
- a sanitized `User-Agent` and request correlation ID;
- internal bearer/OAuth headers that are never added to results;
- retry only for safe reads and eligible server errors, with jitter and `Retry-After`;
- spec-aware UUIDv7 idempotency only when advertised for mutations.

Every operation checks discovery before network I/O. Expected REST failures become structured tool
errors containing sanitized status, Iceberg error type/code, message, and retryability. A 409 commit
conflict is never treated as transient.

## Java API capabilities

| Capability                            | Purpose                                                     | Pagination          | Side effects         |
| ------------------------------------- | ----------------------------------------------------------- | ------------------- | -------------------- |
| `iceberg_api_list_versions`           | List configured release/nightly/source identities           | bounded list        | None                 |
| `iceberg_api_browse`                  | Browse packages, types, or members with filters             | opaque cursor       | None                 |
| `iceberg_api_search`                  | Ranked search across names, signatures, and packages        | opaque cursor       | Remote Javadoc reads |
| `iceberg_api_get_type`                | Retrieve one exact type, details, members, stability, links | member limit/cursor | Remote Javadoc read  |
| `iceberg_api_get_member`              | Retrieve one exact member/signature and documentation       | no                  | Remote Javadoc read  |
| `iceberg_api_compare_versions`        | Added and removed API identities between versions           | opaque cursor       | Remote Javadoc reads |
| `iceberg_source_get_type`             | Return source for one indexed API type                      | line window         | Local read           |
| `iceberg_source_search`               | Bounded literal search in indexed production Java source    | opaque cursor       | Local reads          |
| `iceberg_source_find_implementations` | Find declared implementations/extensions of a type          | opaque cursor       | Local reads          |

All are read-only and idempotent. Remote Javadoc tools have `openWorldHint: true`; source-only tools
use `openWorldHint: false`.

## MCP resources and prompts

Canonical resources complement tools rather than duplicating search:

- `iceberg://api/{version}/package/{package}`
- `iceberg://api/{version}/type/{fully-qualified-name}`
- `iceberg://source/type/{fully-qualified-name}`
- `iceberg://catalog/config`

Resource results use JSON. API resources advertise a five-minute public cache hint; source and
catalog resources are private with a zero TTL.

Prompts are user-selected workflow starters:

- `iceberg-java-usage`: ground a Java implementation task in exact API types.
- `iceberg-api-migration`: compare two versions before proposing a migration.
- `iceberg-catalog-investigation`: inspect catalog configuration and metadata using read-only tools
  before considering a mutation.

Prompts never contain credentials and never instruct the client to bypass mutation controls.

The initialization result also carries concise server-wide instructions. The message tells clients
to start read-only, resolve exact Java identities, inspect catalog discovery, preserve cursors,
bound output, protect credentials, and confirm gated mutations. Keeping the whole contract below 512
characters makes it available to clients that prioritize only the leading instructions during tool
selection.

## Common response contract

List/search results use a consistent object envelope:

```json
{
  "items": [],
  "count": 0,
  "has_more": false,
  "next_cursor": null,
  "truncated": false,
  "provenance": {
    "kind": "javadoc",
    "iceberg_version": "1.11.0",
    "source": "https://iceberg.apache.org/javadoc/1.11.0/",
    "retrieved_at": "2026-09-01T00:00:00.000Z"
  }
}
```

Every tool declares and returns a validated output schema. `structuredContent` is always an object
for compatibility with older protocol eras. The text block is a concise Markdown rendering, not a
second full JSON dump. List and source inputs are record/window bounded and state when more data is
available. A final serialized-size check protects every tool and resource; an oversized result
returns a `LimitError` telling the caller to request a smaller page or source window.

Opaque cursors are base64url-encoded, versioned JSON containing an offset or REST page token and a
digest of immutable query parameters. The wrapper adds no authority, but an upstream REST page token
must still be treated as private catalog state. Decoding is strictly bounded and validated; a
mismatch returns an actionable input error instead of silently changing the query.

## Error taxonomy

- `ConfigurationError`: a capability is disabled or runtime configuration is invalid.
- `InputError`: a syntactically valid call refers to an invalid cursor/identifier.
- `NotFoundError`: exact API/source/catalog object does not exist.
- `CapabilityError`: the REST Catalog did not advertise the requested operation.
- `UpstreamError`: sanitized HTTP/Iceberg error with status and retry guidance.
- `LimitError`: source, response, request, or concurrency bounds were exceeded.
- `InternalError`: unexpected failure logged with correlation ID and redacted context.

Expected failures return `isError: true` tool results. Unexpected failures receive a correlation ID
in the tool result and are emitted as one-line JSON diagnostics on stderr. stdout is protocol only.

## Version and stability semantics

- `release`: immutable versioned Javadoc, such as 1.11.0.
- `nightly`: mutable official Javadoc for Iceberg main; shorter cache TTL.
- `source`: configured checkout identity derived from Git when available.
- `stable-module`: source maps to one of the six RevAPI-checked modules.
- `public-unclassified`: public Javadoc but no stable-module evidence.

Stability is evidence, not a guarantee synthesized by the MCP server. Results state the
classification reason and source.

## Configuration contract

| Variable                          | Default                         | Constraint                                        |
| --------------------------------- | ------------------------------- | ------------------------------------------------- |
| `ICEBERG_JAVADOC_VERSION`         | `1.11.0`                        | Semver or `nightly`                               |
| `ICEBERG_JAVADOC_BASE_URL`        | official Iceberg Javadoc origin | HTTPS; operator-only; redirects revalidated       |
| `ICEBERG_SOURCE_DIR`              | sibling `../iceberg` when valid | Canonical readable Iceberg checkout               |
| `ICEBERG_CATALOG_URI`             | unset                           | Absolute HTTP(S); HTTPS required outside loopback |
| `ICEBERG_CATALOG_WAREHOUSE`       | unset                           | Bounded string passed only to config discovery    |
| `ICEBERG_CATALOG_TOKEN`           | unset                           | Secret; never logged or returned                  |
| `ICEBERG_OAUTH2_URI`              | unset                           | Explicit external token endpoint                  |
| `ICEBERG_OAUTH2_CREDENTIAL`       | unset                           | Secret `client_id:client_secret` input            |
| `ICEBERG_CATALOG_ALLOW_MUTATIONS` | `false`                         | Enables registration of mutation tools            |
| `ICEBERG_MCP_TRANSPORT`           | `stdio`                         | `stdio` or `http`                                 |
| `ICEBERG_MCP_HOST`                | `127.0.0.1`                     | Non-loopback requires auth and origins            |
| `ICEBERG_MCP_PORT`                | `3000`                          | 1-65535                                           |
| `ICEBERG_MCP_MAX_REQUEST_BYTES`   | `1048576`                       | 4 KiB-10 MiB; enforced before MCP dispatch        |
| `ICEBERG_MCP_ALLOWED_ORIGINS`     | local origins                   | Exact origin list, no wildcard with auth          |
| `ICEBERG_MCP_AUTH_TOKEN`          | unset                           | Required for non-loopback HTTP                    |
| `ICEBERG_MAX_RESPONSE_CHARS`      | `30000`                         | 4,096-100,000                                     |
| `ICEBERG_REQUEST_TIMEOUT_MS`      | `15000`                         | 1,000-120,000                                     |

Secrets may also use `_FILE` variants so orchestrators can mount them without placing values
directly in the process environment. Supplying both direct and file forms is an error.

## Dependency decisions

- Node.js >=20, matching MCP SDK v2 support.
- `@modelcontextprotocol/server` and `@modelcontextprotocol/node` v2 for MCP and Node HTTP bindings.
  `hono` is not a direct dependency; it arrives only through `@modelcontextprotocol/node`.
- Zod v4 for runtime schemas and MCP JSON Schema generation.
- Cheerio for bounded Javadoc HTML parsing.
- Node's built-in `fetch`, URL, crypto, filesystem, and testable abort primitives.
- `yaml` is development-only for OpenAPI coverage verification and schema tooling.

No Java parser is required: published Javadoc is the member-level structural source, while local
source parsing is deliberately limited to package/type mapping and bounded lexical evidence.
