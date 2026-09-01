# Apache Iceberg MCP Server implementation plan

Status legend: `[ ]` pending, `[~]` in progress, `[x]` verified.

## Scope and assumptions

- Build a standalone, production-quality TypeScript MCP server in this repository.
- Integrate with the Apache Iceberg REST Catalog API documented at the official
  `latest/api` URL and defined by the upstream `iceberg/open-api` specification.
- Target operators and agents that need portable catalog administration and
  metadata workflows across conforming Iceberg REST Catalog implementations.
- Provide local `stdio` and remote, stateless Streamable HTTP transports.
- Prefer comprehensive endpoint coverage plus a small number of composable
  workflow tools; do not embed an Iceberg engine or modify the upstream checkout.
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

- [~] Research and evidence model
  - Inventory every REST Catalog operation, schema, auth mechanism, pagination
    contract, commit precondition, and version-dependent capability.
  - Reconcile the live `latest` documentation with the local upstream checkout.
  - Record claims, contradictions, confidence, and evidence gaps in a source ledger.
- [ ] Architecture and threat model
  - Define tool domains, resources, prompts, transport boundaries, configuration,
    error taxonomy, response envelopes, output limits, and SSRF/credential controls.
  - Produce an endpoint-to-tool coverage matrix and explicit non-goals.
- [ ] Project foundation
  - Configure strict TypeScript, linting, formatting, tests, package exports,
    executable entry point, environment validation, and reproducible builds.
- [ ] REST client and protocol infrastructure
  - Implement URL construction, prefix handling, auth/token exchange, retries,
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
  - Trace every OpenAPI operation to implementation and tests.
  - Run formatting, lint, type checking, unit/integration tests, build, package
    smoke tests, MCP protocol inspection, dependency audit, and secret scan.
  - Re-read the full diff and verify a clean Git worktree.

## Research gap matrix

| Claim family | Required evidence | State | Next action |
| --- | --- | --- | --- |
| Latest API/version | Official release/docs plus local source | Open | Compare live docs, tags, and checkout revision |
| Endpoint inventory | Versioned official OpenAPI document | Open | Parse paths, operations, schemas, and security |
| Authentication | OpenAPI plus REST catalog auth docs/tests | Open | Trace OAuth and credential vending behavior |
| Commit semantics | OpenAPI plus implementation/tests | Open | Inspect requirements, updates, and status codes |
| Pagination | OpenAPI plus implementation/tests | Open | Trace page-token behavior per list endpoint |
| MCP protocol | Current MCP spec and SDK API | Open | Verify transports, structured output, auth, errors |
| Operational security | Official standards and threat models | Open | Derive deployment and client-side controls |

## Verification policy

No phase is complete merely because files exist or a narrow test passes. Each phase
must cite or execute authoritative evidence at the same scope as its claim. The final
audit must show complete endpoint coverage, successful protocol-level behavior, and a
clean reproducible build without relying on generated artifacts checked into Git.
