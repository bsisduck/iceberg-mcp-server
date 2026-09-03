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

- A paginated catalog result no longer carries two pagination fields: the raw `next-page-token` key
  is removed from `data` once it has been encoded into the opaque, query-scoped `next_cursor` (F12).

- Every non-read catalog call now writes the `catalog.mutation` audit line that `auditLog` already
  defined but nothing emitted (F20): operation id, identifier (from the path inputs, or from the
  tool arguments for renames and transaction commits — a commit names every table it changes,
  `;`-separated), idempotency key, upstream status, outcome — failures included — duration,
  correlation id, and the redacted tool arguments. `ICEBERG_MCP_LOG_LEVEL=error` suppresses it.
  `CatalogClient.call` accepts the tool arguments as `{ args }`, `CatalogClient.create` accepts
  `logLevel`, and the correlation id is now the `x-request-id` sent upstream on every attempt of the
  call instead of a fresh id per attempt. The audited `status` is the last status the catalog itself
  returned and is `null` when it never answered, so a transport failure or timeout is no longer
  recorded as an upstream 502 or 504 even though the caller still receives one.

- The OAuth refresh margin is now `min(60 s, expires_in / 2)`, so a token with a lifetime of 60 s or
  less is reused instead of being treated as stale on issue and re-fetched on every request (F23).
  `expires_in` must be an integer of at least 1; a fractional, zero, or negative value is rejected
  as an invalid token response. The shared single-flight refresh runs under its own timeout-only
  `AbortController`, so a caller that cancels no longer fails every other waiter — cancelling
  callers now only stop their own wait, an already-aborted caller is rejected before any request
  starts, and a failed refresh clears the in-flight state so the next caller retries (F23).

- A catalog `HEAD` now reports existence for any 2xx status instead of only 204, so a catalog that
  answers `namespaceExists`/`tableExists`/`viewExists` with 200 no longer yields `data: null` (F28).
  The discovered `prefix` is encoded per path segment, so a multi-segment prefix such as `ws/foo`
  routes to `/v1/ws/foo/...` as it does in the reference clients instead of collapsing into one
  `ws%2Ffoo` segment; empty segments from a leading, trailing, or doubled `/` are dropped (F28).
  Discovery now refuses a prefix whose segments include `.` or `..`: per-segment encoding leaves a
  dot segment intact, so such a prefix would resolve the request outside the configured base path —
  in the worst case to the host root — with the outbound credential attached.

- The catalog client now retries retryable transport failures — network errors and per-attempt
  timeouts — for `GET`/`HEAD` and for idempotency-keyed mutations, using the same attempt budget and
  backoff as HTTP 429 and 5xx (F26). `Retry-After` is honoured up to the per-attempt request timeout
  instead of a fixed five-second cap, and a wait that no longer fits the call's retry budget
  surfaces the upstream error instead of sleeping (F26). The concurrency permit is now acquired per
  attempt and released while the backoff sleeps, so a queued request no longer waits behind a
  sleeping one (F26).
- A caller that aborts — during the fetch, while queued for a permit, or during the retry backoff —
  now gets the new `CancelledError` (`type: "CancelledError"`, `retryable: false`, `status: null`)
  instead of a retryable `UpstreamError` 502 (F25, F26). `CatalogClient.call` takes its abort signal
  as `{ signal }` in a new options argument, and the signal reaches the fetch, the semaphore, the
  auth token request, and the backoff sleep (F25). The new abort-aware `sleep`
  (`src/shared/sleep.ts`) replaces `node:timers/promises` in the retry loop so a cancelled backoff
  ends immediately.

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
- The CLI now compares `process.versions.node` with the `engines.node` range from `package.json`
  before doing anything else, writes one requirement line to stderr, and exits non-zero when the
  runtime is too old, instead of failing later with an obscure syntax or API error. The minimum is
  derived from the manifest (`NODE_ENGINE_RANGE`, `MINIMUM_NODE_VERSION`, `isSupportedNodeVersion`
  in `src/version.ts`) rather than restated as a literal.

### Removed

- The unused direct `hono` dependency. Nothing in `src/` imports it; it remains available only as a
  transitive dependency of `@modelcontextprotocol/node`.
