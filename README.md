# Apache Iceberg MCP Server

A Model Context Protocol server for Apache Iceberg Java API documentation, source lookup, and
optional REST Catalog operations.

The Iceberg [`latest/api`](https://iceberg.apache.org/docs/latest/api/) page documents the Java
libraries; it is not a callable HTTP API. This server therefore exposes two separate planes:

- a read-only plane over official release/nightly Javadocs and an optional local Iceberg source
  checkout;
- an optional, discovery-gated plane over a configured Iceberg REST Catalog.

The Java plane works without credentials. Catalog mutation tools are absent unless the operator both
configures a catalog and explicitly enables mutations.

## What is included

- Indexed Javadoc discovery across the published package, type, and member lists, with exact detail
  lookup and cross-version comparison.
- Local source evidence limited to indexed Java types, bounded literal search, lexical
  implementation discovery, Git provenance, and module stability classification.
- Inventory coverage of all 32 Iceberg 1.11.0 REST operations: 30 typed model-callable mappings and
  two deliberately excluded credential-bearing operations. Three current-main extensions are
  available only when advertised.
- Strict MCP input/output schemas, opaque query-bound cursors, bounded requests and responses,
  structured errors, and secret redaction.
- MCP tools, resource templates, and guided prompts over stdio or stateless Streamable HTTP.
- Compatibility tests for current MCP (`2026-07-28`) and legacy protocol clients.
- Non-mutating setup generation for Codex, Claude Code, OpenCode, Gemini CLI, VS Code, Cursor, and
  other JSON-configured MCP clients.

See [tool and workflow reference](docs/tools.md), [coverage matrix](docs/coverage.md), and
[architecture](docs/architecture.md) for the exact surface. Supported workflows are listed in
[user stories and use cases](docs/user-stories.md).

## Requirements

- Node.js 20.19 or newer (the CLI checks `process.versions.node` against `engines.node` at startup
  and exits with a one-line requirement on an older runtime)
- npm
- macOS or Linux for the generated client CLI commands; Windows has not been verified
- Network access to `https://iceberg.apache.org/javadoc/` for Javadoc tools
- Optional: an Apache Iceberg Git checkout for source tools
- Optional: an Iceberg REST Catalog endpoint for catalog tools

## Quick start

```sh
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js
```

`stdio` is the default transport. The process writes MCP frames only to stdout and diagnostics to
stderr.

When this repository sits beside the upstream `iceberg` checkout, the source plane is detected
automatically. Otherwise set an absolute path:

```sh
ICEBERG_SOURCE_DIR=/absolute/path/to/iceberg node dist/cli.js
```

Without a valid source checkout, Javadoc tools still work and source-only tools return a clear
configuration error.

## Install into an MCP client

Build first, then generate a client-native command or JSON block without changing client settings:

```sh
node dist/cli.js --print-client-config codex --source-dir /absolute/path/to/iceberg
node dist/cli.js --print-client-config claude-code --source-dir /absolute/path/to/iceberg
node dist/cli.js --print-client-config opencode --source-dir /absolute/path/to/iceberg
```

Supported targets are `codex`, `claude-code`, `opencode`, `gemini-cli`, `vscode`, `cursor`, and
`generic-json`. Follow the [client setup guide](docs/client-setup.md) to apply and verify the
result, or give your coding agent one of the reviewed
[copy/paste installation prompts](docs/installation-prompts.md).

## MCP client configuration

For a client that accepts the common `mcpServers` shape, build first, replace both absolute paths,
and merge this entry without overwriting other servers:

```json
{
  "mcpServers": {
    "iceberg": {
      "command": "node",
      "args": ["/absolute/path/to/iceberg-mcp-server/dist/cli.js"],
      "env": {
        "ICEBERG_SOURCE_DIR": "/absolute/path/to/iceberg",
        "ICEBERG_JAVADOC_VERSION": "1.11.0"
      }
    }
  }
}
```

Restart the client after changing its configuration. Use absolute paths because desktop clients do
not necessarily launch the server from this repository.

## Optional REST Catalog

Set a catalog URI and, when required, exactly one outbound authentication mode:

```sh
export ICEBERG_CATALOG_URI=https://catalog.example.com
export ICEBERG_CATALOG_WAREHOUSE=warehouse-name
export ICEBERG_CATALOG_TOKEN_FILE=/run/secrets/iceberg_catalog_token
node dist/cli.js
```

Alternatively configure external OAuth client credentials with `ICEBERG_OAUTH2_URI` and
`ICEBERG_OAUTH2_CREDENTIAL_FILE`. The credential file contains `client_id:client_secret`. The
deprecated catalog-local `/v1/oauth/tokens` route is not selected automatically.

Startup calls `GET /v1/config`, applies defaults, local warehouse configuration, then overrides, and
registers only supported tools. An absent or empty endpoint advertisement follows Iceberg's legacy
default set; `view-endpoints-supported=true` adds Iceberg's legacy view set. Explicitly advertised
endpoint lists are authoritative.

Read tools are registered automatically. To expose state-changing and destructive tools, also set:

```sh
ICEBERG_CATALOG_ALLOW_MUTATIONS=true
```

This opt-in does not replace catalog authorization or client-side confirmation. Do not enable it for
a principal that should be read-only.

## Streamable HTTP

For a local HTTP endpoint:

```sh
ICEBERG_MCP_TRANSPORT=http node dist/cli.js
```

The endpoint is `http://127.0.0.1:3000/mcp`. Only `/mcp` is served. A non-loopback bind is rejected
unless an inbound bearer token and an explicit exact origin allowlist are configured. Put a
TLS-terminating, OAuth-aware gateway in front of multi-user or Internet-facing deployments; the
built-in static bearer mode is intended for machine-to-machine protection.

See [deployment and operations](docs/deployment.md) for remote settings, secret handling, and
troubleshooting.

## Configuration

| Variable                           | Default                                   | Purpose                                      |
| ---------------------------------- | ----------------------------------------- | -------------------------------------------- |
| `ICEBERG_JAVADOC_VERSION`          | `1.11.0`                                  | Default release semver or `nightly`          |
| `ICEBERG_JAVADOC_BASE_URL`         | official Iceberg Javadoc root             | HTTPS operator-controlled root               |
| `ICEBERG_SOURCE_DIR`               | valid sibling `../iceberg`, else disabled | Local Iceberg checkout                       |
| `ICEBERG_CATALOG_URI`              | unset                                     | REST Catalog root; HTTPS outside loopback    |
| `ICEBERG_CATALOG_WAREHOUSE`        | unset                                     | Warehouse sent only during config discovery  |
| `ICEBERG_CATALOG_TOKEN[_FILE]`     | unset                                     | Outbound catalog bearer token                |
| `ICEBERG_OAUTH2_URI`               | unset                                     | External OAuth token endpoint                |
| `ICEBERG_OAUTH2_CREDENTIAL[_FILE]` | unset                                     | OAuth `client_id:client_secret`              |
| `ICEBERG_CATALOG_ALLOW_MUTATIONS`  | `false`                                   | Register catalog mutation tools              |
| `ICEBERG_MCP_TRANSPORT`            | `stdio`                                   | `stdio` or `http`                            |
| `ICEBERG_MCP_HOST`                 | `127.0.0.1`                               | HTTP bind host; `[::1]` normalizes to `::1`  |
| `ICEBERG_MCP_PORT`                 | `3000`                                    | HTTP bind port                               |
| `ICEBERG_MCP_ALLOWED_ORIGINS`      | loopback origins for the port             | Comma-separated exact origins                |
| `ICEBERG_MCP_AUTH_TOKEN[_FILE]`    | unset                                     | Inbound HTTP bearer token                    |
| `ICEBERG_MCP_MAX_REQUEST_BYTES`    | `1048576`                                 | HTTP request limit, 4 KiB to 10 MiB          |
| `ICEBERG_MAX_RESPONSE_CHARS`       | `30000`                                   | Tool/resource output limit, 4,096 to 100,000 |
| `ICEBERG_REQUEST_TIMEOUT_MS`       | `15000`                                   | Upstream timeout, 1,000 to 120,000 ms        |
| `ICEBERG_MCP_LOG_LEVEL`            | `info`                                    | stderr detail: `error`, `info`, or `debug`   |

Every variable treats a blank value as unset and falls back to its default, so an empty entry in a
client `env` map is not a startup error.

`_FILE` is available for the three secret values and is preferred in deployed environments.
Supplying both the direct value and its file form is an error. Secrets are loaded at startup, so
restart the process after rotating a mounted secret.

## Development and verification

```sh
npm run check
npm run verify:evaluations
npm run verify:clients
npm run verify:openapi
npm pack --dry-run
```

`verify:openapi` compares the implementation with the adjacent Iceberg checkout's current OpenAPI
file. Pass a different YAML path to the underlying script when auditing a pinned release. The ten
read-only [evaluations](evaluations/README.md) exercise multi-step Java API questions over a real
MCP HTTP session.

Research claims and primary sources are recorded in the
[claim-to-source ledger](docs/research/claim-source-ledger.md). Security-sensitive behavior and
remaining deployment risks are in the [security model](docs/security.md). Final traceability,
quality-gate results, and residual risks are recorded in the
[completion audit](docs/verification.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local development checks and pull request
requirements. Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).
Participation is covered by the [code of conduct](CODE_OF_CONDUCT.md), and release changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

## License

MIT License. Apache Iceberg is a trademark of The Apache Software Foundation; this independent
server is not an Apache Software Foundation project.
