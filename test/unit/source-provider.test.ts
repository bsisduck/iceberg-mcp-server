import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SourceProvider } from '../../src/api/source-provider.js';

const temporaryDirectories: string[] = [];

async function createCheckout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'iceberg-source-test-'));
  temporaryDirectories.push(root);
  const api = path.join(root, 'api', 'src', 'main', 'java', 'org', 'apache', 'iceberg');
  const spark = path.join(root, 'spark', 'src', 'main', 'java', 'org', 'apache', 'iceberg');
  await mkdir(api, { recursive: true });
  await mkdir(spark, { recursive: true });
  await writeFile(
    path.join(api, 'Table.java'),
    `package org.apache.iceberg;
     /** class Fake {} */
     public interface Table {
       String literal = "class NotAType {}";
       interface Nested {}
     }
    `,
  );
  await writeFile(
    path.join(spark, 'BaseTable.java'),
    `package org.apache.iceberg;
     public final class BaseTable implements Table {
       public String marker() { return "search-me"; }
     }
    `,
  );
  return root;
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('SourceProvider', (): void => {
  it('indexes canonical production Java source and resolves nested types', async (): Promise<void> => {
    const root = await createCheckout();
    const provider = await SourceProvider.create(root);
    const index = await provider.loadIndex();

    expect(index.files).toHaveLength(2);
    expect(index.byFullyQualifiedName.get('org.apache.iceberg.Table')).toMatchObject({
      declarationNames: ['Table', 'Nested'],
      module: 'api',
      stableModule: true,
    });

    const nested = await provider.getType('org.apache.iceberg.Table.Nested', 2, 2);
    expect(nested).toMatchObject({
      endLine: 3,
      module: 'api',
      stableModule: true,
      startLine: 2,
    });
    expect(nested.lines).toHaveLength(2);
  });

  it('supports bounded literal and lexical implementation searches', async (): Promise<void> => {
    const root = await createCheckout();
    const provider = await SourceProvider.create(root);

    const literalMatches = await provider.search('search-me');
    const implementations = await provider.findImplementations('org.apache.iceberg.Table');

    expect(literalMatches.items).toHaveLength(1);
    expect(literalMatches.items[0]).toMatchObject({
      fullyQualifiedName: 'org.apache.iceberg.BaseTable',
    });
    expect(implementations.items).toHaveLength(1);
    expect(implementations.items[0]).toMatchObject({
      fullyQualifiedName: 'org.apache.iceberg.BaseTable',
      line: 2,
    });

    const first = await provider.search('Table', 1);
    const second = await provider.search('Table', 1, 1);
    expect(first).toMatchObject({ hasMore: true, items: [{ line: 2 }] });
    expect(second).toMatchObject({ hasMore: false, items: [{ line: 3 }] });
    await expect(provider.search('Table', 1, 3)).rejects.toThrow(/beyond/u);
    await expect(provider.findImplementations('org.apache.iceberg.*')).rejects.toThrow(
      /not found/u,
    );
  });

  it('does not follow directory symlinks', async (): Promise<void> => {
    const root = await createCheckout();
    const outside = await mkdtemp(path.join(tmpdir(), 'iceberg-source-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, 'Escaped.java'), 'package escaped; public class Escaped {}');
    await symlink(
      outside,
      path.join(root, 'api', 'src', 'main', 'java', 'org', 'apache', 'iceberg', 'linked'),
    );
    const provider = await SourceProvider.create(root);

    const index = await provider.loadIndex();

    expect(index.files).toHaveLength(2);
    expect(index.byFullyQualifiedName.has('escaped.Escaped')).toBe(false);
  });

  it('rejects a source file replaced by an escaping symlink after indexing', async (): Promise<void> => {
    const root = await createCheckout();
    const provider = await SourceProvider.create(root);
    await provider.loadIndex();
    const outside = await mkdtemp(path.join(tmpdir(), 'iceberg-source-outside-'));
    temporaryDirectories.push(outside);
    const escaped = path.join(outside, 'Escaped.java');
    await writeFile(escaped, 'package escaped; public class Escaped {}');
    const table = path.join(
      root,
      'api',
      'src',
      'main',
      'java',
      'org',
      'apache',
      'iceberg',
      'Table.java',
    );
    await unlink(table);
    await symlink(escaped, table);

    await expect(provider.getType('org.apache.iceberg.Table')).rejects.toThrow(
      /escaped the configured checkout/u,
    );
  });
});
