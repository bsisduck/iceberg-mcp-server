# Security model

This document extends Iceberg's upstream threat model to the MCP process. The MCP server is a new
audience and execution boundary even when it connects only to operator-trusted sources.

## Assets

- Iceberg catalog bearer tokens, OAuth credentials, and refreshed tokens.
- Vended storage credentials and remote-signing material.
- Catalog metadata and namespace/table/view names subject to server authorization.
- Opaque catalog page tokens returned for explicit pagination.
- Local Iceberg source outside content intentionally exposed by indexed tools.
- Host network access available to the MCP process.
- Integrity of model-visible tool descriptions, schemas, and results.

## Trust boundaries

1. The operator controls startup configuration, allowed origins, source root, Javadoc origin,
   catalog URI, and credentials.
2. MCP clients and model-generated tool arguments are untrusted.
3. Official Javadoc and a configured catalog are external inputs. The operator may trust their
   authority, but their bytes still require size and syntax validation.
4. The REST Catalog owns catalog authorization. MCP annotations and UI confirmation are not
   authorization mechanisms.
5. A configured source checkout is trusted content, but symlinks and paths are not allowed to
   broaden the exposed filesystem boundary.

## Threats and controls

| Threat                                      | Controls                                                                                                                            | Verification                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Arbitrary file read/path traversal          | No path parameters; canonical indexed type IDs; no out-of-root symlink traversal                                                    | Source-provider boundary and symlink tests                        |
| SSRF through model input                    | No URL parameters; origins are startup-only; redirect target validation; exact Javadoc origin/path-prefix boundary                  | Foreign URL and redirect rejection tests                          |
| Catalog URI SSRF                            | URI is operator configuration, never a tool argument; HTTPS outside loopback                                                        | Config validation tests                                           |
| Secret disclosure in results/errors/logs    | Central recursive redaction; never return auth/vended credentials; correlation IDs instead of headers/bodies                        | Recursive redaction, credential-scope, and error mapping tests    |
| Credential reuse across principals/catalogs | One catalog identity and one auth provider per process; no model-selected URI, credential, or token                                 | Configuration exclusivity and auth lifecycle tests                |
| OAuth endpoint confusion                    | Explicit external token URI; HTTPS outside loopback; redirects rejected; bounded JSON Bearer-token response; no deprecated fallback | OAuth media-type, response, timeout, cache, and rejection tests   |
| Host/Origin spoofing                        | SDK host and origin validation; loopback default; exact allowed origins                                                             | HTTP integration tests for Host and Origin                        |
| Unauthenticated remote MCP                  | Non-loopback HTTP refuses startup without auth; constant-time bearer comparison; proxy OAuth documented                             | Startup and HTTP 401 tests                                        |
| Accidental/destructive mutation             | Mutation tools absent by default; explicit startup opt-in; accurate annotations; catalog authorization remains authoritative        | Protocol tool-list assertions in read-only and mutable modes      |
| Duplicate mutation during retry             | No mutation retry unless advertised idempotency exists; UUIDv7 per logical operation; 409 never retried                             | Deterministic retry/idempotency tests                             |
| DoS through input or upstream content       | Strict schema lengths, inbound/outbound body bounds, full-body deadlines, concurrency cap, response budget, bounded pagination      | Boundary, oversized/stalled-body, timeout, and cancellation tests |
| ReDoS/source search abuse                   | Literal search plus exact indexed implementation targets; escaped internal regular expression                                       | Adversarial target and literal-search tests                       |
| Javadoc script execution                    | Exact assignment wrapper plus `JSON.parse`; Cheerio parses HTML without executing scripts                                           | Executable-tail and malformed-index parser tests                  |
| Cache poisoning/version confusion           | Fixed provider origin, explicit version cache partition, provenance in results, bounded release/nightly TTLs                        | Cross-version and cache lifecycle tests                           |
| Prompt/tool injection in docs               | Parsed external prose is returned as documentation data and is never executed as server instructions                                | Non-executing JSON/HTML parser design                             |
| Error detail leakage                        | Expected errors mapped to allowlisted fields; internal stacks remain server-side                                                    | Expected, upstream, and unexpected tool error tests               |

## REST credential policy

- `ICEBERG_CATALOG_TOKEN`, `ICEBERG_OAUTH2_CREDENTIAL`, and inbound MCP auth tokens are secrets.
- `_FILE` variants are preferred for container/orchestrator deployment. Direct and file-based
  secrets have the same 16 KiB maximum; files must be regular and are read once.
- The deprecated Iceberg `/v1/oauth/tokens` operation is not exposed or invoked. An explicit
  external OAuth endpoint is required for client credentials.
- Authorization and OAuth headers/bodies are never copied into results. Catalog properties whose
  normalized names contain token/secret/credential/password/private-key are redacted recursively.
- `loadCredentials` has a special sanitizer that returns prefixes and key names, not credential
  configuration values. The remote-signing endpoint is not callable, so signed headers are never
  emitted.

## Mutation policy

Mutation implementations exist for protocol coverage but are registered only when
`ICEBERG_CATALOG_ALLOW_MUTATIONS=true`. Enabling them does not bypass catalog-side authorization.

- Create/register/update/rename operations are non-destructive but state-changing.
- Drop/unregister operations are destructive.
- Metrics reporting is state-changing but non-destructive and may be idempotent only according to
  the catalog contract.
- Commit operations send the supplied spec-shaped requirements/updates and surface 409 conflicts
  without retry.
- Model-provided idempotency keys are not accepted. The client generates and scopes keys internally
  when the catalog advertises support.

No generic REST request tool is provided.

## HTTP deployment policy

- Default: `127.0.0.1:3000`, local host/origin validation, stdio preferred.
- Non-loopback: TLS is terminated by a trusted reverse proxy or native TLS wrapper; exact allowed
  origins and inbound authentication are mandatory.
- Forwarded-header claims are ignored; validation uses the Host and Origin received by the server.
- No health, configuration, debug, or generic proxy endpoint is mounted; only `/mcp` is served.
- Successful MCP responses inherit the SDK's no-cache policy and add
  `X-Content-Type-Options: nosniff`.
- Logs go to stderr and are suitable for structured collection. Request/response bodies are not
  logged.

## Residual risks

- An operator can deliberately configure a malicious or overly privileged catalog. The server cannot
  replace deployment governance.
- Lexical source mapping may miss unusual generated or nested Java declarations; results label
  confidence and never claim compiler-level resolution.
- Static inbound bearer authentication is suitable for local/machine deployments, not a replacement
  for MCP OAuth in a multi-user public service. Production remote deployments should use an
  OAuth-aware gateway or a future native provider.
- Vendor REST extensions are not callable, even when useful, until explicitly typed and reviewed.
- Javadoc prose, catalog metadata, and upstream error messages are external data visible to the
  model. Clients must not treat that content as trusted instructions.

## Security verification gate

The completion audit covers:

- dependency audit and license inventory;
- secret-pattern scan of tracked source/config files and packaged output;
- config/startup negative tests;
- filesystem and SSRF adversarial tests;
- Host/Origin/auth HTTP integration tests;
- redaction tests for nested catalog errors and credential responses;
- mutation registration/annotation/idempotency tests;
- cancellation, timeout, body-size, upstream-size, and bounded-cache/concurrency behavior.
