# Completion audit

Audit date: 2026-09-01

This report records the final implementation and verification boundary for version `0.1.0`. It is
evidence for the repository state, not a claim that every deployment or third-party catalog is
secure or conforming.

## Audited baselines

- Apache Iceberg release baseline: `1.11.0`.
- Local Iceberg source baseline: commit `6164440663e3f7b1bae92a1a710ca5233755cd7d`.
- Released REST OpenAPI baseline: tag `apache-iceberg-1.11.0`.
- Development REST OpenAPI baseline: the adjacent Iceberg checkout's `main` document.
- MCP protocol baselines: current `2026-07-28` and the SDK-supported legacy protocol path.
- Runtime baseline: Node.js 20.19 or newer and the Model Context Protocol TypeScript SDK v2.

The upstream Iceberg checkout was used only as evidence and remained unmodified.

## Traceability result

| Promised surface                        | Audited result                                                             | Verification evidence                                 |
| --------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Java API discovery                      | 98 packages, 1,761 types, and 15,306 members in the 1.11.0 Javadoc indexes | Parser/provider tests plus real-index evaluation runs |
| Java MCP tools                          | All 9 tools registered and invoked through MCP                             | Protocol and integration tests                        |
| Java resources and prompts              | Version, package, type, and workflow entries registered                    | Protocol inspection tests                             |
| Released REST operations                | All 32 operation IDs classified                                            | OpenAPI coverage script and coverage matrix           |
| Model-callable released REST operations | 30 typed mappings                                                          | Registration, schema, client, and mock-catalog tests  |
| Credential-bearing REST operations      | `getToken` and `signRequest` inventoried but deliberately not exposed      | Coverage assertions and security review               |
| Current-main REST additions             | `listFunctions`, `loadFunction`, and `unregisterTable` gated on discovery  | Current OpenAPI comparison and registration tests     |
| Mutation boundary                       | Mutation tools absent unless both configured and advertised                | Registration and protocol tests                       |
| MCP transports                          | stdio and stateless Streamable HTTP                                        | Transport and installed-CLI smoke tests               |
| MCP compatibility                       | Current and legacy protocol negotiation                                    | Protocol contract tests                               |

The Java plane uses the complete published indexes instead of a curated class list. Source lookup is
separate from Javadoc lookup: exact source targets must be present in the index, while
implementation discovery is bounded lexical evidence and is not represented as compiler-grade
call-graph analysis.

REST capability discovery is authoritative when endpoints are explicitly advertised. An absent or
empty endpoint list uses Iceberg's legacy default set, with the documented legacy view extension.
Opaque pagination cursors are private to this server and bound to their originating query.

## Verification gates

The final audit ran these repository gates successfully:

- formatting, ESLint, strict TypeScript type checking, tests, and production build through
  `npm run check`;
- 116 passing tests across 12 files;
- 91.81% statement, 85.99% branch, 95.69% function, and 92.04% line coverage;
- all 10 deterministic, multi-step evaluation cases over a real MCP HTTP session;
- exact operation-ID reconciliation against both the 32-operation release OpenAPI document and the
  35-operation current document;
- production tarball creation, installation into a temporary project, executable symlink launch,
  `--version`, and `--help` smoke tests;
- full and production-only npm dependency audits with zero known vulnerabilities;
- package metadata inspection confirming there is no install-time `prepare` or `postinstall` hook;
- tracked-file and packed-artifact scans for common private-key, cloud-token, Git-host token, Slack
  token, Google API key, JWT, and populated Iceberg secret-variable patterns;
- Markdown relative-link validation and Git whitespace validation.

The dependency license inventory contained 185 records with no missing license declaration:
Apache-2.0 (16), BSD-2-Clause (16), BSD-3-Clause (5), BlueOak-1.0.0 (1), ISC (9), MIT (136), and
MPL-2.0 (2). The transitive `whatwg-encoding` package emits an upstream deprecation warning through
Cheerio's current dependency tree; the audit reports no vulnerability for it. TypeScript remains on
the newest release accepted by `typescript-eslint`'s current peer range rather than forcing an
unsupported major version.

## Security findings closed during audit

The completion audit added or verified controls for:

- current and legacy MCP HTTP response-envelope behavior;
- complete serialized result limits on both successful and error responses;
- exact endpoint discovery, including the legacy empty-advertisement case;
- older official Javadoc indexes that contain blank or partial fields;
- installed npm executable symlinks;
- source-file revalidation at read time to narrow time-of-check/time-of-use races;
- query-bound source evidence pagination and bounded cross-version Javadoc caches;
- complete upstream response-body deadlines and cancellation of discarded retry bodies;
- bounded direct and file-backed secret inputs, redacted diagnostics, and safe error messages;
- escaped implementation-search terms and exact indexed source targets;
- OAuth response media-type validation and rejection of redirected token exchanges;
- `nosniff` and no-cache response headers on the HTTP transport.

## Residual and deployment-specific risk

- The server does not terminate TLS or implement interactive inbound OAuth. Put an OAuth-aware,
  TLS-terminating gateway in front of non-loopback or multi-user deployments. The built-in bearer
  check protects one statically configured machine principal per process.
- Iceberg remote signing and data-access credential delegation are intentionally excluded from the
  model-callable surface. They require a separate credential-isolation design.
- Catalog conformance was tested against a deterministic mock. Operators must still validate their
  vendor's discovery document, authorization, conflict behavior, and extension semantics before
  enabling mutations.
- Source implementation search is lexical, bounded, and advisory. Use a Java compiler or dedicated
  static-analysis system when semantic completeness matters.
- Upstream Javadoc prose and catalog responses are untrusted external data. Output bounds and
  structured envelopes reduce exposure but do not make external content authoritative instructions.
- This implementation covers the versioned Apache operations described above, not undocumented
  vendor-specific endpoints or authentication extensions.

No credentials, generated build directory, dependency directory, package tarball, or other
regenerable artifact is committed to Git.
