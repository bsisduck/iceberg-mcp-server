# Copy/paste installation prompts

For a single prompt that clones the repository and detects your client, use
[Install with a coding agent](../README.md#install-with-a-coding-agent) in the README. It needs no
path substitutions and supports documentation-only installation without an Iceberg checkout.

The client-specific prompts below assume an existing local checkout. Replace `[SERVER_DIR]` and
`[ICEBERG_DIR]` with absolute paths before use. They install the documentation/source plane first,
leave catalog credentials unset, and leave mutations disabled. Omit the source-checkout instruction
and `--source-dir` argument when only Javadoc access is needed.

## Codex

```text
Install the local Apache Iceberg MCP server from [SERVER_DIR] into Codex using a local stdio
connection. Treat [ICEBERG_DIR] as a read-only Iceberg source checkout. Verify Node.js >=20.19 and
npm, inspect README.md and docs/client-setup.md, run npm ci and npm run check in [SERVER_DIR], then
run: node dist/cli.js --print-client-config codex --source-dir [ICEBERG_DIR]. Show me the generated
command before applying it. Preserve every unrelated Codex MCP setting. Do not configure a REST
Catalog, copy secrets, enable mutations, weaken approvals, or push anything. After applying the
configuration, run codex mcp list and verify the server exposes 9 documentation/source tools. Report
the exact config location changed, verification output, and the rollback command or edit.
```

## Claude Code

```text
Install the local Apache Iceberg MCP server from [SERVER_DIR] into Claude Code using stdio and user
scope. Treat [ICEBERG_DIR] as read-only. Verify Node.js >=20.19, read README.md and
docs/client-setup.md, run npm ci and npm run check, then run: node dist/cli.js
--print-client-config claude-code --source-dir [ICEBERG_DIR]. Show the generated command before
applying it and preserve unrelated Claude settings. Do not add catalog credentials, enable
mutations, use blanket trust, or push. Verify with claude mcp get iceberg and claude mcp list; require
Connected status and 9 tools. Report the changed scope/file and `claude mcp remove iceberg -s user`
as the rollback.
```

## OpenCode

```text
Install the local Apache Iceberg MCP server from [SERVER_DIR] into this OpenCode project. Verify
Node.js >=20.19, read README.md and docs/client-setup.md, run npm ci and npm run check, then render
the current V2 configuration with: node dist/cli.js --print-client-config opencode --source-dir
[ICEBERG_DIR]. Show the JSON before editing. Merge only mcp.servers.iceberg into opencode.jsonc;
never replace other servers or put the entry directly under mcp. Keep Code Mode and confirmations at
their safe defaults. Do not configure a catalog, secrets, or mutations. Run opencode mcp list and
verify the connection. Report the exact diff and how to remove only the iceberg entry.
```

## Gemini CLI

```text
Install the local Apache Iceberg MCP server from [SERVER_DIR] into Gemini CLI using stdio and user
scope. Verify Node.js >=20.19, read README.md and docs/client-setup.md, run npm ci and npm run check,
then render the command with: node dist/cli.js --print-client-config gemini-cli --source-dir
[ICEBERG_DIR]. Show it before applying it. Do not add --trust, catalog credentials, mutation opt-in,
or unrelated settings. Run gemini mcp list and verify the server connects with 9 tools. Report the
configuration scope and `gemini mcp remove iceberg --scope user` as the rollback.
```

## VS Code / GitHub Copilot

```text
Install the local Apache Iceberg MCP server from [SERVER_DIR] into VS Code for this machine. Verify
Node.js >=20.19, read README.md and docs/client-setup.md, run npm ci and npm run check, then render
the config with: node dist/cli.js --print-client-config vscode --source-dir [ICEBERG_DIR]. Show the
JSON before editing. Merge only servers.iceberg into the appropriate user mcp.json because the
absolute paths are machine-specific; preserve all other servers and inputs. Do not add secrets or
enable mutations. Use MCP: List Servers to start and inspect it, approve only the reviewed command,
and verify 9 tools, 3 prompts, and 3 resource templates. Report the exact file and rollback edit.
```

## Cursor

```text
Install the local Apache Iceberg MCP server from [SERVER_DIR] into Cursor. Verify Node.js >=20.19,
read README.md and docs/client-setup.md, run npm ci and npm run check, then render the config with:
node dist/cli.js --print-client-config cursor --source-dir [ICEBERG_DIR]. Show it before editing.
Merge only mcpServers.iceberg into ~/.cursor/mcp.json for machine-wide use, preserving every other
entry. Do not hardcode secrets, configure a catalog, enable mutations, or weaken tool approvals.
Reconnect the server in Cursor and verify 9 tools. Report the exact diff and rollback edit.
```

## Another MCP client

```text
Install the local Apache Iceberg MCP server from [SERVER_DIR] into the current MCP client using a
local stdio process. Verify the client's current official configuration schema first. Build and test
the server with npm ci and npm run check, then run: node dist/cli.js --print-client-config
generic-json --source-dir [ICEBERG_DIR]. Adapt only the transport wrapper required by the client;
keep command, args, and environment semantics unchanged. Show the proposed config before applying
it, preserve unrelated entries, do not add secrets or mutations, and verify initialization plus the
9-tool documentation-only surface. Report evidence and a precise rollback.
```
