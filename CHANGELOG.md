# Changelog

## Unreleased

The initial `0.1.0` implementation is ready for repository review but has not been published.

It includes indexed Iceberg Java API and source tools, optional discovery-based REST Catalog tools,
stdio and Streamable HTTP transports, client configuration generation, tests, evaluations, and
operator documentation.

The project is licensed under the MIT License.

### Changed

- The server name, version, and outbound `User-Agent` are read once from `package.json`
  (`src/version.ts`) instead of being repeated as literals in the server factory, catalog client,
  and Javadoc provider. `SERVER_NAME`, `SERVER_VERSION`, and `USER_AGENT` remain exported from the
  package entry point.
- The default Javadoc version and the Iceberg version pattern/schema now live in one shared module
  (`src/shared/iceberg-version.ts`, re-exported as `DEFAULT_JAVADOC_VERSION` from `config.ts`) and
  are used by configuration, the CLI, client setup rendering, the Javadoc provider, tools, and
  prompts. Every entry point enforces the same 100-character bound.
- `--javadoc-version` now counts as a client setup option whenever it is supplied, even with the
  default value, so it is rejected without `--print-client-config` like the other setup options.
- One shared `Semaphore` (`src/shared/semaphore.ts`) replaces the two identical private copies in
  the Javadoc fetcher and the catalog client. It is FIFO, releases on throw, and accepts an abort
  signal: an already-aborted caller is rejected before it queues, and a caller that aborts while
  waiting is removed from the queue.
- One exported `readBounded`/`readBoundedText` helper (`src/shared/fetch.ts`) replaces the three
  bounded body readers in the Javadoc fetcher, catalog client, and OAuth provider. Overflow always
  raises `LimitError` (`<label> exceeds <n> bytes`); an oversized OAuth token response therefore now
  reports `LimitError` instead of an `UpstreamError`, and a catalog body that is not valid UTF-8 is
  a non-retryable `UpstreamError` instead of a retryable generic failure.

### Removed

- The unused direct `hono` dependency. Nothing in `src/` imports it; it remains available only as a
  transitive dependency of `@modelcontextprotocol/node`.
