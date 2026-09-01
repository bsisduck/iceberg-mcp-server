# Apache Iceberg MCP server research report

Audience: MCP implementers, Java developers, and Iceberg platform operators  
Research date: 2026-09-01  
Target: Apache Iceberg Java API plus the separate REST Catalog protocol

## Executive answer

The supplied URL is the Iceberg Java API guide for the current 1.11.0 release, not an HTTP API. An
MCP server for this project therefore needs two separate capability planes:

1. A documentation and source-intelligence plane that indexes published Javadoc packages, types, and
   members, resolves API types to source, compares versions, and exposes bounded search and
   canonical resources.
2. An optional operational plane that calls a configured Iceberg REST Catalog using the
   independently published OpenAPI protocol. It must discover server capabilities from `/v1/config`,
   keep credentials out of tool arguments, and expose mutations as narrowly typed, correctly
   annotated tools.

Collapsing these planes would be misleading: Javadoc is reference material, while the REST Catalog
is a remote protocol with authentication, concurrency, idempotency, and compatibility behavior of
its own.

## Scope and assumptions

- The default documentation target is the latest stable Iceberg release, 1.11.0.
- The sibling `iceberg/` checkout is an optional local source provider. Its current `main` revision
  is newer than 1.11.0, so it must be labeled as a separate source version rather than silently
  treated as released Javadoc.
- A configured REST Catalog is optional. Documentation tools must start and work without credentials
  or a live catalog.
- The first production transport targets MCP 2026-07-28 and retains compatibility with 2025-era
  clients through the official TypeScript SDK serving entries.
- The project will not embed Spark, Flink, a JVM, or an Iceberg query engine.

## Findings

### Version and publication model

The official releases page identifies 1.11.0 as the latest release and dates it to May 19, 2026. The
supplied `docs/latest/api/` page also identifies itself as `Latest (1.11.0)`. Its API guide covers
tables, scans, update operations, transactions, types, expressions, and library modules. The same
site exposes versioned Javadoc at `/javadoc/1.11.0/` and a separate `/javadoc/nightly/` tree. These
are distinct compatibility targets and cannot safely share an unlabeled cache or result envelope.
See the [release page](https://iceberg.apache.org/releases/),
[Java API guide](https://iceberg.apache.org/docs/latest/api/),
[1.11.0 Javadoc](https://iceberg.apache.org/javadoc/1.11.0/), and
[nightly Javadoc](https://iceberg.apache.org/javadoc/nightly/).

The release Javadoc search indexes contain 98 packages, 1,761 types, and 15,306 members. These
counts were derived from the exact 1.11.0 `package-search-index.js`, `type-search-index.js`, and
`member-search-index.js` artifacts on Iceberg's published `javadoc` branch. The index files are
compact structured discovery data; individual HTML pages provide signatures, descriptions,
inheritance, deprecation, and detailed member documentation.

The aggregate Javadoc contains every subproject's public Java declarations, but "public" does not
mean "stable Iceberg API." The upstream build applies RevAPI compatibility checks to `iceberg-api`,
`iceberg-core`, `iceberg-parquet`, `iceberg-orc`, `iceberg-common`, and `iceberg-data`. Results must
therefore include the source module and a stability classification instead of presenting all 1,761
types as equally guaranteed. See the upstream
[build configuration](https://github.com/apache/iceberg/blob/main/build.gradle).

### Source model

The local checkout contains 327 Java source files in `api/` and approximately 3,194 production Java
files across the repository. Source mapping should index only `src/main/java` beneath a canonical
operator-configured root, derive module and package from repository structure, and map nested
Javadoc types to their outer source file. Tools must select already-indexed identifiers; they must
not accept arbitrary filesystem paths.

The source checkout and selected Javadoc version may legitimately differ. Every source or API result
needs provenance fields for Javadoc version/base URL and, when available, source Git
revision/module/path. Version comparison must compare two published Javadoc indexes rather than
infer compatibility from a newer source tree.

### REST Catalog surface

Iceberg documents the REST Catalog as a separate OpenAPI protocol for portable catalog operations.
The 1.11.0 OpenAPI document defines 32 operations. Current `main` defines 35, adding
`listFunctions`, `loadFunction`, and `unregisterTable`. The server must target the stable release
baseline and enable newer operations only when advertised or selected, rather than assuming the
local `main` surface exists everywhere. See the
[REST Catalog overview](https://iceberg.apache.org/rest-catalog-spec/) and
[1.11.0 OpenAPI document](https://github.com/apache/iceberg/blob/apache-iceberg-1.11.0/open-api/rest-catalog-open-api.yaml).

The protocol requires clients to call `/v1/config` first. Server defaults are applied before client
configuration and server overrides after it; an optional `endpoints` list advertises supported
operations. The implemented runtime discovers once during startup, keeps the effective result
inspectable through a read-only tool, and re-discovers on process restart.

List operations have unusual pagination semantics. Omitting `pageToken` asks a supporting server to
return all results, while an empty `pageToken` initiates a paginated sequence. Missing or `null`
`next-page-token` means completion. MCP list tools should default to paginated requests with a local
item/character budget and surface the opaque next token through a query-bound cursor.

Mutations use change-based commits and typed requirements to implement optimistic concurrency. The
current release spec also defines optional UUIDv7 `Idempotency-Key` behavior; support is advertised
by `idempotency-key-lifetime` in catalog config. The client must reuse a key only for retries of the
same logical operation and never across different mutations. Mutation tools must not hide 409
conflicts or retry them as transient failures.

### Authentication and credential handling

The REST OpenAPI document applies OAuth2 or Bearer authorization across routes. Its built-in
`/v1/oauth/tokens` endpoint is explicitly deprecated since Iceberg 1.6.0 and planned for removal in
2.0; clients are encouraged to configure an external `oauth2-server-uri`. The MCP server should
accept a bearer token or OAuth client credentials only through environment or mounted-secret-file
runtime configuration, fetch and refresh tokens internally, and redact authorization data from
errors and telemetry. It should not expose token exchange as a model-callable tool.

Iceberg's own threat model treats the operator-selected catalog, endpoints, and storage integrations
as trusted configuration, but identifies secret or delegated credential disclosure across
catalog/session/principal boundaries as an in-scope security failure. The MCP process adds a new
audience boundary, so vended storage credentials and remote-signing payloads must be omitted or
explicitly redacted from ordinary tool output. See the upstream
[security threat model](https://github.com/apache/iceberg/blob/main/SECURITY-THREAT-MODEL.md).

### MCP implementation baseline

The stable TypeScript SDK is now v2, split into packages such as `@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, and `@modelcontextprotocol/express`; the monolithic v1 package is
legacy. Version 2 implements MCP 2026-07-28, whose core is stateless and whose Streamable HTTP
transport uses a separate POST per request. The server should use `serveStdio` and the v2 HTTP
handler factory so protocol-era negotiation is handled by the SDK. See the
[v2 server package](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/),
[tool guide](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools),
[HTTP serving guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http), and
[2026-07-28 migration guidance](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

Streamable HTTP servers must validate `Origin`, bind to loopback by default, and authenticate remote
connections. MCP 2026-07-28 removed protocol sessions and the GET stream endpoint; cancellation
occurs by closing the request-scoped response stream. See the
[current Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

Tools should use JSON Schema 2020-12 input/output definitions, return validated structured content
plus a concise text representation for older clients, and set accurate read-only, destructive,
idempotent, and open-world annotations. Bounded pagination and response-size metadata are required
because a single Javadoc index contains more than fifteen thousand members.

## Architecture implications

- Use explicit providers: `JavadocProvider`, `SourceProvider`, and `CatalogClient`; do not make
  tools aware of fetch or filesystem details.
- Store an immutable in-memory search index keyed by version and base URL. Bound remote response
  bytes, request time, redirects, cache size, and concurrent fetches.
- Allow only `https://iceberg.apache.org/javadoc/` by default. Any custom Javadoc origin is operator
  configuration, never a tool parameter.
- Canonical resources should use stable URIs such as
  `iceberg://api/{version}/type/{fully-qualified-name}`. Search, comparison, source lookup, and
  catalog workflows belong in tools.
- Java API list results use a common envelope with `items`, `count`, `has_more`, an opaque
  continuation token, `truncated`, and provenance.
- Mutating REST tools require typed bodies, correct destructive/idempotent hints, internally
  generated idempotency keys, and no automatic retry unless the catalog advertised support.
- REST capability discovery gates tool execution. Unsupported advertised endpoints fail before a
  network mutation with an actionable message.
- The server starts in documentation-only mode. REST tools remain absent when no catalog is
  configured and do not prevent Java documentation startup.

## Material limitations and unresolved items

- Aggregate Javadoc does not encode the Gradle module for each type. Module mapping requires source
  indexing; remote-only results are explicitly `public-unclassified` with no module evidence.
- Javadoc search indexes identify members but do not contain full documentation. Individual HTML
  pages must be fetched and parsed on demand.
- REST implementations may advertise only a subset of the stable specification and may add vendor
  extensions. The server will expose spec-defined operations only; arbitrary request tools are
  excluded because they weaken validation and SSRF controls.
- End-to-end catalog tests need a deterministic mock implementing the relevant Iceberg response
  contracts. An external production catalog is not required for CI and must not be used for mutation
  verification.

## Research trail and stopping rule

Discovery covered the official Iceberg release/API/Javadoc pages, the released and current OpenAPI
documents, upstream build and threat-model files, the current MCP specification, the official
TypeScript SDK documentation, and live npm package metadata. Follow-up compared released versus
current REST operations, counted the published Javadoc indexes, and traced auth, pagination,
idempotency, and stable API module rules into upstream source.

The recorded architecture claims have primary sources. Implementation work resolved the remaining
questions against installed package types and executable tests, including SDK signatures, HTML
parser behavior, endpoint schema generation, and mock catalog contracts.
