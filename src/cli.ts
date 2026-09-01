#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { installShutdownHandlers, startRuntime } from './runtime.js';
import { SERVER_VERSION } from './server.js';
import { errorMessage } from './shared/errors.js';
import { stderrReporter } from './shared/logging.js';

export const USAGE = `Apache Iceberg MCP Server ${SERVER_VERSION}

Usage: iceberg-mcp-server [options]

Options:
  --transport <stdio|http>  Override ICEBERG_MCP_TRANSPORT
  --help                    Show this help
  --version                 Show the server version
`;

export interface CliOptions {
  readonly command: 'help' | 'start' | 'version';
  readonly transport: 'http' | 'stdio' | undefined;
}

export function parseArgs(args: readonly string[]): CliOptions {
  let command: CliOptions['command'] = 'start';
  let transport: CliOptions['transport'];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      command = 'help';
    } else if (argument === '--version' || argument === '-v') {
      command = 'version';
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
  return { command, transport };
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
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`iceberg-mcp-server: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
