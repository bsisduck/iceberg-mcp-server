import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createServices } from '../dist/services.js';
import { startHttp } from '../dist/transport/http.js';

const EXPECTED_SOURCE_REVISION = '6164440663e3f7b1bae92a1a710ca5233755cd7d';
const sourceDir = await realpath(fileURLToPath(new URL('../../iceberg/', import.meta.url)));
const config = {
  catalog: {
    allowMutations: false,
    oauth2Credential: undefined,
    oauth2Uri: undefined,
    token: undefined,
    uri: undefined,
    warehouse: undefined,
  },
  http: {
    allowedOrigins: ['http://127.0.0.1'],
    authToken: undefined,
    host: '127.0.0.1',
    maxRequestBytes: 1_048_576,
    port: 0,
  },
  javadoc: {
    baseUrl: new URL('https://iceberg.apache.org/javadoc/'),
    version: '1.11.0',
  },
  limits: { maxResponseChars: 100_000, requestTimeoutMs: 30_000 },
  logLevel: 'info',
  sourceDir,
  transport: 'http',
};
const reporter = {
  report(error, context) {
    process.stderr.write(`${context}: ${error instanceof Error ? error.message : String(error)}\n`);
  },
};
const services = await createServices(config);
const handle = await startHttp({ config, reporter, services }, reporter);
let requestId = 0;

async function callTool(name, arguments_) {
  requestId += 1;
  const response = await fetch(handle.address, {
    body: JSON.stringify({
      id: requestId,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: arguments_, name },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      origin: 'http://127.0.0.1',
    },
    method: 'POST',
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  const message = JSON.parse(dataLine?.slice(6) ?? text);
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  assert.notEqual(message.result?.isError, true, JSON.stringify(message.result));
  return message.result.structuredContent;
}

function member(type, label) {
  return type.members.find((candidate) => candidate.anchor === label || candidate.name === label);
}

const answers = [];

try {
  const table = await callTool('iceberg_api_get_type', {
    fully_qualified_name: 'org.apache.iceberg.Table',
    member_limit: 100,
    version: '1.11.0',
  });

  assert.ok(member(table, 'newIncrementalAppendScan()'));
  const incrementalAppend = await callTool('iceberg_api_get_type', {
    fully_qualified_name: 'org.apache.iceberg.IncrementalAppendScan',
    member_limit: 20,
    version: '1.11.0',
  });
  assert.match(incrementalAppend.declaration, /IncrementalScan/u);
  const startingBounds = await callTool('iceberg_api_search', {
    limit: 20,
    package_name: 'org.apache.iceberg',
    query: 'fromSnapshot',
    scope: 'member',
    version: '1.11.0',
  });
  answers.push(
    startingBounds.items.find(
      (item) =>
        item.container === 'IncrementalScan' && item.label === 'fromSnapshotExclusive(long)',
    )?.label,
  );

  assert.ok(member(table, 'newTransaction()'));
  const transaction = await callTool('iceberg_api_get_type', {
    fully_qualified_name: 'org.apache.iceberg.Transaction',
    member_limit: 100,
    version: '1.11.0',
  });
  answers.push(member(transaction, 'commitTransaction()')?.anchor);

  assert.ok(member(table, 'updateSchema()'));
  const updateSchema = await callTool('iceberg_api_get_type', {
    fully_qualified_name: 'org.apache.iceberg.UpdateSchema',
    member_limit: 100,
    version: '1.11.0',
  });
  assert.match(
    member(updateSchema, 'requireColumn')?.description ?? '',
    /allowIncompatibleChanges/u,
  );
  answers.push(member(updateSchema, 'allowIncompatibleChanges()')?.anchor);

  const deleteFile = await callTool('iceberg_api_get_type', {
    fully_qualified_name: 'org.apache.iceberg.DeleteFile',
    member_limit: 50,
    version: '1.11.0',
  });
  assert.match(member(deleteFile, 'contentOffset')?.description ?? '', /deletion vector/u);
  answers.push(member(deleteFile, 'contentOffset()')?.anchor);

  assert.ok(member(table, 'encryption()'));
  const encryption = await callTool('iceberg_api_get_type', {
    fully_qualified_name: 'org.apache.iceberg.encryption.EncryptionManager',
    member_limit: 50,
    version: '1.11.0',
  });
  const decryptSearch = await callTool('iceberg_api_search', {
    limit: 20,
    package_name: 'org.apache.iceberg.encryption',
    query: 'decrypt',
    scope: 'member',
    version: '1.11.0',
  });
  assert.match(member(encryption, 'decrypt')?.description ?? '', /EncryptedInputFile/u);
  answers.push(
    decryptSearch.items.find(
      (item) =>
        item.container === 'EncryptionManager' &&
        item.label === 'decrypt(Iterable<EncryptedInputFile>)',
    )?.label,
  );

  const reporterSearch = await callTool('iceberg_api_search', {
    limit: 10,
    package_name: 'org.apache.iceberg.metrics',
    query: 'MetricsReporter',
    scope: 'type',
    version: '1.11.0',
  });
  assert.ok(
    reporterSearch.items.some(
      (item) => item.fully_qualified_name === 'org.apache.iceberg.metrics.MetricsReporter',
    ),
  );
  const metricsReporter = await callTool('iceberg_api_get_type', {
    fully_qualified_name: 'org.apache.iceberg.metrics.MetricsReporter',
    member_limit: 20,
    version: '1.11.0',
  });
  const initialization = await callTool('iceberg_api_search', {
    limit: 10,
    package_name: 'org.apache.iceberg.metrics',
    query: 'initialize',
    scope: 'member',
    version: '1.11.0',
  });
  assert.match(member(metricsReporter, 'initialize')?.description ?? '', /no-arg constructor/u);
  answers.push(initialization.items.find((item) => item.container === 'MetricsReporter')?.label);

  assert.ok(member(table, 'newRewrite()'));
  const rewrite = await callTool('iceberg_api_get_type', {
    fully_qualified_name: 'org.apache.iceberg.RewriteFiles',
    member_limit: 50,
    version: '1.11.0',
  });
  const sequencedDelete = rewrite.members.find(
    (candidate) =>
      candidate.declaration ===
      'default RewriteFiles addFile(DeleteFile deleteFile, long dataSequenceNumber)',
  );
  answers.push(
    sequencedDelete === undefined
      ? undefined
      : (
          await callTool('iceberg_api_search', {
            limit: 20,
            package_name: 'org.apache.iceberg',
            query: 'addFile',
            scope: 'member',
            version: '1.11.0',
          })
        ).items.find(
          (item) => item.container === 'RewriteFiles' && item.label === 'addFile(DeleteFile, long)',
        )?.label,
  );

  assert.ok(member(table, 'refs()'));
  const snapshotRef = await callTool('iceberg_api_get_type', {
    fully_qualified_name: 'org.apache.iceberg.SnapshotRef',
    member_limit: 30,
    version: '1.11.0',
  });
  answers.push(member(snapshotRef, 'maxRefAgeMs()')?.anchor);

  const versions = await callTool('iceberg_api_list_versions', {});
  const sourceIdentity = versions.items.find((item) => item.kind === 'source');
  assert.equal(sourceIdentity?.label, EXPECTED_SOURCE_REVISION);
  const implementations = await callTool('iceberg_source_find_implementations', {
    fully_qualified_name: 'org.apache.iceberg.metrics.MetricsReporter',
    limit: 20,
  });
  const loggingReporter = implementations.items.find(
    (item) =>
      item.fullyQualifiedName === 'org.apache.iceberg.metrics.LoggingMetricsReporter' &&
      item.module === 'api',
  );
  assert.ok(loggingReporter);
  const loggingSource = await callTool('iceberg_source_get_type', {
    fully_qualified_name: loggingReporter.fullyQualifiedName,
    line_count: 80,
    start_line: 1,
  });
  assert.ok(
    loggingSource.lines.some((line) => line.includes('public class LoggingMetricsReporter')),
  );
  answers.push(loggingReporter.fullyQualifiedName);

  const comparison = await callTool('iceberg_api_compare_versions', {
    from_version: '1.10.1',
    kind: 'type',
    limit: 100,
    package_name: 'org.apache.iceberg',
    to_version: '1.11.0',
  });
  let partitionStatisticsScan;
  for (const item of comparison.items.filter((candidate) => candidate.status === 'added')) {
    const type = await callTool('iceberg_api_get_type', {
      fully_qualified_name: item.identity,
      member_limit: 1,
      version: '1.11.0',
    });
    if (type.description === 'API for configuring partition statistics scan.') {
      partitionStatisticsScan = type.fully_qualified_name;
      break;
    }
  }
  answers.push(partitionStatisticsScan);

  assert.deepEqual(answers, [
    'fromSnapshotExclusive(long)',
    'commitTransaction()',
    'allowIncompatibleChanges()',
    'contentOffset()',
    'decrypt(Iterable<EncryptedInputFile>)',
    'initialize(Map<String, String>)',
    'addFile(DeleteFile, long)',
    'maxRefAgeMs()',
    'org.apache.iceberg.metrics.LoggingMetricsReporter',
    'org.apache.iceberg.PartitionStatisticsScan',
  ]);
  process.stdout.write(`Verified ${answers.length}/10 read-only MCP evaluations.\n`);
} finally {
  await handle.close();
  await services.close();
}
