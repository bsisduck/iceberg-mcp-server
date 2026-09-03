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

export interface SourceIndex {
  readonly byFullyQualifiedName: ReadonlyMap<string, SourceTypeRecord>;
  readonly files: readonly SourceTypeRecord[];
  readonly identity: SourceIdentity;
  readonly loadedAt: Date;
  /**
   * The modules RevAPI checks for binary compatibility, derived from the checkout. A filter over the
   * indexed records rather than a boundary on what is indexed.
   */
  readonly stableModules: ReadonlySet<string>;
}
