import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

const [filename, mode] = process.argv.slice(2);
if (filename === undefined) {
  throw new Error('Usage: check-openapi-coverage.mjs <openapi.yaml|-> [--release]');
}

const source =
  filename === '-'
    ? await new Response(process.stdin).text()
    : await readFile(new URL(filename, `file://${process.cwd()}/`), 'utf8');
const document = parse(source);
if (document === null || typeof document !== 'object') {
  throw new Error('OpenAPI document is not an object');
}

const operationIds = new Set();
for (const pathItem of Object.values(document.paths ?? {})) {
  if (pathItem === null || typeof pathItem !== 'object') {
    continue;
  }
  for (const operation of Object.values(pathItem)) {
    if (
      operation !== null &&
      typeof operation === 'object' &&
      typeof operation.operationId === 'string'
    ) {
      operationIds.add(operation.operationId);
    }
  }
}

const operations = await import('../dist/catalog/operations.js');
const implemented = new Set(
  (mode === '--release' ? operations.CATALOG_OPERATIONS : operations.ALL_CATALOG_OPERATIONS).map(
    (operation) => operation.id,
  ),
);
const missing = [...operationIds].filter((id) => !implemented.has(id)).sort();
const extra = [...implemented].filter((id) => !operationIds.has(id)).sort();
if (missing.length > 0 || extra.length > 0) {
  throw new Error(
    `OpenAPI coverage mismatch\nMissing: ${missing.join(', ') || '(none)'}\nExtra: ${extra.join(', ') || '(none)'}`,
  );
}

process.stdout.write(`OpenAPI operation coverage verified: ${implemented.size} operations\n`);
