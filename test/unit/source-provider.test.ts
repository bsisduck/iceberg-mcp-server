import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
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
  await mkdir(path.join(root, 'api', 'src', 'test', 'java', 'org', 'apache', 'iceberg'), {
    recursive: true,
  });
  await mkdir(path.join(root, 'core', 'build', 'generated', 'src', 'main', 'java'), {
    recursive: true,
  });
  await writeFile(
    path.join(root, 'api', 'src', 'test', 'java', 'org', 'apache', 'iceberg', 'TestTable.java'),
    'package org.apache.iceberg; public class TestTable {}',
  );
  await writeFile(
    path.join(root, 'core', 'build', 'generated', 'src', 'main', 'java', 'Generated.java'),
    'package generated; public class Generated {}',
  );
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
  it('indexes nested module source roots and skips test and build trees', async (): Promise<void> => {
    const root = await createCheckout();
    const nested = path.join(
      root,
      'spark',
      'v3.5',
      'spark',
      'src',
      'main',
      'java',
      'org',
      'apache',
      'iceberg',
      'spark',
    );
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(nested, 'SparkTable.java'),
      `package org.apache.iceberg.spark;
       public class SparkTable {}
      `,
    );
    const provider = await SourceProvider.create(root);

    const index = await provider.loadIndex();

    expect(index.files.map((record) => record.fullyQualifiedName)).toEqual([
      'org.apache.iceberg.BaseTable',
      'org.apache.iceberg.spark.SparkTable',
      'org.apache.iceberg.Table',
    ]);
    expect(index.byFullyQualifiedName.get('org.apache.iceberg.spark.SparkTable')).toMatchObject({
      module: 'spark/v3.5/spark',
      relativePath: path.join(
        'spark',
        'v3.5',
        'spark',
        'src',
        'main',
        'java',
        'org',
        'apache',
        'iceberg',
        'spark',
        'SparkTable.java',
      ),
      stableModule: false,
    });
  });

  it('derives the stable module set from the checkout RevAPI configuration', async (): Promise<void> => {
    const root = await createCheckout();
    await mkdir(path.join(root, '.palantir'), { recursive: true });
    await writeFile(
      path.join(root, '.palantir', 'revapi.yml'),
      `acceptedBreaks:
  "1.0.0":
    org.apache.iceberg:iceberg-spark:
    - code: "java.method.removed"
      old: "method void org.apache.iceberg.Table::refresh()"
`,
    );
    const provider = await SourceProvider.create(root);

    const index = await provider.loadIndex();

    expect([...index.stableModules]).toEqual(['spark']);
    expect(index.byFullyQualifiedName.get('org.apache.iceberg.Table')?.stableModule).toBe(false);
    expect(index.byFullyQualifiedName.get('org.apache.iceberg.BaseTable')?.stableModule).toBe(true);
  });

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

  it('matches declared supertypes without matching generic parameters or bounds', async (): Promise<void> => {
    const root = await createCheckout();
    const declarations = new Map([
      ['GenericArgument', 'public class GenericArgument extends Foo<Name> {}'],
      ['SecondInterface', 'public class SecondInterface implements A, Name {}'],
      ['GenericSelf', 'public class GenericSelf extends Name<T> {}'],
      ['Qualified', 'public class Qualified extends org.apache.iceberg.Name {}'],
      ['GenericBound', 'public class GenericBound<T extends Name> extends Foo {}'],
      ['MapValue', 'public class MapValue implements Map<String, Name> {}'],
    ]);
    const directory = path.join(root, 'api', 'src', 'main', 'java', 'org', 'apache', 'iceberg');
    for (const [name, declaration] of declarations) {
      await writeFile(
        path.join(directory, `${name}.java`),
        `package org.apache.iceberg;
         ${declaration}
        `,
      );
    }
    await writeFile(
      path.join(directory, 'Name.java'),
      `package org.apache.iceberg;
       public interface Name {}
      `,
    );
    const provider = await SourceProvider.create(root);

    const implementations = await provider.findImplementations('org.apache.iceberg.Name');

    expect(implementations.items.map((item) => item.fullyQualifiedName).sort()).toEqual([
      'org.apache.iceberg.GenericSelf',
      'org.apache.iceberg.Qualified',
      'org.apache.iceberg.SecondInterface',
    ]);
    expect(implementations.items[0]).toMatchObject({
      column: 35,
      line: 2,
      preview: 'public class GenericSelf extends Name<T> {}',
    });
  });

  it('answers a literal search from indexed text and falls back to disk when the bound is zero', async (): Promise<void> => {
    const root = await createCheckout();
    const marker = path.join(
      root,
      'spark',
      'src',
      'main',
      'java',
      'org',
      'apache',
      'iceberg',
      'BaseTable.java',
    );
    const cached = await SourceProvider.create(root);
    const uncached = await SourceProvider.create(root, { indexMaxBytes: 0 });
    const [cachedIndex, uncachedIndex] = await Promise.all([
      cached.loadIndex(),
      uncached.loadIndex(),
    ]);
    expect(cachedIndex.sources.size).toBe(2);
    expect(uncachedIndex.sources.size).toBe(0);

    await unlink(marker);

    await expect(cached.search('search-me')).resolves.toMatchObject({ items: [{ line: 3 }] });
    await expect(uncached.search('search-me')).rejects.toThrow(/ENOENT/u);
  });

  it('stops indexing, searching, and scanning when the caller aborts', async (): Promise<void> => {
    const root = await createCheckout();
    const provider = await SourceProvider.create(root);
    const aborted = AbortSignal.abort();

    await expect(provider.loadIndex(aborted)).rejects.toMatchObject({ name: 'CancelledError' });

    await provider.loadIndex();

    await expect(provider.search('search-me', 50, 0, aborted)).rejects.toMatchObject({
      name: 'CancelledError',
    });
    await expect(
      provider.findImplementations('org.apache.iceberg.Table', 100, 0, aborted),
    ).rejects.toMatchObject({ name: 'CancelledError' });
    await expect(
      provider.getType('org.apache.iceberg.Table', 1, 10, aborted),
    ).rejects.toMatchObject({ name: 'CancelledError' });
  });

  it('rebuilds when the checked-out revision or the root directory changes', async (): Promise<void> => {
    const root = await createCheckout();
    const gitDir = path.join(root, '.git');
    const ref = path.join(gitDir, 'refs', 'heads', 'main');
    await mkdir(path.dirname(ref), { recursive: true });
    await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(ref, `${'a'.repeat(40)}\n`);
    const provider = await SourceProvider.create(root);

    const first = await provider.loadIndex();
    expect(first.identity).toMatchObject({ branch: 'main', revision: 'a'.repeat(40) });

    await writeFile(
      path.join(root, 'api', 'src', 'main', 'java', 'org', 'apache', 'iceberg', 'Added.java'),
      'package org.apache.iceberg; public class Added {}',
    );
    expect(await provider.loadIndex()).toBe(first);

    await writeFile(ref, `${'b'.repeat(40)}\n`);
    const afterCommit = await provider.loadIndex();
    expect(afterCommit).not.toBe(first);
    expect(afterCommit.identity.revision).toBe('b'.repeat(40));
    expect(afterCommit.byFullyQualifiedName.has('org.apache.iceberg.Added')).toBe(true);

    await utimes(root, new Date(), new Date(Date.now() + 60_000));
    const afterTouch = await provider.loadIndex();
    expect(afterTouch).not.toBe(afterCommit);
    expect(afterTouch.stamp.rootModifiedMs).not.toBe(afterCommit.stamp.rootModifiedMs);
  });

  it('resolves a detached HEAD and a packed ref, and refresh rebuilds on demand', async (): Promise<void> => {
    const root = await createCheckout();
    const gitDir = path.join(root, '.git');
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, 'HEAD'), `${'c'.repeat(40)}\n`);
    const detached = await SourceProvider.create(root);

    const detachedIndex = await detached.loadIndex();
    expect(detachedIndex.identity).toMatchObject({ branch: undefined, revision: 'c'.repeat(40) });

    await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      path.join(gitDir, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${'d'.repeat(40)} refs/heads/main\n`,
    );
    const packed = await SourceProvider.create(root);

    const packedIndex = await packed.loadIndex();
    expect(packedIndex.identity).toMatchObject({ branch: 'main', revision: 'd'.repeat(40) });
    expect(await packed.loadIndex()).toBe(packedIndex);
    expect(await packed.refresh()).not.toBe(packedIndex);
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
