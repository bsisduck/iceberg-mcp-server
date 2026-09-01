#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CLIENT_IDS, isClientId, renderClientSetup } from './client-config.js';
import { loadConfig } from './config.js';
import { installShutdownHandlers, startRuntime } from './runtime.js';
import { SERVER_VERSION } from './server.js';
import { errorMessage } from './shared/errors.js';
import { stderrReporter } from './shared/logging.js';

export const USAGE = `Apache Iceberg MCP Server ${SERVER_VERSION}

Usage: iceberg-mcp-server [options]
       iceberg-mcp-server --print-client-config <client> [setup options]

Options:
  --transport <stdio|http>       Override ICEBERG_MCP_TRANSPORT
  --print-client-config <client> Print a non-mutating local setup command or JSON
  --server-path <absolute-path>  Server entry path used in generated client setup
  --source-dir <absolute-path>   Optional Iceberg checkout in generated client setup
  --javadoc-version <version>    Generated setup version (default: 1.11.0)
  --help                         Show this help
  --version                      Show the server version

Clients: ${CLIENT_IDS.join(', ')}
`;

export interface CliOptions {
  readonly client: (typeof CLIENT_IDS)[number] | undefined;
  readonly command: 'client-config' | 'help' | 'start' | 'version';
  readonly javadocVersion: string;
  readonly serverPath: string | undefined;
  readonly sourceDir: string | undefined;
  readonly transport: 'http' | 'stdio' | undefined;
}

export function isMainModule(entryPath: string | undefined, moduleUrl: string): boolean {
  if (entryPath === undefined) {
    return false;
  }
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return pathToFileURL(entryPath).href === moduleUrl;
  }
}

export function parseArgs(args: readonly string[]): CliOptions {
  let command: CliOptions['command'] = 'start';
  let client: CliOptions['client'];
  let javadocVersion = '1.11.0';
  let serverPath: string | undefined;
  let sourceDir: string | undefined;
  let transport: CliOptions['transport'];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      command = 'help';
    } else if (argument === '--version' || argument === '-v') {
      command = 'version';
    } else if (argument === '--print-client-config') {
      const value = args[index + 1];
      if (value === undefined || !isClientId(value)) {
        throw new Error(`--print-client-config must be one of: ${CLIENT_IDS.join(', ')}`);
      }
      client = value;
      command = 'client-config';
      index += 1;
    } else if (argument === '--server-path') {
      const value = args[index + 1];
      if (value === undefined || !path.isAbsolute(value)) {
        throw new Error('--server-path must be an absolute path');
      }
      serverPath = value;
      index += 1;
    } else if (argument === '--source-dir') {
      const value = args[index + 1];
      if (value === undefined || !path.isAbsolute(value)) {
        throw new Error('--source-dir must be an absolute path');
      }
      sourceDir = value;
      index += 1;
    } else if (argument === '--javadoc-version') {
      const value = args[index + 1];
      if (value === undefined || !/^(?:nightly|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.test(value)) {
        throw new Error('--javadoc-version must be a release semver or nightly');
      }
      javadocVersion = value;
      index += 1;
    } else if (argument === '--transport') {
      const value = args[index + 1];
      if (value !== 'stdio' && value !== 'http') {
        throw new Error('--transport must be stdio or http');
      }
      transport = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument ?? ''}`);
    }
  }
  const hasSetupOption =
    serverPath !== undefined || sourceDir !== undefined || javadocVersion !== '1.11.0';
  if (command !== 'client-config' && hasSetupOption) {
    throw new Error('Client setup options require --print-client-config');
  }
  if (command === 'client-config' && transport !== undefined) {
    throw new Error('--transport cannot be combined with --print-client-config');
  }
  return { client, command, javadocVersion, serverPath, sourceDir, transport };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options.command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (options.command === 'version') {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (options.command === 'client-config') {
    if (options.client === undefined) {
      throw new Error('Client setup requires --print-client-config');
    }
    const entryPath = options.serverPath ?? process.argv[1];
    if (entryPath === undefined) {
      throw new Error('Cannot resolve the server entry path; pass --server-path');
    }
    process.stdout.write(
      `${renderClientSetup({
        client: options.client,
        javadocVersion: options.javadocVersion,
        serverPath: realpathSync(entryPath),
        ...(options.sourceDir === undefined ? {} : { sourceDir: options.sourceDir }),
      })}\n`,
    );
    return;
  }
  const env = { ...process.env };
  if (options.transport !== undefined) {
    env['ICEBERG_MCP_TRANSPORT'] = options.transport;
  }
  const config = await loadConfig(env);
  const handle = await startRuntime(config, stderrReporter);
  installShutdownHandlers(handle, stderrReporter);
  if (handle.address !== undefined) {
    process.stderr.write(`Iceberg MCP server listening at ${handle.address.href}\n`);
  }
}

const entryPath = process.argv[1];
if (isMainModule(entryPath, import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`iceberg-mcp-server: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
