export type ApiVersionKind = 'nightly' | 'release' | 'source';

export interface Provenance {
  readonly iceberg_version: string;
  readonly kind: 'javadoc' | 'source';
  readonly retrieved_at: string;
  readonly source: string;
}

export interface PackageRecord {
  readonly name: string;
  readonly url: string;
}

export interface TypeRecord {
  readonly fullyQualifiedName: string;
  readonly label: string;
  readonly packageName: string;
  readonly url: string;
}

export interface MemberRecord {
  readonly anchor: string;
  readonly container: string;
  readonly label: string;
  readonly packageName: string;
  readonly typeFullyQualifiedName: string;
  readonly url: string;
}

export interface JavadocIndex {
  readonly loadedAt: Date;
  readonly members: readonly MemberRecord[];
  readonly packages: readonly PackageRecord[];
  readonly types: readonly TypeRecord[];
  readonly version: string;
}

export interface MemberDocumentation {
  readonly anchor: string;
  readonly declaration: string | undefined;
  readonly description: string | undefined;
  readonly name: string;
}

export interface TypeDocumentation {
  readonly declaration: string | undefined;
  readonly deprecated: string | undefined;
  readonly description: string | undefined;
  readonly members: readonly MemberDocumentation[];
  readonly title: string;
}

/**
 * One `extends`/`implements` clause found while indexing a file, already parsed into the simple type
 * names it declares. Recording the clause at index time keeps an implementation search in memory.
 */
export interface SuperTypeReference {
  readonly column: number;
  readonly line: number;
  readonly names: readonly string[];
  readonly preview: string;
}

export interface SourceTypeRecord {
  readonly declarationNames: readonly string[];
  readonly fullyQualifiedName: string;
  readonly module: string;
  readonly packageName: string;
  readonly relativePath: string;
  readonly stableModule: boolean;
  readonly superTypes: readonly SuperTypeReference[];
}

export interface SourceIdentity {
  readonly branch: string | undefined;
  readonly revision: string | undefined;
  readonly root: string;
}

/**
 * What the index was built from. A checked-out revision or a changed root directory listing means
 * the checkout moved under the server, so the next load rebuilds instead of answering from a stale
 * index.
 */
export interface SourceIndexStamp {
  readonly head: string | undefined;
  readonly rootModifiedMs: number;
}

export interface SourceIndex {
  readonly byFullyQualifiedName: ReadonlyMap<string, SourceTypeRecord>;
  readonly files: readonly SourceTypeRecord[];
  readonly identity: SourceIdentity;
  readonly loadedAt: Date;
  /**
   * File text captured while indexing, keyed by relative path, so a literal search does not reopen
   * the checkout. Bounded by `ICEBERG_SOURCE_INDEX_MAX_BYTES`; a file left out of the map is read
   * from disk on demand.
   */
  readonly sources: ReadonlyMap<string, string>;
  /**
   * The modules RevAPI checks for binary compatibility, derived from the checkout. A filter over the
   * indexed records rather than a boundary on what is indexed.
   */
  readonly stableModules: ReadonlySet<string>;
  readonly stamp: SourceIndexStamp;
}
