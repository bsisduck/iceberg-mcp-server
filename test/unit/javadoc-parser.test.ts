import { describe, expect, it } from 'vitest';

import {
  parseMemberIndex,
  parsePackageIndex,
  parseTypeDocumentation,
  parseTypeIndex,
} from '../../src/api/javadoc-parser.js';

const root = new URL('https://iceberg.apache.org/javadoc/1.11.0/');

describe('Javadoc parser', (): void => {
  it('parses only Java packages and public type/member identities', (): void => {
    const packages = parsePackageIndex(
      'packageSearchIndex = [{"l":"All Packages","u":"allpackages-index.html"},{"l":"org.apache.iceberg"}];updateSearchResults();',
      root,
    );
    const types = parseTypeIndex(
      'typeSearchIndex = [{"p":"org.apache.iceberg","l":"Table"},{"l":"All Classes and Interfaces","u":"allclasses-index.html"}];updateSearchResults();',
      root,
    );
    const members = parseMemberIndex(
      'memberSearchIndex = [{"p":"org.apache.iceberg","c":"Table","l":"schema()"}];updateSearchResults();',
      root,
    );

    expect(packages).toEqual([
      {
        name: 'org.apache.iceberg',
        url: 'https://iceberg.apache.org/javadoc/1.11.0/org/apache/iceberg/package-summary.html',
      },
    ]);
    expect(types[0]).toMatchObject({
      fullyQualifiedName: 'org.apache.iceberg.Table',
      url: 'https://iceberg.apache.org/javadoc/1.11.0/org/apache/iceberg/Table.html',
    });
    expect(members[0]).toMatchObject({
      typeFullyQualifiedName: 'org.apache.iceberg.Table',
      url: 'https://iceberg.apache.org/javadoc/1.11.0/org/apache/iceberg/Table.html#schema()',
    });
  });

  it('ignores blank synthetic member records emitted by older official Javadocs', (): void => {
    const members = parseMemberIndex(
      'memberSearchIndex = [{"p":"","c":"","l":"add(DataFile)"},{"p":"org.apache.iceberg","c":"Table","l":"schema()"}];updateSearchResults();',
      root,
    );

    expect(members).toHaveLength(1);
    expect(members[0]?.label).toBe('schema()');
    expect(() =>
      parseMemberIndex(
        'memberSearchIndex = [{"p":"bad/package","c":"Table","l":"schema()"}];updateSearchResults();',
        root,
      ),
    ).toThrow(/Invalid member index record/u);
  });

  it('refuses executable suffixes and external URLs', (): void => {
    expect(() =>
      parseTypeIndex('typeSearchIndex = [];updateSearchResults();alert(1)', root),
    ).toThrow(/wrapper/u);
    expect(() =>
      parseTypeIndex(
        'typeSearchIndex = [{"p":"org.apache.iceberg","l":"Table","u":"https://example.test/Table.html"}];updateSearchResults();',
        root,
      ),
    ).toThrow(/escaped/u);
  });

  it('extracts normalized type and member documentation', (): void => {
    const documentation = parseTypeDocumentation(`
      <main>
        <h1 class="title">Interface Table</h1>
        <div class="type-signature">public interface <strong>Table</strong></div>
        <section class="class-description"><div class="block">Access a table's metadata.</div></section>
        <div class="deprecation-block">Deprecated for testing.</div>
        <section class="detail" id="schema()">
          <h3>schema</h3>
          <div class="member-signature">Schema schema()</div>
          <div class="block">Return the current schema.</div>
        </section>
      </main>
    `);

    expect(documentation).toEqual({
      declaration: 'public interface Table',
      deprecated: 'Deprecated for testing.',
      description: "Access a table's metadata.",
      members: [
        {
          anchor: 'schema()',
          declaration: 'Schema schema()',
          description: 'Return the current schema.',
          name: 'schema',
        },
      ],
      title: 'Interface Table',
    });
  });

  it('rejects a type page without a title', (): void => {
    expect(() => parseTypeDocumentation('<html><main></main></html>')).toThrow(/no title/u);
  });
});
