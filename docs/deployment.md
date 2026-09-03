# Deployment and operations

For local client installation before deployment, use the non-mutating generator and acceptance
checklist in [client-setup.md](client-setup.md).

## Stdio deployment

Stdio is the preferred local transport. Build the package and configure the MCP client to launch
`node` with the absolute path to `dist/cli.js`. Put non-secret configuration in the client's `env`
map and reference mounted secret files with `_FILE` variables.

The server reserves stdout for MCP. Collect stderr for startup and structured error diagnostics. The
process handles `SIGINT` and `SIGTERM`, closes its transport, clears provider caches and cached
credentials, and then exits naturally.

## Logging

Diagnostics are written to stderr as one JSON object per line; the MCP `logging` capability is
deprecated in the 2026-07-28 specification and is not advertised. `ICEBERG_MCP_LOG_LEVEL` selects
`error`, `info` (default), or `debug`.

| Line               | Emitted at      | Fields                                                                                                                             |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| unexpected error   | every level     | `ts`, `level`, `event`, `correlation_id`, `error_name`, `message`, and `stack` only at `debug`                                     |
| `catalog.mutation` | `info`, `debug` | `ts`, `level`, `event`, `operation`, `identifier`, `idempotency_key`, `outcome`, `status`, `duration_ms`, `correlation_id`, `args` |

`event` names the source (`tool.call`, `transport.http.request`, `transport.http.handler`,
`transport.http.adapter`, `transport.stdio`, `runtime.shutdown`). The `correlation_id` on an error
line is the same identifier the client receives in the tool error body, so a user report can be
matched to one server-side line without returning any internal detail to the model.

Messages and stacks pass through the text redactor (`Bearer`/`Basic` values, URL userinfo, and
sensitive `key=value` pairs), and `args` passes through the recursive key redactor, so credentials
do not reach the log. Stacks are withheld below `debug` because they name internal paths; raise the
level deliberately and prefer a short window.

## Local Streamable HTTP

```sh
ICEBERG_MCP_TRANSPORT=http \
ICEBERG_MCP_HOST=127.0.0.1 \
ICEBERG_MCP_PORT=3000 \
node dist/cli.js
```

Connect the MCP client to `http://127.0.0.1:3000/mcp`. The HTTP implementation is stateless and
creates a fresh MCP server per request while sharing bounded providers. It serves current and legacy
MCP protocol eras. There is no health, configuration, debug, or generic proxy route.

An inbound token is optional on loopback. Set `ICEBERG_MCP_AUTH_TOKEN_FILE` when other local users
or processes should not be able to call the endpoint.

## Remote HTTP boundary

The process does not implement TLS. A non-loopback bind is permitted only when both of these are
set:

```sh
ICEBERG_MCP_AUTH_TOKEN_FILE=/run/secrets/iceberg_mcp_token
ICEBERG_MCP_ALLOWED_ORIGINS=https://agent.example.com
```

The reverse proxy or service mesh should:

- terminate TLS and preserve the real `Host` header;
- authenticate users with an appropriate OAuth/OIDC policy when more than one principal is in scope;
- supply or require the server's static bearer credential only on the protected upstream hop;
- restrict network access to `/mcp` and apply connection/rate limits;
- preserve MCP protocol headers and streaming responses;
- avoid logging authorization headers or MCP bodies;
- send an exact browser `Origin` allowed by `ICEBERG_MCP_ALLOWED_ORIGINS`.

The server ignores forwarded-header claims and validates the received Host and Origin. The built-in
static bearer token represents one process-level principal; it does not provide per-user catalog
credential isolation.

## Outbound catalog authentication

Choose at most one mode:

1. Static bearer: `ICEBERG_CATALOG_TOKEN_FILE`.
2. OAuth client credentials: `ICEBERG_OAUTH2_URI` plus `ICEBERG_OAUTH2_CREDENTIAL_FILE` containing
   `client_id:client_secret`.
3. No credential, for a catalog that intentionally permits it.

OAuth uses `grant_type=client_credentials` and `scope=catalog`, requires a JSON Bearer token
response, caches it until one minute before expiry, and caps the token response. The external URI
must use HTTPS outside loopback. Redirects are rejected.

The catalog URI and OAuth URI are startup-only operator inputs; no model-callable tool accepts a
URL. Catalog initialization fails closed if config discovery, authentication, content type, size, or
schema validation fails.

## Capability discovery

On startup, the server requests `GET <catalog-root>/v1/config`, adding `warehouse` when configured.
Merge precedence matches Iceberg: server defaults, local warehouse, then server overrides.

- A non-empty `endpoints` array is the exact capability set.
- A missing or empty array selects Iceberg's frozen legacy default endpoints.
- With legacy fallback, effective `view-endpoints-supported=true` adds the six frozen legacy view
  endpoints.
- The three current-main extensions never enter a fallback set; they require explicit advertisement.
- Presence of `idempotency-key-lifetime` enables generated UUIDv7 keys and eligible mutation
  retries.

Discovery is performed once. Restart after changing catalog capabilities, credentials, or mounted
secret files.

## Least privilege

Keep `ICEBERG_CATALOG_ALLOW_MUTATIONS=false` unless a specific workflow needs mutations. This
removes mutation tools from MCP discovery, but the catalog identity should still be limited by
catalog-side authorization. For read-only deployments, use a read-only catalog principal as well.

Credential vending results expose prefixes and configuration key names only. Credential values and
remote-signing results are not returned to the model. See [security.md](security.md) for the threat
model and residual risks.

## Capacity and limits

- HTTP requests are rejected before MCP dispatch above `ICEBERG_MCP_MAX_REQUEST_BYTES`.
- Outbound REST Catalog JSON bodies are capped at 1 MiB for both stdio and HTTP callers.
- Javadoc and catalog fetches have fixed byte bounds, deadlines, and concurrency caps.
- Final tool/resource JSON is bounded by `ICEBERG_MAX_RESPONSE_CHARS`.
- Javadoc release indexes cache for 24 hours; nightly indexes cache for five minutes. Type pages use
  bounded LRU caches with the same version TTL.
- Catalog operations have eight-request process concurrency. Javadoc fetching has four-request
  process concurrency.

If the upstream does not paginate a large catalog response, the server rejects the oversized result
instead of truncating valid JSON. Narrow the request or reduce the upstream page size.

## Troubleshooting

| Symptom                                   | Likely cause and action                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Exits with `requires Node.js`             | The runtime is older than the published `engines.node` range; upgrade Node or point the client at a newer runtime.           |
| Source tool returns a configuration error | Set `ICEBERG_SOURCE_DIR` to a readable Iceberg checkout containing `api/src/main/java`.                                      |
| Server exits while configuring a catalog  | Verify `/v1/config`, TLS trust, outbound auth, response content type, and warehouse.                                         |
| Expected catalog tool is missing          | Inspect `iceberg_catalog_get_config`; the endpoint must be advertised/defaulted and mutations may need opt-in.               |
| HTTP startup rejects a non-loopback host  | Configure both an inbound auth token and an explicit exact origin list.                                                      |
| HTTP returns 401                          | Send the configured inbound bearer token; it is separate from the outbound catalog token.                                    |
| HTTP returns 403 or Host validation fails | Use the configured public origin/host and preserve Host through the proxy. Wildcard origins are not supported.               |
| `LimitError`                              | Retry with a smaller page, member limit, or source window.                                                                   |
| Cursor mismatch                           | Reuse the cursor with exactly the same query inputs, or omit it to restart pagination.                                       |
| Older Javadoc fails to load               | Confirm that the published version contains the three standard search index files and is under the configured root.          |
| OAuth repeatedly reloads                  | Check `expires_in`; tokens with no value default to one hour, while tokens inside the one-minute refresh window are renewed. |

For a deployment smoke test, first run `npm run check`, then start without a catalog and inspect MCP
`tools/list`, `resources/templates/list`, and `prompts/list`. Add the catalog only after the
documentation plane is healthy.
