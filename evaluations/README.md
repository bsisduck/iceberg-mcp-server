# Read-only MCP evaluations

`evaluations.xml` contains ten independent, multi-hop questions with single string-comparable
answers. They are pinned to immutable Iceberg Javadocs. Evaluation 9 additionally pins the local
source checkout to revision `6164440663e3f7b1bae92a1a710ca5233755cd7d`.

Run the independent protocol verifier from the repository root:

```sh
npm run verify:evaluations
```

The verifier starts the built server on an ephemeral loopback HTTP port and solves every question
using only read-only MCP tool calls. It fetches the official 1.10.1 and 1.11.0 Javadocs and reads
the configured sibling `../iceberg` checkout. It never configures a REST Catalog or registers
mutation tools. The run fails if the source revision differs from the pinned evaluation fixture.
