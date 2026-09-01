# Contributing

Contributions should stay within the boundaries described in [architecture.md](docs/architecture.md)
and [security.md](docs/security.md). Open a focused issue or pull request that explains the problem,
the proposed behavior, and how the change was tested.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not through a
public issue.

## Development setup

Use Node.js 20.19 or newer and install the locked dependencies:

```sh
npm ci
npm run check
```

`npm run check` verifies formatting, lint rules, TypeScript types, tests, coverage thresholds, and
the production build. Run the narrower commands while developing when that gives faster feedback:

```sh
npm test
npm run test:coverage
npm run verify:clients
```

The evaluation verifier downloads pinned Iceberg Javadocs and expects the adjacent `../iceberg`
checkout at the revision recorded in `evaluations/README.md`:

```sh
npm run verify:evaluations
```

The OpenAPI verifier compares the implementation with the current document in that checkout:

```sh
npm run verify:openapi
```

## Change requirements

- Add tests for new behavior and regression tests for bug fixes.
- Update the tool reference, coverage matrix, and user stories when the public MCP surface changes.
- Keep catalog mutations typed, advertised by discovery, and disabled without operator opt-in.
- Keep tool arguments free of arbitrary URLs, filesystem paths, and credentials.
- Do not commit `.env` files, secrets, dependencies, coverage data, build output, or package
  archives.
- Keep commits focused and explain why the change is needed.

## Pull request checklist

Before requesting review:

1. Run `npm run check`.
2. Run the relevant evaluation, client, and OpenAPI verifiers.
3. Review the full diff for secrets, generated files, and unrelated edits.
4. Update documentation for user-visible behavior or configuration changes.
5. Describe any tests that were not run and why.
