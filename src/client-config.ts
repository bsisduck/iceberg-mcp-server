import path from 'node:path';

export const CLIENT_IDS = [
  'codex',
  'claude-code',
  'opencode',
  'gemini-cli',
  'vscode',
  'cursor',
  'generic-json',
] as const;

export type ClientId = (typeof CLIENT_IDS)[number];

export interface ClientSetupOptions {
  readonly client: ClientId;
  readonly javadocVersion: string;
  readonly serverPath: string;
  readonly sourceDir?: string;
}

const VERSION_PATTERN = /^(?:nightly|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

function validateOptions(options: ClientSetupOptions): void {
  if (!path.isAbsolute(options.serverPath)) {
    throw new Error('serverPath must be absolute');
  }
  if (options.sourceDir !== undefined && !path.isAbsolute(options.sourceDir)) {
    throw new Error('sourceDir must be absolute');
  }
  if (!VERSION_PATTERN.test(options.javadocVersion)) {
    throw new Error('javadocVersion must be a release semver or nightly');
  }
}

function environment(options: ClientSetupOptions): Record<string, string> {
  return {
    ...(options.sourceDir === undefined ? {} : { ICEBERG_SOURCE_DIR: options.sourceDir }),
    ICEBERG_JAVADOC_VERSION: options.javadocVersion,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function environmentFlags(
  values: Readonly<Record<string, string>>,
  flag: '--env' | '-e',
): string[] {
  return Object.entries(values).flatMap(([key, value]) => [flag, shellQuote(`${key}=${value}`)]);
}

function renderCodex(options: ClientSetupOptions): string {
  return [
    'codex',
    'mcp',
    'add',
    'iceberg',
    ...environmentFlags(environment(options), '--env'),
    '--',
    'node',
    shellQuote(options.serverPath),
  ].join(' ');
}

function renderClaudeCode(options: ClientSetupOptions): string {
  return [
    'claude',
    'mcp',
    'add',
    '--scope',
    'user',
    '--transport',
    'stdio',
    'iceberg',
    ...environmentFlags(environment(options), '--env'),
    '--',
    'node',
    shellQuote(options.serverPath),
  ].join(' ');
}

function renderGeminiCli(options: ClientSetupOptions): string {
  return [
    'gemini',
    'mcp',
    'add',
    '--scope',
    'user',
    '--transport',
    'stdio',
    ...environmentFlags(environment(options), '-e'),
    'iceberg',
    'node',
    shellQuote(options.serverPath),
  ].join(' ');
}

function renderOpenCode(options: ClientSetupOptions): string {
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        servers: {
          iceberg: {
            command: ['node', options.serverPath],
            environment: environment(options),
            type: 'local',
          },
        },
      },
    },
    undefined,
    2,
  );
}

function renderVsCode(options: ClientSetupOptions): string {
  return JSON.stringify(
    {
      servers: {
        iceberg: {
          args: [options.serverPath],
          command: 'node',
          env: environment(options),
          type: 'stdio',
        },
      },
    },
    undefined,
    2,
  );
}

function renderCursor(options: ClientSetupOptions): string {
  return JSON.stringify(
    {
      mcpServers: {
        iceberg: {
          args: [options.serverPath],
          command: 'node',
          env: environment(options),
          type: 'stdio',
        },
      },
    },
    undefined,
    2,
  );
}

function renderGenericJson(options: ClientSetupOptions): string {
  return JSON.stringify(
    {
      mcpServers: {
        iceberg: {
          args: [options.serverPath],
          command: 'node',
          env: environment(options),
        },
      },
    },
    undefined,
    2,
  );
}

export function renderClientSetup(options: ClientSetupOptions): string {
  validateOptions(options);
  switch (options.client) {
    case 'codex':
      return renderCodex(options);
    case 'claude-code':
      return renderClaudeCode(options);
    case 'opencode':
      return renderOpenCode(options);
    case 'gemini-cli':
      return renderGeminiCli(options);
    case 'vscode':
      return renderVsCode(options);
    case 'cursor':
      return renderCursor(options);
    case 'generic-json':
      return renderGenericJson(options);
  }
}
