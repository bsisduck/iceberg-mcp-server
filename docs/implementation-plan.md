# Apache Iceberg MCP Server implementation plan

Status legend: `[ ]` pending, `[~]` in progress, `[x]` verified.

## Scope and assumptions

- Build a standalone, production-quality TypeScript MCP server in this repository.
- Treat the supplied `latest/api` URL correctly as the Apache Iceberg Java API
  guide and generated Javadoc, not as a callable HTTP service.
- Structure and expose Java API, package, type, member, source, example, and
  compatibility knowledge from the official Javadocs and upstream checkout.
- Also support portable catalog administration through Iceberg's separately
  specified REST Catalog API when a conforming catalog endpoint is configured;
  keep documentation/source tools fully useful without catalog credentials.
- Target Java developers, platform engineers, and agents that need accurate API
  guidance, implementation evidence, or catalog metadata workflows.
- Provide local `stdio` and remote, stateless Streamable HTTP transports.
- Prefer comprehensive public Java API discovery and REST endpoint coverage plus
  a small number of composable workflow tools; do not embed a query engine or
  modify the upstream checkout.
- Treat credentials, OAuth tokens, signing material, and warehouse configuration
  as runtime configuration; never persist or return secrets.
- Use repository Markdown for the research and architecture deliverables so the
  evidence remains versioned with the implementation.

## Evidence and source classes

1. Apache Iceberg official documentation and versioned OpenAPI source.
2. Model Context Protocol specification and official TypeScript SDK documentation.
3. OAuth, HTTP, OpenAPI, and relevant security standards from their publishers.
4. Upstream Iceberg implementation and tests for behavior not explicit in the spec.
5. Secondary sources only to discover issues or corroborate operational practice.

## Execution plan

- [x] Research and evidence model
  - Inventory published Java modules, packages, public types/members, Javadoc
    indexes, source mappings, examples, and version-dependent API guarantees.
  - Inventory every REST Catalog operation, schema, auth mechanism, pagination
    contract, commit precondition, and version-dependent capability separately.
  - Reconcile the live `latest` documentation with the local upstream checkout.
  - Record claims, contradictions, confidence, and evidence gaps in a source ledger.
- [~] Architecture and threat model
  - Define tool domains, resources, prompts, transport boundaries, configuration,
    error taxonomy, response envelopes, output limits, and path/SSRF controls.
  - Produce Java-surface and REST-endpoint coverage matrices and explicit non-goals.
- [ ] Project foundation
  - Configure strict TypeScript, linting, formatting, tests, package exports,
    executable entry point, environment validation, and reproducible builds.
- [ ] Providers and protocol infrastructure
  - Implement safe local-source access, remote Javadoc retrieval and caching,
    HTML/index parsing, search, version identity, and source-link resolution.
  - Implement REST URL construction, prefix handling, auth/token exchange, retries,
    timeouts, cancellation, pagination, structured errors, and response validation.
- [ ] MCP capabilities
  - Implement complete read and mutation tool families with strict Zod schemas,
    structured content, annotations, concise Markdown/JSON views, and output bounds.
  - Add appropriate MCP resources and prompts without duplicating tool semantics.
- [ ] Tests and evaluations
  - Add unit, contract, transport, error, security, and integration tests against a
    deterministic mock REST Catalog.
  - Create and independently solve ten stable, multi-step, read-only evaluations.
- [ ] Documentation and packaging
  - Document setup, authentication, tools, examples, deployment, security,
    compatibility, troubleshooting, and client configuration.
- [ ] Completion audit
  - Trace each promised Java API surface and every OpenAPI operation to
    implementation and tests.
  - Run formatting, lint, type checking, unit/integration tests, build, package
    smoke tests, MCP protocol inspection, dependency audit, and secret scan.
  - Re-read the full diff and verify a clean Git worktree.

## Research gap matrix

| Claim family | Required evidence | State | Next action |
| --- | --- | --- | --- |
| Latest API/version | Official release/docs plus local source | Supported | 1.11.0 release and newer local main are distinct providers |
| Java API surface | Official Javadoc indexes plus local source | Supported | 98 packages, 1,761 types, and 15,306 members in 1.11.0 |
| REST endpoint inventory | Versioned official OpenAPI document | Supported | 32 release operations; 35 on current main |
| Authentication | OpenAPI plus REST catalog auth docs/tests | Supported | Internal Bearer/OAuth; bundled token route deprecated |
| Commit semantics | OpenAPI plus implementation/tests | Supported | Typed requirements/updates and conflict-preserving errors |
| Pagination | OpenAPI plus implementation/tests | Supported | Empty-token start; missing/null next token terminates |
| MCP protocol | Current MCP spec and SDK API | Supported | SDK v2 and 2026-07-28 serving entries selected |
| Operational security | Official standards and threat models | Supported | Path, origin, SSRF, credential, and output controls derived |

## Verification policy

No phase is complete merely because files exist or a narrow test passes. Each phase
must cite or execute authoritative evidence at the same scope as its claim. The final
audit must show complete endpoint coverage, successful protocol-level behavior, and a
clean reproducible build without relying on generated artifacts checked into Git.
