import { execFile } from 'node:child_process';
import { open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { LimitError, NotFoundError } from '../shared/errors.js';
import type { SourceIdentity, SourceIndex, SourceTypeRecord } from './types.js';

const execFileAsync = promisify(execFile);
const JAVA_FILE_LIMIT = 10_000;
const JAVA_FILE_MAX_BYTES = 2_000_000;
const STABLE_MODULES = new Set(['api', 'common', 'core', 'data', 'orc', 'parquet']);
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

async function* javaFiles(root: string): AsyncGenerator<string> {
  const modules = await opendir(root);
  for await (const moduleEntry of modules) {
    if (!moduleEntry.isDirectory() || moduleEntry.isSymbolicLink()) {
      continue;
    }
    const javaRoot = path.join(root, moduleEntry.name, 'src', 'main', 'java');
    let rootDirectory;
    try {
      rootDirectory = await opendir(javaRoot);
    } catch {
      continue;
    }
    const directories = [rootDirectory];
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory === undefined) {
        break;
      }
      for await (const entry of directory) {
        if (entry.isSymbolicLink()) {
          continue;
        }
        const entryPath = path.join(directory.path, entry.name);
        if (entry.isDirectory()) {
          directories.push(await opendir(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.java')) {
          const canonical = await realpath(entryPath);
          if (!isWithinRoot(root, canonical)) {
            throw new LimitError('Source file escaped the configured checkout');
          }
          yield canonical;
        }
      }
    }
  }
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

  public async search(literal: string, limit = 50): Promise<readonly SourceMatch[]> {
    if (literal.length < 2 || literal.length > 200) {
      throw new LimitError('Source search literal must contain 2 to 200 characters');
    }
    const index = await this.loadIndex();
    const matches: SourceMatch[] = [];
    for (const record of index.files) {
      const source = await readJavaFile(this.#root, path.join(this.#root, record.relativePath));
      const lines = source.split(/\r?\n/u);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? '';
        const column = line.indexOf(literal);
        if (column !== -1) {
          matches.push({
            column: column + 1,
            fullyQualifiedName: record.fullyQualifiedName,
            line: lineIndex + 1,
            module: record.module,
            preview: line.trim().slice(0, 500),
            relativePath: record.relativePath,
          });
          if (matches.length >= Math.min(limit, 200)) {
            return matches;
          }
        }
      }
    }
    return matches;
  }

  public async findImplementations(
    fullyQualifiedName: string,
    limit = 100,
  ): Promise<readonly SourceMatch[]> {
    const simpleName = fullyQualifiedName.split('.').at(-1);
    if (simpleName === undefined) {
      throw new NotFoundError(`Java type not found: ${fullyQualifiedName}`);
    }
    const index = await this.loadIndex();
    const declaration = new RegExp(
      `\\b(?:extends|implements)\\s+[^\\n{;]*\\b${simpleName}\\b`,
      'u',
    );
    const matches: SourceMatch[] = [];
    for (const record of index.files) {
      const source = await readJavaFile(this.#root, path.join(this.#root, record.relativePath));
      const originalLines = source.split(/\r?\n/u);
      const lines = stripCommentsAndStrings(source).split(/\r?\n/u);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? '';
        const match = declaration.exec(line);
        if (match !== null) {
          matches.push({
            column: match.index + 1,
            fullyQualifiedName: record.fullyQualifiedName,
            line: lineIndex + 1,
            module: record.module,
            preview: originalLines[lineIndex]?.trim().slice(0, 500) ?? '',
            relativePath: record.relativePath,
          });
          if (matches.length >= Math.min(limit, 200)) {
            return matches;
          }
        }
      }
    }
    return matches;
  }

  async #buildIndex(): Promise<SourceIndex> {
    const records: SourceTypeRecord[] = [];
    let fileCount = 0;
    for await (const filename of javaFiles(this.#root)) {
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
      const module = relativePath.split(path.sep, 1)[0] ?? '';
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
        stableModule: STABLE_MODULES.has(module),
      });
    }
    records.sort((left, right) => left.fullyQualifiedName.localeCompare(right.fullyQualifiedName));
    return {
      byFullyQualifiedName: new Map(records.map((record) => [record.fullyQualifiedName, record])),
      files: records,
      identity: await sourceIdentity(this.#root),
      loadedAt: new Date(),
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
