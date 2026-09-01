# Security model

This document extends Iceberg's upstream threat model to the MCP process. The MCP
server is a new audience and execution boundary even when it connects only to
operator-trusted sources.

## Assets

- Iceberg catalog bearer tokens, OAuth credentials, and refreshed tokens.
- Vended storage credentials and remote-signing material.
- Catalog metadata and namespace/table/view names subject to server authorization.
- Local Iceberg source outside content intentionally exposed by indexed tools.
- Host network access available to the MCP process.
- Integrity of model-visible tool descriptions, schemas, and results.

## Trust boundaries

1. The operator controls startup configuration, allowed origins, source root,
   Javadoc origin, catalog URI, and credentials.
2. MCP clients and model-generated tool arguments are untrusted.
3. Official Javadoc and a configured catalog are external inputs. The operator may
   trust their authority, but their bytes still require size and syntax validation.
4. The REST Catalog owns catalog authorization. MCP annotations and UI confirmation
   are not authorization mechanisms.
5. A configured source checkout is trusted content, but symlinks and paths are not
   allowed to broaden the exposed filesystem boundary.

## Threats and controls

| Threat | Controls | Verification |
| --- | --- | --- |
| Arbitrary file read/path traversal | No path parameters; canonical indexed type IDs; no out-of-root symlink traversal | Unit tests with `..`, absolute paths, encoded separators, and symlinks |
| SSRF through model input | No URL parameters; origins are startup-only; redirect target validation; Javadoc path allowlist | Tests for private/foreign redirect rejection and encoded path tricks |
| Catalog URI SSRF | URI is operator configuration, never a tool argument; HTTPS outside loopback | Config validation tests |
| Secret disclosure in results/errors/logs | Central recursive redaction; never return auth/vended credentials; correlation IDs instead of headers/bodies | Fixture tests with secrets at every nesting level and error path |
| Credential reuse across principals/catalogs | One catalog identity per process; token cache keyed by issuer/audience/credential identity; no model-selected token | Auth cache isolation tests |
| OAuth endpoint confusion | Explicit token URI; HTTPS; no automatic deprecated catalog token fallback; issuer/audience checks when metadata exists | Mock issuer/audience mismatch tests |
| DNS rebinding/host spoofing | SDK host and origin validation; loopback default; exact allowed origins | HTTP integration tests for Host and Origin |
| Unauthenticated remote MCP | Non-loopback HTTP refuses startup without auth; constant-time bearer comparison; proxy OAuth documented | Startup and HTTP 401 tests |
| Accidental/destructive mutation | Mutation tools absent by default; explicit startup opt-in; accurate annotations; catalog authorization remains authoritative | Tool-list snapshots in both modes; mock mutation assertions |
| Duplicate mutation during retry | No mutation retry unless advertised idempotency exists; UUIDv7 per logical operation; 409 never retried | Deterministic retry/idempotency tests |
| DoS through input or upstream content | Strict schema lengths, request-body bound, fetch timeout/byte limit, concurrency cap, response budget, record-aware pagination | Boundary, slow-server, oversized-body, and cancellation tests |
| ReDoS/source search abuse | Literal search only in public tool; no model-provided regular expressions | Schema and adversarial query tests |
| Javadoc script execution | Exact assignment wrapper plus `JSON.parse`; Cheerio parses HTML without executing scripts | Malicious index/HTML fixtures |
| Cache poisoning/version confusion | Cache key includes normalized origin and explicit version; provenance in every result; immutable release cache | Cross-version isolation tests |
| Prompt/tool injection in docs | External prose is returned as quoted documentation data; never interpreted as server instructions | Fixtures containing instruction-like text |
| Error detail leakage | Expected errors mapped to allowlisted fields; internal stacks remain server-side | Snapshot tests for all error classes |

## REST credential policy

- `ICEBERG_CATALOG_TOKEN`, `ICEBERG_OAUTH2_CREDENTIAL`, and inbound MCP auth
  tokens are secrets.
- `_FILE` variants are preferred for container/orchestrator deployment. Secret files
  must be regular files and are read once with a maximum byte count.
- The deprecated Iceberg `/v1/oauth/tokens` operation is internal-only and disabled
  by default. An explicit external OAuth endpoint is required for client credentials.
- Authorization, cookies, proxy authorization, token responses, and properties
  whose normalized names contain token/secret/credential/password/private-key are
  redacted recursively.
- `loadCredentials` and remote-signing responses need special output schemas that
  return availability/scope metadata but not credential configuration or signed
  authorization headers.

## Mutation policy

Mutation implementations exist for protocol coverage but are registered only when
`ICEBERG_CATALOG_ALLOW_MUTATIONS=true`. Enabling them does not bypass catalog-side
authorization.

- Create/register/update/rename operations are non-destructive but state-changing.
- Drop/unregister operations are destructive.
- Metrics reporting is state-changing but non-destructive and may be idempotent only
  according to the catalog contract.
- Commit operations preserve requirements and conflicts exactly.
- Model-provided idempotency keys are not accepted. The client generates and scopes
  keys internally when the catalog advertises support.

No generic REST request tool is provided.

## HTTP deployment policy

- Default: `127.0.0.1:3000`, local host/origin validation, stdio preferred.
- Non-loopback: TLS is terminated by a trusted reverse proxy or native TLS wrapper;
  exact allowed origins and inbound authentication are mandatory.
- The server trusts forwarded headers only when an explicit proxy trust policy is
  configured. Otherwise it ignores them.
- Health endpoints reveal only readiness/version, never catalog configuration.
- Logs go to stderr and are suitable for structured collection. Request/response
  bodies are not logged.

## Residual risks

- An operator can deliberately configure a malicious or overly privileged catalog.
  The server cannot replace deployment governance.
- Lexical source mapping may miss unusual generated or nested Java declarations;
  results label confidence and never claim compiler-level resolution.
- Static inbound bearer authentication is suitable for local/machine deployments,
  not a replacement for MCP OAuth in a multi-user public service. Production remote
  deployments should use an OAuth-aware gateway or a future native provider.
- Vendor REST extensions are not callable, even when useful, until explicitly typed
  and reviewed.

## Security verification gate

Completion requires:

- dependency audit and license inventory;
- secret-pattern scan of tracked files and packaged output;
- config/startup negative tests;
- filesystem and SSRF adversarial tests;
- Host/Origin/auth HTTP integration tests;
- redaction tests for nested catalog errors and credential responses;
- mutation registration/annotation/idempotency tests;
- cancellation, timeout, body-size, upstream-size, and concurrency-limit tests.
