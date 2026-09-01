# MCP client setup

This guide installs the local stdio server into common MCP clients. The repository is not published
to npm, so every configuration uses the absolute path to the locally built `dist/cli.js`. Local
stdio is the recommended default: it avoids opening a listener and lets each client own the server
process lifecycle.

The commands and schemas were checked on 2026-09-01 against current primary documentation and the
locally installed Codex CLI, Claude Code, OpenCode, Gemini CLI, and VS Code command parsers.
Generated CLI commands use POSIX shell quoting and have been tested on macOS; the same commands are
intended for Linux. Windows and PowerShell have not been verified. JSON renderers remain available
for clients whose configuration can be applied directly.

## Build once

Node.js 20.19 or newer and npm are required.

```sh
cd /absolute/path/to/iceberg-mcp-server
npm ci
npm run check
```

The Java documentation plane needs only network access to the official Javadocs. Pass an absolute
Iceberg checkout path to enable source evidence:

```sh
node dist/cli.js --print-client-config codex \
  --source-dir /absolute/path/to/iceberg
```

`--print-client-config` never changes client settings. It renders a command or JSON document for one
of these targets:

```text
codex, claude-code, opencode, gemini-cli, vscode, cursor, generic-json
```

Use `--javadoc-version nightly` or a release semver to change the default. Use `--server-path` only
when the generated configuration should launch a different built entry point.

## Codex CLI, IDE extension, and ChatGPT desktop

Generate and run the returned command:

```sh
node dist/cli.js --print-client-config codex \
  --source-dir /absolute/path/to/iceberg
codex mcp list
```

Open `/mcp` in the Codex terminal UI to inspect the active server. Codex stores MCP settings in
`~/.codex/config.toml`; a trusted project can instead use `.codex/config.toml`. The CLI, IDE
extension, and ChatGPT desktop app share the configuration on the same Codex host. For catalog
mutations, retain client approval for writes rather than setting blanket approval.

See the official [Codex MCP guide](https://developers.openai.com/codex/mcp/) for configuration
scope, tool allowlists, approval modes, timeouts, and remote HTTP authentication.

## Claude Code

The generated command uses user scope. Replace `--scope user` with `--scope project` when a reviewed
`.mcp.json` entry should be shared by a trusted team repository.

```sh
node dist/cli.js --print-client-config claude-code \
  --source-dir /absolute/path/to/iceberg
claude mcp get iceberg
claude mcp list
```

Within Claude Code, `/mcp` shows server status and prompts appear as MCP slash commands. The command
uses `--` so Node and server arguments cannot be parsed as Claude options. Project-scoped servers
require workspace trust and explicit approval.

See Anthropic's [Claude Code MCP reference](https://code.claude.com/docs/en/mcp) for scopes,
approval, resources, prompts, tool search, and troubleshooting.

## OpenCode

Render the V2-native `mcp.servers` structure and merge the `iceberg` entry into `opencode.jsonc`:

```sh
node dist/cli.js --print-client-config opencode \
  --source-dir /absolute/path/to/iceberg
opencode mcp list
```

Do not place the entry directly below `mcp`; current OpenCode uses `mcp.servers`. Leave Code Mode at
its default for context efficiency, or disable it for this server only if direct MCP tool exposure
is required. OpenCode automatically connects enabled local servers.

See the official [OpenCode MCP server guide](https://opencode.ai/v2/docs/mcp-servers) for local and
remote shapes, environment interpolation, Code Mode, permissions, and timeouts.

## Gemini CLI

Generate and run the returned command, then verify the connection:

```sh
node dist/cli.js --print-client-config gemini-cli \
  --source-dir /absolute/path/to/iceberg
gemini mcp list
```

The generator uses user scope and does not pass `--trust`, so the client retains confirmation for
tool calls. Change the command to `--scope project` when a project-owned `.gemini/settings.json` is
preferred.

See the official [Gemini CLI MCP guide](https://geminicli.com/docs/tools/mcp-server/) for scopes,
tool filtering, trust, HTTP transport, and diagnostics.

## VS Code and GitHub Copilot

Save or merge the generated `servers.iceberg` entry into `.vscode/mcp.json` or the user-profile MCP
configuration:

```sh
node dist/cli.js --print-client-config vscode \
  --source-dir /absolute/path/to/iceberg
```

Run `MCP: List Servers`, start `iceberg`, approve the reviewed configuration, and use `Show Output`
for diagnostics. A workspace file containing machine-specific absolute paths should not be committed
for a team; use a user profile or portable variables instead.

See the official
[VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
for stdio fields, input variables, sandboxing, trust, and management commands.

## Cursor

Merge the generated `mcpServers.iceberg` entry into `.cursor/mcp.json` for a project or
`~/.cursor/mcp.json` for a user:

```sh
node dist/cli.js --print-client-config cursor \
  --source-dir /absolute/path/to/iceberg
```

Review and enable the server under Cursor's MCP settings. Use `${env:NAME}` interpolation for
secrets if catalog settings are added later; never commit literal credentials.

See the official [Cursor MCP guide](https://prod.cursor.com/docs/mcp) for configuration locations,
stdio fields, interpolation, and remote servers.

## Other `mcpServers` clients

For a client that accepts the common `mcpServers` object:

```sh
node dist/cli.js --print-client-config generic-json \
  --source-dir /absolute/path/to/iceberg
```

Merge only the inner `iceberg` entry if the client already has other servers. Confirm the client's
current configuration location and whether it requires an explicit stdio `type` before saving.

## Add a REST Catalog safely

First verify documentation/source operation without catalog access. Then add only operator-owned
catalog settings to the client's server environment:

```text
ICEBERG_CATALOG_URI=https://catalog.example.com
ICEBERG_CATALOG_WAREHOUSE=warehouse-name
ICEBERG_CATALOG_TOKEN_FILE=/absolute/path/to/a/mounted/secret
```

Use `ICEBERG_OAUTH2_URI` plus `ICEBERG_OAUTH2_CREDENTIAL_FILE` instead of a bearer token when the
catalog uses external OAuth client credentials. Do not paste secret values into checked-in client
configuration. Leave `ICEBERG_CATALOG_ALLOW_MUTATIONS` unset until read-only discovery and catalog
authorization have been verified. Enabling it only registers advertised mutation tools; it does not
grant catalog permission or replace client/user confirmation.

For a remote Streamable HTTP deployment, follow [deployment.md](deployment.md). The built-in static
inbound bearer mode is not an interactive OAuth provider; use a TLS-terminating, OAuth-aware gateway
for multi-user service.

## Acceptance checklist

1. `node dist/cli.js --version` prints `0.1.0` without starting the server.
2. The client reports `iceberg` connected and shows exactly 9 tools without a catalog.
3. The client discovers 3 prompts and 3 resource templates where it exposes those MCP features.
4. `iceberg_api_list_versions` succeeds without a source checkout or catalog.
5. `iceberg_source_get_type` succeeds for an indexed type when `ICEBERG_SOURCE_DIR` is configured.
6. Catalog tools remain absent without `ICEBERG_CATALOG_URI`.
7. With a catalog, `iceberg_catalog_get_config` is called before other catalog workflows and only
   advertised tools appear.
8. Mutation tools remain absent until the explicit operator opt-in is set.

If a client cached an older tool list, restart/reconnect the server or use that client's MCP cache
reset command. Server diagnostics go to stderr; stdout must remain reserved for stdio protocol
frames.
