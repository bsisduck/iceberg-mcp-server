# Apache Iceberg MCP Server

A production-oriented Model Context Protocol server for Apache Iceberg Java API intelligence and
optional REST Catalog operations.

The supplied Iceberg `latest/api` documentation describes Java libraries; it is not itself a
callable REST API. This project therefore keeps two surfaces separate:

- read-only search, lookup, comparison, and source evidence for the published Iceberg Java API;
- typed Iceberg REST Catalog tools, enabled only when an operator configures a conforming catalog
  endpoint.

The implementation is in progress. The checked-in
[implementation plan](docs/implementation-plan.md), [architecture](docs/architecture.md),
[security model](docs/security.md), and [coverage matrix](docs/coverage.md) define the intended
surface and its evidence.

## Development

Requires Node.js 20.19 or newer.

```sh
npm install
npm run check
npm run dev -- --help
```

`stdio` is the default transport. Streamable HTTP binds to `127.0.0.1` by default; a non-loopback
bind is rejected unless both inbound bearer authentication and an exact origin allowlist are
configured. Copy `.env.example` as a reference, but supply secrets through the documented `_FILE`
variables in deployed environments.

No catalog credentials are required for the Java documentation and source capabilities.

## License

Apache License 2.0. Apache Iceberg is a trademark of The Apache Software Foundation; this
independent server is not an Apache Software Foundation project.
