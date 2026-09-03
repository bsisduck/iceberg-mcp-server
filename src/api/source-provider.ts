import { open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { CancelledError, InputError, LimitError, NotFoundError } from '../shared/errors.js';
import type {
  SourceIdentity,
  SourceIndex,
  SourceIndexStamp,
  SourceTypeRecord,
  SuperTypeReference,
} from './types.js';

const JAVA_FILE_LIMIT = 10_000;
const JAVA_FILE_MAX_BYTES = 2_000_000;
/**
 * How much source text the index may hold so a literal search runs from memory. The Apache Iceberg
 * checkout's production sources are about 20 MB, so the default keeps all of them and still leaves
 * room for a larger fork. Counted in characters, which equals bytes for ASCII source.
 */
export const DEFAULT_SOURCE_INDEX_MAX_BYTES = 64_000_000;
/** Production sources live under `<module>/src/main/java`, at any depth below the checkout root. */
const JAVA_SOURCE_SEGMENTS = ['src', 'main', 'java'] as const;
/** Build output, tooling state, and version control never contain indexable production sources. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.gradle',
  '.idea',
  'build',
  'node_modules',
  'out',
  'target',
]);
/** Used when the checkout carries no `.palantir/revapi.yml` to derive the RevAPI project set from. */
const STABLE_MODULES: ReadonlySet<string> = new Set([
  'api',
  'common',
  'core',
  'data',
  'orc',
  'parquet',
]);
const GIT_FILE_MAX_BYTES = 1_000_000;
const GIT_BRANCH_PREFIX = 'refs/heads/';
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{7,64}$/u;
const GIT_SYMBOLIC_REF_PATTERN = /^ref:\s*(refs\/[\w./-]+)$/u;
const REVAPI_RELATIVE_PATH = path.join('.palantir', 'revapi.yml');
const REVAPI_MAX_BYTES = 4_000_000;
/** Maven coordinates of the modules RevAPI checks, for example `org.apache.iceberg:iceberg-core:`. */
const REVAPI_MODULE_PATTERN = /(?:^|\s)org\.apache\.iceberg:iceberg-([a-z0-9][a-z0-9-]*)\s*:/gmu;
/** A declaration line names at most this many supertypes; the rest of the file is still indexed. */
const SUPER_TYPE_REFERENCE_LIMIT = 200;
const PREVIEW_MAX_CHARS = 500;
const SUPER_TYPE_KEYWORD_PATTERN = /\b(?:extends|implements)\b/gu;
/** A supertype clause ends at the class body, the statement end, or a field initializer. */
const SUPER_TYPE_TERMINATOR_PATTERN = /[{;=]/u;
const SIMPLE_NAME_PATTERN = /^[A-Za-z_$][\w$]*$/u;
const packagePattern = /^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/mu;
const declarationPattern =
  /(?:^|\s)(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+|strictfp\s+)*(?:@interface|class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/gmu;

export interface SourceWindow {
  readonly endLine: number;
  readonly fullyQualifiedName: string;
  readonly lines: readonly string[];
  readonly module: string;
  readonly relativePath: string;
  readonly revision: string | undefined;
  readonly stableModule: boolean;
  readonly startLine: number;
}

export interface SourceMatch {
  readonly column: number;
  readonly fullyQualifiedName: string;
  readonly line: number;
  readonly module: string;
  readonly preview: string;
  readonly relativePath: string;
}

export interface SourceMatchPage {
  readonly hasMore: boolean;
  readonly items: readonly SourceMatch[];
}

function stripCommentsAndStrings(source: string): string {
  let output = '';
  let index = 0;
  let state: 'block' | 'char' | 'code' | 'line' | 'string' | 'text-block' = 'code';
  while (index < source.length) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (state === 'code') {
      if (current === '/' && next === '/') {
        state = 'line';
        output += '  ';
        index += 2;
        continue;
      }
      if (current === '/' && next === '*') {
        state = 'block';
        output += '  ';
        index += 2;
        continue;
      }
      if (current === '"' && source.slice(index, index + 3) === '"""') {
        state = 'text-block';
        output += '   ';
        index += 3;
        continue;
      }
      if (current === '"') {
        state = 'string';
        output += ' ';
        index += 1;
        continue;
      }
      if (current === "'") {
        state = 'char';
        output += ' ';
        index += 1;
        continue;
      }
      output += current;
      index += 1;
      continue;
    }
    if (state === 'line') {
      if (current === '\n') {
        state = 'code';
        output += '\n';
      } else {
        output += ' ';
      }
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        state = 'code';
        output += '  ';
        index += 2;
      } else {
        output += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (state === 'text-block') {
      if (source.slice(index, index + 3) === '"""') {
        state = 'code';
        output += '   ';
        index += 3;
      } else {
        output += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (current === '\\') {
      output += '  ';
      index += 2;
      continue;
    }
    const terminator = state === 'string' ? '"' : "'";
    if (current === terminator) {
      state = 'code';
    }
    output += current === '\n' ? '\n' : ' ';
    index += 1;
  }
  return output;
}

/** Reads one small file below `.git`. Anything unreadable, oversized, or absent reads as unknown. */
async function readGitFile(
  gitDir: string,
  segments: readonly string[],
): Promise<string | undefined> {
  try {
    const handle = await open(path.join(gitDir, ...segments), 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > GIT_FILE_MAX_BYTES) {
        return undefined;
      }
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** `<object id> <ref>` lines, the fallback for a branch with no loose ref file. */
function packedRevision(packedRefs: string | undefined, ref: string): string | undefined {
  for (const line of packedRefs?.split('\n') ?? []) {
    const [revision, name] = line.trim().split(/\s+/u);
    if (name === ref && revision !== undefined && GIT_OBJECT_ID_PATTERN.test(revision)) {
      return revision;
    }
  }
  return undefined;
}

interface GitHead {
  readonly branch: string | undefined;
  /** Whatever `HEAD` resolved to, used to notice that the checkout moved. */
  readonly head: string | undefined;
  readonly revision: string | undefined;
}

/**
 * Reads `.git/HEAD` and the ref it names directly. Running `git` would mean spawning a process on a
 * path the operator configured, on every index build, so the two files are read instead.
 */
async function readGitHead(root: string): Promise<GitHead> {
  const gitDir = path.join(root, '.git');
  const head = (await readGitFile(gitDir, ['HEAD']))?.trim();
  if (head === undefined || head === '') {
    return { branch: undefined, head: undefined, revision: undefined };
  }
  const ref = GIT_SYMBOLIC_REF_PATTERN.exec(head)?.[1];
  if (ref === undefined) {
    return {
      branch: undefined,
      head,
      revision: GIT_OBJECT_ID_PATTERN.test(head) ? head : undefined,
    };
  }
  const segments = ref.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { branch: undefined, head, revision: undefined };
  }
  const revision =
    (await readGitFile(gitDir, segments))?.trim() ??
    packedRevision(await readGitFile(gitDir, ['packed-refs']), ref);
  return {
    branch: ref.startsWith(GIT_BRANCH_PREFIX) ? ref.slice(GIT_BRANCH_PREFIX.length) : undefined,
    head,
    revision: revision !== undefined && GIT_OBJECT_ID_PATTERN.test(revision) ? revision : undefined,
  };
}

interface CheckoutState {
  readonly identity: SourceIdentity;
  readonly stamp: SourceIndexStamp;
}

async function readCheckoutState(root: string): Promise<CheckoutState> {
  const [git, metadata] = await Promise.all([readGitHead(root), stat(root).catch(() => undefined)]);
  return {
    identity: { branch: git.branch, revision: git.revision, root },
    stamp: { head: git.revision ?? git.head, rootModifiedMs: metadata?.mtimeMs ?? 0 },
  };
}

function sameStamp(left: SourceIndexStamp, right: SourceIndexStamp): boolean {
  return left.head === right.head && left.rootModifiedMs === right.rootModifiedMs;
}

function isWithinRoot(root: string, filename: string): boolean {
  return filename.startsWith(`${root}${path.sep}`);
}

/**
 * Stops a scan the caller no longer waits for. Checked per file so a cancelled request releases the
 * checkout instead of walking it to the end.
 */
function assertNotCancelled(signal: AbortSignal | undefined, action: string): void {
  if (signal?.aborted === true) {
    throw new CancelledError(`Source ${action} was cancelled`);
  }
}

interface DirectoryListing {
  readonly directories: readonly string[];
  readonly files: readonly string[];
}

interface JavaSourceFile {
  readonly filename: string;
  readonly module: string;
}

/**
 * One directory level: the sub-directories worth descending into and the Java files in it. Symbolic
 * links are never followed, and an unreadable directory is reported as empty rather than failing the
 * whole walk. The handle is closed by iterating it to the end, so the walk holds one at a time.
 */
async function readDirectory(directory: string): Promise<DirectoryListing> {
  const directories: string[] = [];
  const files: string[] = [];
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    return { directories, files };
  }
  for await (const entry of handle) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        directories.push(entryPath);
      }
    } else if (entry.isFile() && entry.name.endsWith('.java')) {
      files.push(entryPath);
    }
  }
  return { directories, files };
}

function relativeSegments(root: string, directory: string): readonly string[] {
  const relative = path.relative(root, directory);
  return relative === '' ? [] : relative.split(path.sep);
}

function isJavaSourceRoot(segments: readonly string[]): boolean {
  const offset = segments.length - JAVA_SOURCE_SEGMENTS.length;
  return (
    offset > 0 &&
    JAVA_SOURCE_SEGMENTS.every((segment, index) => segments[offset + index] === segment)
  );
}

/** `spark/v3.5/spark/src/main/java` identifies the module `spark/v3.5/spark`. */
function moduleName(segments: readonly string[]): string {
  return segments.slice(0, -JAVA_SOURCE_SEGMENTS.length).join('/');
}

async function* javaFilesUnder(
  root: string,
  javaRoot: string,
  module: string,
): AsyncGenerator<JavaSourceFile> {
  const pending: string[] = [javaRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    const listing = await readDirectory(current);
    for (const file of listing.files) {
      const canonical = await realpath(file);
      if (!isWithinRoot(root, canonical)) {
        throw new LimitError('Source file escaped the configured checkout');
      }
      yield { filename: canonical, module };
    }
    pending.push(...listing.directories);
  }
}

/**
 * Every `src/main/java` root in the checkout, at any depth. Iceberg keeps the engine integrations
 * most callers ask about in versioned sub-modules such as `spark/v3.5/spark`, so a walk that only
 * looked at `<root>/<module>/src/main/java` missed roughly two thirds of the production sources.
 */
async function* javaFiles(root: string): AsyncGenerator<JavaSourceFile> {
  const pending: string[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    const segments = relativeSegments(root, current);
    if (isJavaSourceRoot(segments)) {
      yield* javaFilesUnder(root, current, moduleName(segments));
      continue;
    }
    const listing = await readDirectory(current);
    for (const child of listing.directories) {
      // A production source root is always `src/main/java`, so no sibling of `main` — `src/test`,
      // `src/jmh`, `src/integration` — can hold one.
      if (segments.at(-1) === 'src' && path.basename(child) !== 'main') {
        continue;
      }
      pending.push(child);
    }
  }
}

/**
 * The modules Iceberg's RevAPI configuration checks for binary compatibility, read from the
 * checkout's own `.palantir/revapi.yml` (`org.apache.iceberg:iceberg-core:` names the `core`
 * module). Falls back to the built-in list when the file is missing, unreadable, oversized, or
 * carries no recognisable coordinates.
 */
async function readStableModules(root: string): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    const handle = await open(path.join(root, REVAPI_RELATIVE_PATH), 'r');
    try {
      const metadata = await handle.stat();
      if (metadata.size > REVAPI_MAX_BYTES) {
        return STABLE_MODULES;
      }
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return STABLE_MODULES;
  }
  const modules = new Set(
    [...text.matchAll(REVAPI_MODULE_PATTERN)].map((match) => match[1] ?? '').filter(Boolean),
  );
  return modules.size > 0 ? modules : STABLE_MODULES;
}

/**
 * Angle-bracket nesting depth of `line` up to `end`. A `>` never takes the depth below zero, so an
 * arrow (`->`) or a comparison in the same line cannot make a later keyword look nested.
 */
function angleDepth(line: string, end: number): number {
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    const character = line[index];
    if (character === '<') {
      depth += 1;
    } else if (character === '>' && depth > 0) {
      depth -= 1;
    }
  }
  return depth;
}

/**
 * The simple type names named by one `extends`/`implements` clause: generic arguments and package
 * qualifiers are dropped, so `extends Foo<Name>` names `Foo`, `extends org.apache.iceberg.Name` and
 * `extends Name<T>` both name `Name`, and `implements A, Name` names both.
 */
function clauseTypeNames(clause: string): readonly string[] {
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < clause.length; index += 1) {
    const character = clause[index];
    if (character === '<') {
      depth += 1;
    } else if (character === '>' && depth > 0) {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(clause.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(clause.slice(start));
  for (const part of parts) {
    const head = part.trim().split('<', 1)[0]?.trim().split(/\s+/u).at(-1) ?? '';
    const simple = head.split('.').at(-1) ?? '';
    if (SIMPLE_NAME_PATTERN.test(simple)) {
      names.push(simple);
    }
  }
  return names;
}

/**
 * Every `extends`/`implements` clause on one comment- and string-stripped line, parsed into the
 * simple type names it declares. A keyword inside angle brackets is a generic bound
 * (`<T extends Name>`), not a supertype, so only depth-zero keywords open a clause.
 */
function superTypeClauses(line: string): readonly { column: number; names: readonly string[] }[] {
  const keywords: { end: number; start: number }[] = [];
  for (const match of line.matchAll(SUPER_TYPE_KEYWORD_PATTERN)) {
    if (angleDepth(line, match.index) === 0) {
      keywords.push({ end: match.index + match[0].length, start: match.index });
    }
  }
  const clauses: { column: number; names: readonly string[] }[] = [];
  for (const [position, keyword] of keywords.entries()) {
    const limit = keywords[position + 1]?.start ?? line.length;
    const text = line.slice(keyword.end, limit);
    const terminator = text.search(SUPER_TYPE_TERMINATOR_PATTERN);
    const names = clauseTypeNames(terminator === -1 ? text : text.slice(0, terminator));
    if (names.length > 0) {
      clauses.push({ column: keyword.start + 1, names });
    }
  }
  return clauses;
}

function superTypeReferences(
  strippedLines: readonly string[],
  rawLines: readonly string[],
): readonly SuperTypeReference[] {
  const references: SuperTypeReference[] = [];
  for (const [index, line] of strippedLines.entries()) {
    if (!line.includes('extends') && !line.includes('implements')) {
      continue;
    }
    for (const clause of superTypeClauses(line)) {
      references.push({
        column: clause.column,
        line: index + 1,
        names: clause.names,
        preview: rawLines[index]?.trim().slice(0, PREVIEW_MAX_CHARS) ?? '',
      });
      if (references.length >= SUPER_TYPE_REFERENCE_LIMIT) {
        return references;
      }
    }
  }
  return references;
}

async function readJavaFile(root: string, filename: string): Promise<string> {
  const canonical = await realpath(filename);
  if (!isWithinRoot(root, canonical)) {
    throw new LimitError('Source file escaped the configured checkout');
  }
  const handle = await open(canonical, 'r');
  try {
    const metadata = await handle.stat();
    if (metadata.size > JAVA_FILE_MAX_BYTES) {
      throw new LimitError(`Java source exceeds ${JAVA_FILE_MAX_BYTES} bytes`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export interface SourceProviderOptions {
  /** Ceiling on the source text the index keeps in memory. `0` reads every file from disk. */
  readonly indexMaxBytes?: number | undefined;
}

export class SourceProvider {
  readonly #indexMaxBytes: number;
  readonly #root: string;
  #indexPromise: Promise<SourceIndex> | undefined;
  #stamp: SourceIndexStamp | undefined;

  private constructor(root: string, indexMaxBytes: number) {
    this.#indexMaxBytes = indexMaxBytes;
    this.#root = root;
  }

  public static async create(
    root: string,
    options: SourceProviderOptions = {},
  ): Promise<SourceProvider> {
    return new SourceProvider(
      await realpath(root),
      options.indexMaxBytes ?? DEFAULT_SOURCE_INDEX_MAX_BYTES,
    );
  }

  public clear(): void {
    this.#indexPromise = undefined;
    this.#stamp = undefined;
  }

  /** Drops the current index and builds it again, whatever the checkout looks like. */
  public async refresh(signal?: AbortSignal): Promise<SourceIndex> {
    this.clear();
    return this.loadIndex(signal);
  }

  /**
   * The cached index, rebuilt when the checkout's `HEAD` or root directory changed since it was
   * built. Reading the two small Git files costs far less than the scan they guard.
   */
  public async loadIndex(signal?: AbortSignal): Promise<SourceIndex> {
    const state = await readCheckoutState(this.#root);
    if (this.#stamp !== undefined && !sameStamp(this.#stamp, state.stamp)) {
      this.#indexPromise = undefined;
    }
    if (this.#indexPromise === undefined) {
      this.#stamp = state.stamp;
      const build = this.#buildIndex(state, signal);
      this.#indexPromise = build;
      // A cancelled or failed scan must not poison the provider: drop it so the next call rebuilds.
      void build.catch(() => {
        if (this.#indexPromise === build) {
          this.#indexPromise = undefined;
          this.#stamp = undefined;
        }
      });
    }
    return this.#indexPromise;
  }

  public async getType(
    fullyQualifiedName: string,
    startLine = 1,
    lineCount = 200,
    signal?: AbortSignal,
  ): Promise<SourceWindow> {
    const index = await this.loadIndex(signal);
    const record = this.#resolveRecord(index, fullyQualifiedName);
    assertNotCancelled(signal, 'window');
    const source = await readJavaFile(this.#root, path.join(this.#root, record.relativePath));
    const allLines = source.split(/\r?\n/u);
    const boundedStart = Math.max(1, Math.min(startLine, Math.max(1, allLines.length)));
    const boundedCount = Math.max(1, Math.min(lineCount, 500));
    const lines = allLines.slice(boundedStart - 1, boundedStart - 1 + boundedCount);
    return {
      endLine: boundedStart + lines.length - 1,
      fullyQualifiedName,
      lines,
      module: record.module,
      relativePath: record.relativePath,
      revision: index.identity.revision,
      stableModule: record.stableModule,
      startLine: boundedStart,
    };
  }

  public async search(
    literal: string,
    limit = 50,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<SourceMatchPage> {
    if (literal.length < 2 || literal.length > 200) {
      throw new LimitError('Source search literal must contain 2 to 200 characters');
    }
    const index = await this.loadIndex(signal);
    const boundedLimit = Math.min(limit, 200);
    const matches: SourceMatch[] = [];
    let seen = 0;
    for (const record of index.files) {
      assertNotCancelled(signal, 'search');
      const source = await this.#sourceText(index, record);
      const lines = source.split(/\r?\n/u);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? '';
        const column = line.indexOf(literal);
        if (column !== -1) {
          if (seen >= offset) {
            matches.push({
              column: column + 1,
              fullyQualifiedName: record.fullyQualifiedName,
              line: lineIndex + 1,
              module: record.module,
              preview: line.trim().slice(0, 500),
              relativePath: record.relativePath,
            });
          }
          seen += 1;
          if (matches.length > boundedLimit) {
            return { hasMore: true, items: matches.slice(0, boundedLimit) };
          }
        }
      }
    }
    if (offset > seen) {
      throw new InputError('Cursor points beyond the available source matches');
    }
    return { hasMore: false, items: matches };
  }

  public async findImplementations(
    fullyQualifiedName: string,
    limit = 100,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<SourceMatchPage> {
    const simpleName = fullyQualifiedName.split('.').at(-1);
    if (simpleName === undefined) {
      throw new NotFoundError(`Java type not found: ${fullyQualifiedName}`);
    }
    const index = await this.loadIndex(signal);
    const target = this.#resolveRecord(index, fullyQualifiedName);
    if (!target.declarationNames.includes(simpleName)) {
      throw new NotFoundError(`Java source type not found: ${fullyQualifiedName}`);
    }
    const boundedLimit = Math.min(limit, 200);
    const matches: SourceMatch[] = [];
    let seen = 0;
    for (const record of index.files) {
      assertNotCancelled(signal, 'implementation scan');
      for (const reference of record.superTypes) {
        if (!reference.names.includes(simpleName)) {
          continue;
        }
        if (seen >= offset) {
          matches.push({
            column: reference.column,
            fullyQualifiedName: record.fullyQualifiedName,
            line: reference.line,
            module: record.module,
            preview: reference.preview,
            relativePath: record.relativePath,
          });
        }
        seen += 1;
        if (matches.length > boundedLimit) {
          return { hasMore: true, items: matches.slice(0, boundedLimit) };
        }
      }
    }
    if (offset > seen) {
      throw new InputError('Cursor points beyond the available source matches');
    }
    return { hasMore: false, items: matches };
  }

  #sourceText(index: SourceIndex, record: SourceTypeRecord): Promise<string> {
    const cached = index.sources.get(record.relativePath);
    return cached === undefined
      ? readJavaFile(this.#root, path.join(this.#root, record.relativePath))
      : Promise.resolve(cached);
  }

  async #buildIndex(state: CheckoutState, signal: AbortSignal | undefined): Promise<SourceIndex> {
    const records: SourceTypeRecord[] = [];
    const sources = new Map<string, string>();
    const stableModules = await readStableModules(this.#root);
    let cachedCharacters = 0;
    let fileCount = 0;
    for await (const { filename, module } of javaFiles(this.#root)) {
      assertNotCancelled(signal, 'index build');
      fileCount += 1;
      if (fileCount > JAVA_FILE_LIMIT) {
        throw new LimitError(`Source checkout contains more than ${JAVA_FILE_LIMIT} Java files`);
      }
      const source = await readJavaFile(this.#root, filename);
      const stripped = stripCommentsAndStrings(source);
      const packageName = packagePattern.exec(stripped)?.[1];
      if (packageName === undefined) {
        continue;
      }
      const relativePath = path.relative(this.#root, filename);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new LimitError('Source file escaped the configured checkout');
      }
      const topLevelName = path.basename(filename, '.java');
      if (!/^[A-Za-z_$][\w$]*$/u.test(topLevelName)) {
        continue;
      }
      const declarationNames = [...stripped.matchAll(declarationPattern)].map(
        (match) => match[1] ?? '',
      );
      records.push({
        declarationNames,
        fullyQualifiedName: `${packageName}.${topLevelName}`,
        module,
        packageName,
        relativePath,
        stableModule: stableModules.has(module),
        superTypes: superTypeReferences(stripped.split(/\r?\n/u), source.split(/\r?\n/u)),
      });
      if (cachedCharacters + source.length <= this.#indexMaxBytes) {
        sources.set(relativePath, source);
        cachedCharacters += source.length;
      }
    }
    records.sort((left, right) => left.fullyQualifiedName.localeCompare(right.fullyQualifiedName));
    return {
      byFullyQualifiedName: new Map(records.map((record) => [record.fullyQualifiedName, record])),
      files: records,
      identity: state.identity,
      loadedAt: new Date(),
      sources,
      stableModules,
      stamp: state.stamp,
    };
  }

  #resolveRecord(index: SourceIndex, fullyQualifiedName: string): SourceTypeRecord {
    const direct = index.byFullyQualifiedName.get(fullyQualifiedName);
    if (direct !== undefined) {
      return direct;
    }
    const segments = fullyQualifiedName.split('.');
    while (segments.length > 1) {
      segments.pop();
      const outer = index.byFullyQualifiedName.get(segments.join('.'));
      if (outer !== undefined) {
        return outer;
      }
    }
    throw new NotFoundError(`Java source type not found: ${fullyQualifiedName}`);
  }
}
