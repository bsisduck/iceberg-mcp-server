import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

    expect(literalMatches).toHaveLength(1);
    expect(literalMatches[0]).toMatchObject({ fullyQualifiedName: 'org.apache.iceberg.BaseTable' });
    expect(implementations).toHaveLength(1);
    expect(implementations[0]).toMatchObject({
      fullyQualifiedName: 'org.apache.iceberg.BaseTable',
      line: 2,
    });
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
});
