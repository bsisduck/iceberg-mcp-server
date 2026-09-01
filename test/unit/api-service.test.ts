import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../src/api/api-service.js';
import { JavadocProvider } from '../../src/api/javadoc-provider.js';
import { SourceProvider } from '../../src/api/source-provider.js';
import type { AppConfig } from '../../src/config.js';

const temporaryDirectories: string[] = [];

function assignment(name: string, value: unknown): string {
  return `${name} = ${JSON.stringify(value)};updateSearchResults();`;
}

const indexes: Record<
  string,
  {
    members: readonly object[];
    packages: readonly object[];
    types: readonly object[];
  }
> = {
  '1.0.0': {
    members: [
      { c: 'Table', l: 'schema()', p: 'org.apache.iceberg' },
      { c: 'Table', l: 'currentSnapshot()', p: 'org.apache.iceberg' },
      { c: 'FileIO', l: 'newInputFile(String)', p: 'org.apache.iceberg.io' },
    ],
    packages: [{ l: 'org.apache.iceberg' }, { l: 'org.apache.iceberg.io' }],
    types: [
      { l: 'Table', p: 'org.apache.iceberg' },
      { l: 'BaseTable', p: 'org.apache.iceberg' },
      { l: 'SparkTable', p: 'org.apache.iceberg' },
      { l: 'FileIO', p: 'org.apache.iceberg.io' },
    ],
  },
  '2.0.0': {
    members: [
      { c: 'Table', l: 'schema()', p: 'org.apache.iceberg' },
      { c: 'Table', l: 'refresh()', p: 'org.apache.iceberg' },
      { c: 'Catalog', l: 'loadTable(String)', p: 'org.apache.iceberg' },
    ],
    packages: [{ l: 'org.apache.iceberg' }, { l: 'org.apache.iceberg.data' }],
    types: [
      { l: 'Table', p: 'org.apache.iceberg' },
      { l: 'Catalog', p: 'org.apache.iceberg' },
      { l: 'DataFile', p: 'org.apache.iceberg.data' },
    ],
  },
};

const tableHtml = `
  <main>
    <h1 class="title">Interface Table</h1>
    <div class="type-signature">public interface <strong>Table</strong></div>
    <section class="class-description"><div class="block">Access table metadata.</div></section>
    <section class="detail" id="schema()">
      <h3>schema</h3><div class="member-signature">Schema schema()</div>
      <div class="block">Return the current schema.</div>
    </section>
    <section class="detail" id="currentSnapshot()">
      <h3>currentSnapshot</h3><div class="member-signature">Snapshot currentSnapshot()</div>
    </section>
  </main>`;

function javadocFetch(): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const match = /^\/javadoc\/(1\.0\.0|2\.0\.0)\/(.*)$/u.exec(url.pathname);
    const version = match?.[1];
    const filename = match?.[2];
    const fixture = version === undefined ? undefined : indexes[version];
    if (fixture === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    if (filename === 'package-search-index.js') {
      return Promise.resolve(
        new Response(assignment('packageSearchIndex', fixture.packages), {
          headers: { 'content-type': 'application/javascript' },
        }),
      );
    }
    if (filename === 'type-search-index.js') {
      return Promise.resolve(
        new Response(assignment('typeSearchIndex', fixture.types), {
          headers: { 'content-type': 'application/javascript' },
        }),
      );
    }
    if (filename === 'member-search-index.js') {
      return Promise.resolve(
        new Response(assignment('memberSearchIndex', fixture.members), {
          headers: { 'content-type': 'application/javascript' },
        }),
      );
    }
    if (filename === 'org/apache/iceberg/Table.html') {
      return Promise.resolve(new Response(tableHtml, { headers: { 'content-type': 'text/html' } }));
    }
    return Promise.resolve(
      new Response('<main><h1 class="title">Type</h1></main>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
  });
}

function config(sourceDir?: string): AppConfig {
  return {
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
    javadoc: { baseUrl: new URL('https://iceberg.apache.org/javadoc/'), version: '1.0.0' },
    limits: { maxResponseChars: 30_000, requestTimeoutMs: 1_000 },
    sourceDir,
    transport: 'stdio',
  };
}

async function checkout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'iceberg-api-service-test-'));
  temporaryDirectories.push(root);
  const files = [
    {
      contents:
        'package org.apache.iceberg; public interface Table { interface Nested {} String marker = "needle"; }',
      module: 'api',
      name: 'Table',
      packagePath: 'org/apache/iceberg',
    },
    {
      contents: 'package org.apache.iceberg; public final class SparkTable implements Table {}',
      module: 'spark',
      name: 'SparkTable',
      packagePath: 'org/apache/iceberg',
    },
    {
      contents: 'package org.apache.iceberg.experimental; public final class Preview {}',
      module: 'experimental',
      name: 'Preview',
      packagePath: 'org/apache/iceberg/experimental',
    },
  ];
  for (const file of files) {
    const directory = path.join(root, file.module, 'src', 'main', 'java', file.packagePath);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${file.name}.java`), file.contents);
  }
  return root;
}

let root: string;
let provider: JavadocProvider;
let source: SourceProvider;
let service: ApiService;

beforeEach(async (): Promise<void> => {
  root = await checkout();
  provider = new JavadocProvider({
    config: config(root).javadoc,
    fetch: javadocFetch(),
    requestTimeoutMs: 1_000,
  });
  source = await SourceProvider.create(root);
  service = new ApiService({ config: config(root), javadoc: provider, source });
});

afterEach(async (): Promise<void> => {
  provider.clear();
  source.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('ApiService', (): void => {
  it('lists release, nightly, and local source identities', async (): Promise<void> => {
    const result = await service.listVersions();

    expect(result.count).toBe(3);
    expect(result.items.map((item) => item.kind)).toEqual(['release', 'nightly', 'source']);
    expect(result.items[2]?.source).toMatch(new RegExp(`${path.basename(root)}$`, 'u'));
  });

  it('browses every index kind with exact filters and bound cursors', async (): Promise<void> => {
    const packages = await service.browse({ kind: 'package', limit: 1, version: '1.0.0' });
    expect(packages.items).toMatchObject([{ kind: 'package', label: 'org.apache.iceberg' }]);
    expect(packages.has_more).toBe(true);

    const nextPackage = await service.browse({
      cursor: packages.next_cursor ?? undefined,
      kind: 'package',
      limit: 10,
      version: '1.0.0',
    });
    expect(nextPackage.items[0]?.label).toBe('org.apache.iceberg.io');

    const types = await service.browse({ kind: 'type', limit: 10, version: '1.0.0' });
    expect(types.items.some((item) => item.kind === 'type')).toBe(true);
  });

  it('filters browse results and rejects a cursor used with another query', async (): Promise<void> => {
    const first = await service.browse({ kind: 'type', limit: 1, version: '1.0.0' });
    const filtered = await service.browse({
      kind: 'member',
      limit: 10,
      packageName: 'org.apache.iceberg',
      prefix: 'sch',
      version: '1.0.0',
    });

    expect(filtered.items).toMatchObject([
      { container: 'Table', kind: 'member', label: 'schema()' },
    ]);
    await expect(
      service.browse({
        cursor: first.next_cursor ?? undefined,
        kind: 'type',
        limit: 1,
        packageName: 'org.apache.iceberg',
        version: '1.0.0',
      }),
    ).rejects.toThrow(/does not match/u);
  });

  it('ranks exact, prefix, and containing search matches and paginates them', async (): Promise<void> => {
    const exact = await service.search({
      limit: 10,
      query: 'Table',
      scope: 'all',
      version: '1.0.0',
    });
    expect(exact.items[0]).toMatchObject({ label: 'Table', score: 100 });
    expect(exact.items.some((item) => item.label === 'BaseTable' && item.score === 60)).toBe(true);

    const prefix = await service.search({
      limit: 1,
      packageName: 'org.apache.iceberg',
      query: 'org.apache',
      scope: 'type',
      version: '1.0.0',
    });
    expect(prefix.items[0]?.score).toBe(70);
    expect(prefix.has_more).toBe(true);
    const next = await service.search({
      cursor: prefix.next_cursor ?? undefined,
      limit: 1,
      packageName: 'org.apache.iceberg',
      query: 'org.apache',
      scope: 'type',
      version: '1.0.0',
    });
    expect(next.items).toHaveLength(1);
  });

  it('returns detailed types, members, pagination, and stability evidence', async (): Promise<void> => {
    const type = await service.getType({
      fullyQualifiedName: 'org.apache.iceberg.Table',
      memberLimit: 1,
      version: '1.0.0',
    });
    expect(type).toMatchObject({
      description: 'Access table metadata.',
      has_more_members: true,
      stability: { classification: 'stable-module', module: 'api' },
    });
    const next = await service.getType({
      cursor: type.next_member_cursor ?? undefined,
      fullyQualifiedName: 'org.apache.iceberg.Table',
      memberLimit: 1,
      version: '1.0.0',
    });
    expect(next.members[0]?.name).toBe('currentSnapshot');

    const byAnchor = await service.getMember({
      fullyQualifiedName: 'org.apache.iceberg.Table',
      member: 'schema()',
      version: '1.0.0',
    });
    const byLabel = await service.getMember({
      fullyQualifiedName: 'org.apache.iceberg.Table',
      member: 'currentSnapshot()',
      version: '1.0.0',
    });
    expect(byAnchor.description).toBe('Return the current schema.');
    expect(byLabel.declaration).toBe('Snapshot currentSnapshot()');

    await expect(
      service.getMember({
        fullyQualifiedName: 'org.apache.iceberg.Table',
        member: 'missing()',
        version: '1.0.0',
      }),
    ).rejects.toThrow(/not found/u);
  });

  it('classifies unmapped and non-stable source modules conservatively', async (): Promise<void> => {
    const noSource = new ApiService({
      config: config(),
      javadoc: provider,
      source: undefined,
    });
    expect(
      (
        await noSource.getType({
          fullyQualifiedName: 'org.apache.iceberg.Table',
          memberLimit: 10,
          version: '1.0.0',
        })
      ).stability,
    ).toMatchObject({ classification: 'public-unclassified', module: null });
    const unmapped = await service.getType({
      fullyQualifiedName: 'org.apache.iceberg.BaseTable',
      memberLimit: 10,
      version: '1.0.0',
    });
    expect(unmapped.stability.reason).toMatch(/could not be mapped/u);
    const nonStable = await service.getType({
      fullyQualifiedName: 'org.apache.iceberg.SparkTable',
      memberLimit: 10,
      version: '1.0.0',
    });
    expect(nonStable.stability).toMatchObject({
      classification: 'public-unclassified',
      module: 'spark',
    });
  });

  it('compares added and removed identities with validation and pagination', async (): Promise<void> => {
    const comparison = await service.compareVersions({
      fromVersion: '1.0.0',
      kind: 'type',
      limit: 2,
      toVersion: '2.0.0',
    });
    expect(comparison.items).toEqual([
      { identity: 'org.apache.iceberg.Catalog', kind: 'type', status: 'added' },
      { identity: 'org.apache.iceberg.data.DataFile', kind: 'type', status: 'added' },
    ]);
    expect(comparison.has_more).toBe(true);
    const next = await service.compareVersions({
      cursor: comparison.next_cursor ?? undefined,
      fromVersion: '1.0.0',
      kind: 'type',
      limit: 10,
      toVersion: '2.0.0',
    });
    expect(next.items.every((item) => item.status === 'removed')).toBe(true);
    await expect(
      service.compareVersions({
        fromVersion: '1.0.0',
        kind: 'type',
        limit: 10,
        toVersion: '1.0.0',
      }),
    ).rejects.toThrow(/must be different/u);
  });

  it('reads and searches configured source with truthful truncation', async (): Promise<void> => {
    const window = await service.getSourceType({
      fullyQualifiedName: 'org.apache.iceberg.Table.Nested',
      lineCount: 5,
      startLine: 1,
    });
    expect(window).toMatchObject({ module: 'api', provenance: { kind: 'source' } });

    const matches = await service.searchSource({ limit: 1, literal: 'Table' });
    expect(matches.count).toBe(1);
    expect(matches).toMatchObject({ has_more: true, truncated: false });
    const nextMatches = await service.searchSource({
      cursor: matches.next_cursor ?? undefined,
      limit: 1,
      literal: 'Table',
    });
    expect(nextMatches).toMatchObject({ count: 1, has_more: false, next_cursor: null });
    const implementations = await service.findSourceImplementations({
      fullyQualifiedName: 'org.apache.iceberg.Table',
      limit: 1,
    });
    expect(implementations.items[0]?.fullyQualifiedName).toBe('org.apache.iceberg.SparkTable');
    await expect(
      service.findSourceImplementations({
        cursor: matches.next_cursor ?? undefined,
        fullyQualifiedName: 'org.apache.iceberg.Table',
        limit: 1,
      }),
    ).rejects.toThrow(/does not match/u);

    const noSource = new ApiService({ config: config(), javadoc: provider, source: undefined });
    await expect(
      noSource.getSourceType({
        fullyQualifiedName: 'org.apache.iceberg.Table',
        lineCount: 1,
        startLine: 1,
      }),
    ).rejects.toThrow(/not configured/u);
  });
});
