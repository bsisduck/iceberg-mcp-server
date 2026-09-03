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

- Recursive redaction now also matches plural and compound credential names (`credentials`,
  `secrets`, `api-key`/`apikey`, `account-key`, `shared-key`, `connection-string`, `passphrase`,
  `passwd`, `signing-key`, `encryption-key`, `decryption-key`, `sse.key`) and camelCase keys such as
  `accessToken`, covering the Iceberg storage-credential properties (`s3.secret-access-key`,
  `s3.session-token`, `client.credential`, `azure.account-key`, `adls.sas-token.<account>`,
  `adls.connection-string.<account>`, `gcs.oauth2.token`). Keys that only describe a credential
  (`token-refresh-enabled`, `token_type`, `client.credentials-provider`,
  `gcs.oauth2.token-expires-at`, `*-endpoint`, `*-uri`, `*-name`) stay visible. A
  `storage-credentials` array in any non-vending response is now redacted as a whole. A new
  `redactText` helper masks `Bearer`/`Basic` values, URL userinfo, and sensitive `key=value` pairs
  inside free text.

- Configured credentials (inbound MCP auth token, catalog bearer token, OAuth credential) are now
  stored in a `Secret` wrapper (`src/shared/secret.ts`) instead of bare strings. `toJSON`,
  `toString`, and the Node inspect hook return `[REDACTED]`, and the material is held in a private
  field, so `JSON.stringify(config)`, `util.inspect(config, { depth: null })`, and a stray
  `console.log` no longer disclose it. `AppConfig.http.authToken`, `AppConfig.catalog.token`, and
  `AppConfig.catalog.oauth2Credential` changed type from `string | undefined` to
  `Secret | undefined`; embedders read them with `value()`.
- stderr diagnostics are now one structured JSON line per event. Error lines carry `ts`, `level`,
  `event`, `correlation_id`, `error_name`, and the real (text-redacted) `message` instead of the
  previous constant `Unexpected internal error`; a redacted `stack` is added only when
  `ICEBERG_MCP_LOG_LEVEL=debug`. The new `ICEBERG_MCP_LOG_LEVEL` variable accepts `error`, `info`
  (default), or `debug` and is threaded from `AppConfig.logLevel` into the reporter the CLI builds.
  `ErrorReporter.report` takes the correlation id as its own argument, and `event` values are stable
  names (`tool.call`, `transport.http.request`, `transport.http.handler`, `transport.http.adapter`,
  `transport.stdio`, `runtime.shutdown`).
- A new `auditLog` helper writes one `catalog.mutation` line (operation, identifier, idempotency
  key, outcome, status, duration, correlation id, and recursively redacted arguments) so an operator
  can reconstruct who changed catalog state. The deprecated MCP `logging` capability is still not
  advertised.
- `ICEBERG_MCP_HOST` is normalized before it is used. A bracketed IPv6 literal such as `[::1]` is
  unwrapped to `::1`, which is what `server.listen` accepts (`[::1]` failed with `ENOTFOUND` after
  configuration had already accepted it), and the value is lower-cased and validated with `net.isIP`
  or a hostname pattern. `::ffff:127.0.0.1` and uncompressed spellings of `::1` are now classified
  as loopback, so configuration, the loopback rules, and the bind all agree. IPv6 bind addresses are
  re-bracketed for `Host` header comparison.
- `ICEBERG_JAVADOC_VERSION`, `ICEBERG_JAVADOC_BASE_URL`, and `ICEBERG_MCP_TRANSPORT` now treat a
  blank value as unset, like every other variable, instead of failing startup. A client `env` map
  that carries an empty entry falls back to the documented default.

### Removed

- The unused direct `hono` dependency. Nothing in `src/` imports it; it remains available only as a
  transitive dependency of `@modelcontextprotocol/node`.
