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
