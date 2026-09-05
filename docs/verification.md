# Completion audit

Initial audit date: 2026-09-01. Latest verification: 2026-09-05.

This report records the implementation, onboarding follow-up, and verification boundary for version
`0.1.0`. It is evidence for the repository state, not a claim that every deployment or third-party
catalog is secure or conforming.

## September 5 follow-up verification

The cache limit regression found after the initial audit is fixed in commit `190b320`. Disk reads
apply the current document limit before allocating the body. Oversized entries are treated as misses
and fetched without conditional validators, so a fresh hit or a `304` cannot bypass a lowered limit.
Regression tests also cover exact byte boundaries, malformed entries, and a smaller upstream
replacement. Commit `109008c` updates the live evaluation verifier to use the server's configuration
loader, including the current limits.

The updated branch passed:

- `npm run check`: formatting, lint, strict types, 343 tests across 18 files, coverage thresholds,
  and production build;
- 93.55% statement, 88.55% branch, 96.35% function, and 93.70% line coverage;
- all 10 live MCP evaluations, all 7 client configuration renderers, and exact reconciliation of the
  32 release and 35 development OpenAPI operations;
- a 202-file package archive with MIT metadata and all 72 source-map references resolved;
- installation of that archive in a temporary project, executable launch, `--version`, `--help`, and
  package root-export loading;
- a refreshed npm dependency audit with zero known vulnerabilities;
- validation of 28 relative documentation links and both GitHub YAML files, with no tracked build
  artifacts or high-confidence credential patterns in the working tree or Git history.

The first live evaluation attempt encountered a network fetch failure. A direct endpoint check and
the subsequent complete evaluation run succeeded. The client-application, dependency-license,
external-link, and full prose-review observations below are dated September 1; the revised audit and
cache documentation were reviewed again with the humanizer rules on September 5.

## Audited baselines

- Apache Iceberg release baseline: `1.11.0`.
- Local Iceberg source baseline: commit `6164440663e3f7b1bae92a1a710ca5233755cd7d`.
- Released REST OpenAPI baseline: tag `apache-iceberg-1.11.0`.
- Development REST OpenAPI baseline: the adjacent Iceberg checkout's `main` document.
- MCP protocol baselines: current `2026-07-28` and the SDK-supported legacy protocol path.
- Runtime baseline: Node.js 20.19 or newer and the Model Context Protocol TypeScript SDK v2.
- Local client CLI baselines: Codex CLI 0.152.0, Claude Code 2.1.252, OpenCode 1.3.17, Gemini CLI
  0.56.0, and VS Code 3.17.8; Cursor was checked against its current primary configuration guide.

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
| Server instructions                     | Complete read-first workflow contract within 512 characters                | Initialization protocol assertion                     |
| Client onboarding                       | Native output for 7 clients/configuration formats                          | Renderer tests and client-template verifier           |
| User stories                            | Every shipped tool/resource/prompt family traced to outcomes or non-goals  | Versioned user-story acceptance matrix                |

The Java plane uses the complete published indexes instead of a curated class list. Source lookup is
separate from Javadoc lookup: exact source targets must be present in the index, while
implementation discovery is bounded lexical evidence and is not represented as compiler-grade
call-graph analysis.

REST capability discovery is authoritative when endpoints are explicitly advertised. An absent or
empty endpoint list uses Iceberg's legacy default set, with the documented legacy view extension.
Opaque pagination cursors are private to this server and bound to their originating query.

## September 1 verification gates

The initial audit ran these repository gates successfully:

- formatting, ESLint, strict TypeScript type checking, coverage-gated tests, and production build
  through `npm run check`;
- 123 passing tests across 13 files;
- 91.94% statement, 86.16% branch, 95.88% function, and 92.15% line coverage;
- all 10 deterministic, multi-step evaluation cases over a real MCP HTTP session;
- all 7 generated client formats verified, including JSON parsing, path preservation, shell-safe
  quoting, and absence of secret-bearing fields;
- the generated Claude Code command connected successfully under an isolated temporary user
  configuration;
- Gemini CLI accepted the equivalent isolated project configuration and correctly suppressed it in
  an untrusted folder; VS Code accepted the definition under an isolated user-data directory;
- Codex and OpenCode syntax/schema checks were non-mutating; no real client configuration was
  changed by any audit;
- exact operation-ID reconciliation against both the 32-operation release OpenAPI document and the
  35-operation current document;
- production tarball creation, installation into a temporary project, root-export loading,
  executable symlink launch, `--version`, and `--help` smoke tests;
- package linting plus resolution of all 60 packed source-map references against included sources;
- full and production-only npm dependency audits with zero known vulnerabilities;
- package metadata inspection confirming there is no `install`, `prepare`, or `postinstall` hook;
- current-file and full Git-history scans for common private-key, cloud-token, Git-host token, Slack
  token, Google API key, JWT, and populated Iceberg secret-variable patterns;
- Markdown relative-link validation, live checks of 24 non-example external links, and Git
  whitespace validation.

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
- complete upstream response-body deadlines and cancellation of discarded bodies, including
  responses rejected from their media type or declared length;
- bounded direct and file-backed secret inputs, redacted diagnostics, and safe error messages;
- escaped implementation-search terms and exact indexed source targets;
- OAuth response media-type validation and rejection of redirected token exchanges;
- a shared release-or-nightly version contract for API tools and workflow prompts;
- `nosniff` and no-cache response headers on the HTTP transport.

## Onboarding and context findings closed during follow-up

- The README previously contained only one generic `mcpServers` example. The CLI now renders seven
  current client-native formats without editing user configuration.
- The original initialization instructions were accurate but too terse for reliable tool selection.
  They now carry the complete read-first workflow and safety boundary within 512 characters.
- Capabilities were mapped by API surface but not by user outcome. The user-story catalog now traces
  every tool/resource/prompt family, precondition, safety behavior, and deliberate non-goal.
- Client installation previously required users to translate paths and schemas manually. The client
  guide, renderer, acceptance checklist, and copy/paste agent prompts make that translation
  reproducible and reviewable.
- Context growth remains bounded because catalog tools are discovery-gated, mutation tools are
  absent by default, instructions are concise, and large result surfaces require filters/cursors.
- Published sources now resolve every JavaScript and declaration source-map reference in the npm
  archive.

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
- Generated client CLI commands use POSIX shell syntax. They were tested on macOS and are intended
  for Linux; Windows and PowerShell remain unverified.

## Public repository audit

- The root README explains scope, setup, client installation, configuration, verification, security
  boundaries, contribution rules, and licensing.
- `LICENSE`, `package.json`, and the root package-lock entry all specify the MIT License.
- Contribution, security-reporting, conduct, and changelog files are present and included in the
  package archive.
- GitHub CI runs the full quality gate, including coverage thresholds, and the client-template
  verifier on Node.js 20.19 and 24. The workflow uses read-only permissions and immutable action
  commit references.
- Dependabot checks npm and GitHub Actions dependencies weekly.
- All 18 Markdown files were reviewed with the humanizer rules on September 1. Commands, code
  blocks, links, identifiers, measurements, and technical claims were preserved.
- The CI YAML was parsed locally and its commands passed on Node.js 22. A hosted CI result is only
  possible after the repository is published.

The repository is hosted at
[bsisduck/iceberg-mcp-server](https://github.com/bsisduck/iceberg-mcp-server) and is private for
initial publication. Package metadata contains the matching repository, README, and issue URLs.
Hosted check results are available through
[GitHub Actions](https://github.com/bsisduck/iceberg-mcp-server/actions).

Before the first push, Gitleaks 8.30.1 scanned the complete history without finding secrets. A
separate review of all 420 historical file versions found no personal filesystem paths, private data
files, or blobs over 1 MB. Email-like matches in tests are dummy URL credentials used to verify
rejection and redaction. Commit authors and committers use the GitHub noreply address; the original
personal email was removed before publication. A recovery bundle stays outside the repository.

The README includes a universal installation prompt that clones the repository, selects the current
MCP client, preserves unrelated settings, and verifies the connection. It works without substituting
local paths; access to the private repository still requires an authorized GitHub account.

No credentials, generated build directory, dependency directory, package tarball, or other
regenerable artifact is committed to Git.
