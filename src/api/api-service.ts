import type { AppConfig } from '../config.js';
import { decodeCursor, paginate } from '../shared/pagination.js';
import { InputError, NotFoundError } from '../shared/errors.js';
import { JavadocProvider } from './javadoc-provider.js';
import type {
  JavadocIndex,
  MemberDocumentation,
  MemberRecord,
  PackageRecord,
  Provenance,
  SourceTypeRecord,
  TypeDocumentation,
  TypeRecord,
} from './types.js';
import type { SourceMatch, SourceWindow } from './source-provider.js';
import { SourceProvider } from './source-provider.js';

export type ApiBrowseKind = 'member' | 'package' | 'type';
export type ApiSearchScope = 'all' | ApiBrowseKind;

export interface PageEnvelope<T> {
  readonly count: number;
  readonly has_more: boolean;
  readonly items: readonly T[];
  readonly next_cursor: string | null;
  readonly provenance: Provenance;
  readonly truncated: boolean;
}

export interface VersionItem {
  readonly kind: 'nightly' | 'release' | 'source';
  readonly label: string;
  readonly mutable: boolean;
  readonly source: string;
}

export interface VersionListResult {
  readonly count: number;
  readonly items: readonly VersionItem[];
}

export interface ApiBrowseItem {
  readonly container?: string;
  readonly fully_qualified_name?: string;
  readonly kind: ApiBrowseKind;
  readonly label: string;
  readonly package_name: string;
  readonly url: string;
}

export interface ApiSearchItem extends ApiBrowseItem {
  readonly score: number;
}

export interface StabilityEvidence {
  readonly classification: 'public-unclassified' | 'stable-module';
  readonly module: string | null;
  readonly reason: string;
  readonly source_revision: string | null;
}

export interface TypeResult {
  readonly declaration: string | null;
  readonly deprecated: string | null;
  readonly description: string | null;
  readonly fully_qualified_name: string;
  readonly has_more_members: boolean;
  readonly members: readonly MemberDocumentation[];
  readonly next_member_cursor: string | null;
  readonly package_name: string;
  readonly provenance: Provenance;
  readonly stability: StabilityEvidence;
  readonly title: string;
  readonly url: string;
}

export interface MemberResult {
  readonly anchor: string;
  readonly container: string;
  readonly declaration: string | null;
  readonly description: string | null;
  readonly label: string;
  readonly package_name: string;
  readonly provenance: Provenance;
  readonly type_fully_qualified_name: string;
  readonly url: string;
}

export interface ComparisonItem {
  readonly identity: string;
  readonly kind: ApiBrowseKind;
  readonly status: 'added' | 'removed';
}

export interface SourceResult extends SourceWindow {
  readonly provenance: Provenance;
}

export interface SourceSearchResult {
  readonly count: number;
  readonly items: readonly SourceMatch[];
  readonly provenance: Provenance;
  readonly truncated: boolean;
}

export interface ApiServiceOptions {
  readonly config: AppConfig;
  readonly javadoc: JavadocProvider;
  readonly source: SourceProvider | undefined;
}

function javadocProvenance(provider: JavadocProvider, index: JavadocIndex): Provenance {
  return {
    iceberg_version: index.version,
    kind: 'javadoc',
    retrieved_at: index.loadedAt.toISOString(),
    source: provider.rootUrl(index.version).href,
  };
}

function browseIdentity(item: PackageRecord | TypeRecord | MemberRecord): string {
  if ('typeFullyQualifiedName' in item) {
    return `${item.typeFullyQualifiedName}#${item.anchor}`;
  }
  if ('fullyQualifiedName' in item) {
    return item.fullyQualifiedName;
  }
  return item.name;
}

function browseItem(item: PackageRecord | TypeRecord | MemberRecord): ApiBrowseItem {
  if ('typeFullyQualifiedName' in item) {
    return {
      container: item.container,
      fully_qualified_name: `${item.typeFullyQualifiedName}#${item.anchor}`,
      kind: 'member',
      label: item.label,
      package_name: item.packageName,
      url: item.url,
    };
  }
  if ('fullyQualifiedName' in item) {
    return {
      fully_qualified_name: item.fullyQualifiedName,
      kind: 'type',
      label: item.label,
      package_name: item.packageName,
      url: item.url,
    };
  }
  return {
    kind: 'package',
    label: item.name,
    package_name: item.name,
    url: item.url,
  };
}

function searchScore(item: ApiBrowseItem, query: string): number {
  const normalizedQuery = query.toLowerCase();
  const label = item.label.toLowerCase();
  const identity = item.fully_qualified_name?.toLowerCase() ?? item.package_name.toLowerCase();
  if (label === normalizedQuery || identity === normalizedQuery) {
    return 100;
  }
  if (label.startsWith(normalizedQuery)) {
    return 80;
  }
  if (identity.startsWith(normalizedQuery)) {
    return 70;
  }
  if (label.includes(normalizedQuery)) {
    return 60;
  }
  if (identity.includes(normalizedQuery)) {
    return 40;
  }
  return 0;
}

function compareRecords(
  kind: ApiBrowseKind,
  fromRecords: readonly (MemberRecord | PackageRecord | TypeRecord)[],
  toRecords: readonly (MemberRecord | PackageRecord | TypeRecord)[],
): readonly ComparisonItem[] {
  const from = new Set(fromRecords.map(browseIdentity));
  const to = new Set(toRecords.map(browseIdentity));
  const changes: ComparisonItem[] = [];
  for (const identity of from) {
    if (!to.has(identity)) {
      changes.push({ identity, kind, status: 'removed' });
    }
  }
  for (const identity of to) {
    if (!from.has(identity)) {
      changes.push({ identity, kind, status: 'added' });
    }
  }
  return changes.sort((left, right) =>
    left.status === right.status
      ? left.identity.localeCompare(right.identity)
      : left.status.localeCompare(right.status),
  );
}

export class ApiService {
  readonly #config: AppConfig;
  readonly #javadoc: JavadocProvider;
  readonly #source: SourceProvider | undefined;

  public constructor(options: ApiServiceOptions) {
    this.#config = options.config;
    this.#javadoc = options.javadoc;
    this.#source = options.source;
  }

  public async listVersions(): Promise<VersionListResult> {
    const items: VersionItem[] = [];
    const configured = this.#config.javadoc.version;
    items.push({
      kind: configured === 'nightly' ? 'nightly' : 'release',
      label: configured,
      mutable: configured === 'nightly',
      source: this.#javadoc.rootUrl(configured).href,
    });
    if (configured !== 'nightly') {
      items.push({
        kind: 'nightly',
        label: 'nightly',
        mutable: true,
        source: this.#javadoc.rootUrl('nightly').href,
      });
    }
    if (this.#source !== undefined) {
      const sourceIndex = await this.#source.loadIndex();
      items.push({
        kind: 'source',
        label: sourceIndex.identity.revision ?? 'local-source',
        mutable: true,
        source: sourceIndex.identity.root,
      });
    }
    return { count: items.length, items };
  }

  public async browse(options: {
    cursor?: string | undefined;
    kind: ApiBrowseKind;
    limit: number;
    packageName?: string | undefined;
    prefix?: string | undefined;
    version: string;
  }): Promise<PageEnvelope<ApiBrowseItem>> {
    const index = await this.#javadoc.loadIndex(options.version);
    const query = {
      kind: options.kind,
      packageName: options.packageName ?? null,
      prefix: options.prefix ?? null,
      version: options.version,
    };
    const records = this.#records(index, options.kind).filter((record) => {
      const item = browseItem(record);
      return (
        (options.packageName === undefined || item.package_name === options.packageName) &&
        (options.prefix === undefined ||
          item.label.toLowerCase().startsWith(options.prefix.toLowerCase()))
      );
    });
    const offset = decodeCursor(options.cursor, query);
    const page = paginate(records.map(browseItem), offset, options.limit, query);
    return {
      count: page.items.length,
      has_more: page.hasMore,
      items: page.items,
      next_cursor: page.nextCursor ?? null,
      provenance: javadocProvenance(this.#javadoc, index),
      truncated: false,
    };
  }

  public async search(options: {
    cursor?: string | undefined;
    limit: number;
    packageName?: string | undefined;
    query: string;
    scope: ApiSearchScope;
    version: string;
  }): Promise<PageEnvelope<ApiSearchItem>> {
    const index = await this.#javadoc.loadIndex(options.version);
    const queryIdentity = {
      packageName: options.packageName ?? null,
      query: options.query.toLowerCase(),
      scope: options.scope,
      version: options.version,
    };
    const kinds: ApiBrowseKind[] =
      options.scope === 'all' ? ['package', 'type', 'member'] : [options.scope];
    const matches: ApiSearchItem[] = [];
    for (const kind of kinds) {
      for (const record of this.#records(index, kind)) {
        const item = browseItem(record);
        if (options.packageName !== undefined && item.package_name !== options.packageName) {
          continue;
        }
        const score = searchScore(item, options.query);
        if (score > 0) {
          matches.push({ ...item, score });
        }
      }
    }
    matches.sort((left, right) =>
      left.score === right.score
        ? (left.fully_qualified_name ?? left.package_name).localeCompare(
            right.fully_qualified_name ?? right.package_name,
          )
        : right.score - left.score,
    );
    const offset = decodeCursor(options.cursor, queryIdentity);
    const page = paginate(matches, offset, options.limit, queryIdentity);
    return {
      count: page.items.length,
      has_more: page.hasMore,
      items: page.items,
      next_cursor: page.nextCursor ?? null,
      provenance: javadocProvenance(this.#javadoc, index),
      truncated: false,
    };
  }

  public async getType(options: {
    cursor?: string | undefined;
    fullyQualifiedName: string;
    memberLimit: number;
    version: string;
  }): Promise<TypeResult> {
    const { documentation, record } = await this.#javadoc.getType(
      options.version,
      options.fullyQualifiedName,
    );
    const index = await this.#javadoc.loadIndex(options.version);
    const query = {
      fullyQualifiedName: options.fullyQualifiedName,
      version: options.version,
    };
    const memberOffset = decodeCursor(options.cursor, query);
    const memberPage = paginate(documentation.members, memberOffset, options.memberLimit, query);
    return {
      declaration: documentation.declaration ?? null,
      deprecated: documentation.deprecated ?? null,
      description: documentation.description ?? null,
      fully_qualified_name: record.fullyQualifiedName,
      has_more_members: memberPage.hasMore,
      members: memberPage.items,
      next_member_cursor: memberPage.nextCursor ?? null,
      package_name: record.packageName,
      provenance: javadocProvenance(this.#javadoc, index),
      stability: await this.#stability(record.fullyQualifiedName),
      title: documentation.title,
      url: record.url,
    };
  }

  public async getMember(options: {
    fullyQualifiedName: string;
    member: string;
    version: string;
  }): Promise<MemberResult> {
    const index = await this.#javadoc.loadIndex(options.version);
    const record = index.members.find(
      (candidate) =>
        candidate.typeFullyQualifiedName === options.fullyQualifiedName &&
        (candidate.anchor === options.member || candidate.label === options.member),
    );
    if (record === undefined) {
      throw new NotFoundError(
        `Java member not found: ${options.fullyQualifiedName}#${options.member}`,
      );
    }
    const { documentation } = await this.#javadoc.getType(
      options.version,
      options.fullyQualifiedName,
    );
    const detail = this.#memberDetail(documentation, record);
    return {
      anchor: record.anchor,
      container: record.container,
      declaration: detail?.declaration ?? null,
      description: detail?.description ?? null,
      label: record.label,
      package_name: record.packageName,
      provenance: javadocProvenance(this.#javadoc, index),
      type_fully_qualified_name: record.typeFullyQualifiedName,
      url: record.url,
    };
  }

  public async compareVersions(options: {
    cursor?: string | undefined;
    fromVersion: string;
    kind: ApiBrowseKind;
    limit: number;
    packageName?: string | undefined;
    toVersion: string;
  }): Promise<PageEnvelope<ComparisonItem>> {
    if (options.fromVersion === options.toVersion) {
      throw new InputError('Comparison versions must be different');
    }
    const [fromIndex, toIndex] = await Promise.all([
      this.#javadoc.loadIndex(options.fromVersion),
      this.#javadoc.loadIndex(options.toVersion),
    ]);
    const filterPackage = (record: MemberRecord | PackageRecord | TypeRecord): boolean =>
      options.packageName === undefined || browseItem(record).package_name === options.packageName;
    const changes = compareRecords(
      options.kind,
      this.#records(fromIndex, options.kind).filter(filterPackage),
      this.#records(toIndex, options.kind).filter(filterPackage),
    );
    const query = {
      fromVersion: options.fromVersion,
      kind: options.kind,
      packageName: options.packageName ?? null,
      toVersion: options.toVersion,
    };
    const page = paginate(changes, decodeCursor(options.cursor, query), options.limit, query);
    return {
      count: page.items.length,
      has_more: page.hasMore,
      items: page.items,
      next_cursor: page.nextCursor ?? null,
      provenance: {
        iceberg_version: `${options.fromVersion}..${options.toVersion}`,
        kind: 'javadoc',
        retrieved_at: new Date(
          Math.max(fromIndex.loadedAt.getTime(), toIndex.loadedAt.getTime()),
        ).toISOString(),
        source: `${this.#javadoc.rootUrl(options.fromVersion).href} -> ${this.#javadoc.rootUrl(options.toVersion).href}`,
      },
      truncated: false,
    };
  }

  public async getSourceType(options: {
    fullyQualifiedName: string;
    lineCount: number;
    startLine: number;
  }): Promise<SourceResult> {
    const source = this.#requireSource();
    const [window, index] = await Promise.all([
      source.getType(options.fullyQualifiedName, options.startLine, options.lineCount),
      source.loadIndex(),
    ]);
    return {
      ...window,
      provenance: this.#sourceProvenance(
        index.identity.revision,
        index.identity.root,
        index.loadedAt,
      ),
    };
  }

  public async searchSource(options: {
    limit: number;
    literal: string;
  }): Promise<SourceSearchResult> {
    const source = this.#requireSource();
    const [matches, index] = await Promise.all([
      source.search(options.literal, options.limit + 1),
      source.loadIndex(),
    ]);
    const truncated = matches.length > options.limit;
    return {
      count: Math.min(matches.length, options.limit),
      items: matches.slice(0, options.limit),
      provenance: this.#sourceProvenance(
        index.identity.revision,
        index.identity.root,
        index.loadedAt,
      ),
      truncated,
    };
  }

  public async findSourceImplementations(options: {
    fullyQualifiedName: string;
    limit: number;
  }): Promise<SourceSearchResult> {
    const source = this.#requireSource();
    const [matches, index] = await Promise.all([
      source.findImplementations(options.fullyQualifiedName, options.limit + 1),
      source.loadIndex(),
    ]);
    const truncated = matches.length > options.limit;
    return {
      count: Math.min(matches.length, options.limit),
      items: matches.slice(0, options.limit),
      provenance: this.#sourceProvenance(
        index.identity.revision,
        index.identity.root,
        index.loadedAt,
      ),
      truncated,
    };
  }

  #records(
    index: JavadocIndex,
    kind: ApiBrowseKind,
  ): readonly (MemberRecord | PackageRecord | TypeRecord)[] {
    if (kind === 'package') {
      return index.packages;
    }
    if (kind === 'type') {
      return index.types;
    }
    return index.members;
  }

  #memberDetail(
    documentation: TypeDocumentation,
    record: MemberRecord,
  ): MemberDocumentation | undefined {
    return documentation.members.find(
      (candidate) => candidate.anchor === record.anchor || candidate.name === record.label,
    );
  }

  async #stability(fullyQualifiedName: string): Promise<StabilityEvidence> {
    if (this.#source === undefined) {
      return {
        classification: 'public-unclassified',
        module: null,
        reason: 'No local source checkout is configured for module evidence.',
        source_revision: null,
      };
    }
    const index = await this.#source.loadIndex();
    let record: SourceTypeRecord | undefined = index.byFullyQualifiedName.get(fullyQualifiedName);
    const segments = fullyQualifiedName.split('.');
    while (record === undefined && segments.length > 1) {
      segments.pop();
      record = index.byFullyQualifiedName.get(segments.join('.'));
    }
    if (record?.stableModule !== true) {
      return {
        classification: 'public-unclassified',
        module: record?.module ?? null,
        reason:
          record === undefined
            ? 'Published Javadoc type could not be mapped to configured source.'
            : `Source module ${record.module} is not in Iceberg's RevAPI project set.`,
        source_revision: index.identity.revision ?? null,
      };
    }
    return {
      classification: 'stable-module',
      module: record.module,
      reason: `Source maps to RevAPI-checked module ${record.module}; this is evidence, not an unconditional compatibility guarantee.`,
      source_revision: index.identity.revision ?? null,
    };
  }

  #requireSource(): SourceProvider {
    if (this.#source === undefined) {
      throw new NotFoundError('Local Iceberg source is not configured');
    }
    return this.#source;
  }

  #sourceProvenance(revision: string | undefined, root: string, loadedAt: Date): Provenance {
    return {
      iceberg_version: revision ?? 'local-source',
      kind: 'source',
      retrieved_at: loadedAt.toISOString(),
      source: root,
    };
  }
}
