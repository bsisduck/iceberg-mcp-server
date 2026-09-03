import { execFile } from 'node:child_process';
import { open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { InputError, LimitError, NotFoundError } from '../shared/errors.js';
import type { SourceIdentity, SourceIndex, SourceTypeRecord } from './types.js';

const execFileAsync = promisify(execFile);
const JAVA_FILE_LIMIT = 10_000;
const JAVA_FILE_MAX_BYTES = 2_000_000;
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
const REVAPI_RELATIVE_PATH = path.join('.palantir', 'revapi.yml');
const REVAPI_MAX_BYTES = 4_000_000;
/** Maven coordinates of the modules RevAPI checks, for example `org.apache.iceberg:iceberg-core:`. */
const REVAPI_MODULE_PATTERN = /(?:^|\s)org\.apache\.iceberg:iceberg-([a-z0-9][a-z0-9-]*)\s*:/gmu;
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

async function gitValue(root: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function sourceIdentity(root: string): Promise<SourceIdentity> {
  const [revision, branch] = await Promise.all([
    gitValue(root, ['rev-parse', 'HEAD']),
    gitValue(root, ['branch', '--show-current']),
  ]);
  return { branch, revision, root };
}

function isWithinRoot(root: string, filename: string): boolean {
  return filename.startsWith(`${root}${path.sep}`);
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

export class SourceProvider {
  readonly #root: string;
  #indexPromise: Promise<SourceIndex> | undefined;

  private constructor(root: string) {
    this.#root = root;
  }

  public static async create(root: string): Promise<SourceProvider> {
    return new SourceProvider(await realpath(root));
  }

  public clear(): void {
    this.#indexPromise = undefined;
  }

  public loadIndex(): Promise<SourceIndex> {
    this.#indexPromise ??= this.#buildIndex();
    return this.#indexPromise;
  }

  public async getType(
    fullyQualifiedName: string,
    startLine = 1,
    lineCount = 200,
  ): Promise<SourceWindow> {
    const index = await this.loadIndex();
    const record = this.#resolveRecord(index, fullyQualifiedName);
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

  public async search(literal: string, limit = 50, offset = 0): Promise<SourceMatchPage> {
    if (literal.length < 2 || literal.length > 200) {
      throw new LimitError('Source search literal must contain 2 to 200 characters');
    }
    const index = await this.loadIndex();
    const boundedLimit = Math.min(limit, 200);
    const matches: SourceMatch[] = [];
    let seen = 0;
    for (const record of index.files) {
      const source = await readJavaFile(this.#root, path.join(this.#root, record.relativePath));
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
  ): Promise<SourceMatchPage> {
    const simpleName = fullyQualifiedName.split('.').at(-1);
    if (simpleName === undefined) {
      throw new NotFoundError(`Java type not found: ${fullyQualifiedName}`);
    }
    const index = await this.loadIndex();
    const target = this.#resolveRecord(index, fullyQualifiedName);
    if (!target.declarationNames.includes(simpleName)) {
      throw new NotFoundError(`Java source type not found: ${fullyQualifiedName}`);
    }
    const escapedName = simpleName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const declaration = new RegExp(
      `\\b(?:extends|implements)\\s+[^\\n{;]*\\b${escapedName}\\b`,
      'u',
    );
    const boundedLimit = Math.min(limit, 200);
    const matches: SourceMatch[] = [];
    let seen = 0;
    for (const record of index.files) {
      const source = await readJavaFile(this.#root, path.join(this.#root, record.relativePath));
      const originalLines = source.split(/\r?\n/u);
      const lines = stripCommentsAndStrings(source).split(/\r?\n/u);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? '';
        const match = declaration.exec(line);
        if (match !== null) {
          if (seen >= offset) {
            matches.push({
              column: match.index + 1,
              fullyQualifiedName: record.fullyQualifiedName,
              line: lineIndex + 1,
              module: record.module,
              preview: originalLines[lineIndex]?.trim().slice(0, 500) ?? '',
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

  async #buildIndex(): Promise<SourceIndex> {
    const records: SourceTypeRecord[] = [];
    const stableModules = await readStableModules(this.#root);
    let fileCount = 0;
    for await (const { filename, module } of javaFiles(this.#root)) {
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
      });
    }
    records.sort((left, right) => left.fullyQualifiedName.localeCompare(right.fullyQualifiedName));
    return {
      byFullyQualifiedName: new Map(records.map((record) => [record.fullyQualifiedName, record])),
      files: records,
      identity: await sourceIdentity(this.#root),
      loadedAt: new Date(),
      stableModules,
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
