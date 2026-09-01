import { describe, expect, it } from 'vitest';

import { CLIENT_IDS, isClientId, renderClientSetup } from '../../src/client-config.js';

const options = {
  javadocVersion: '1.11.0',
  serverPath: '/opt/iceberg mcp/dist/cli.js',
  sourceDir: "/opt/team's iceberg",
} as const;

describe('client configuration rendering', (): void => {
  it('recognizes every supported client identifier', (): void => {
    expect(CLIENT_IDS).toHaveLength(7);
    for (const client of CLIENT_IDS) {
      expect(isClientId(client)).toBe(true);
    }
    expect(isClientId('unknown')).toBe(false);
  });

  it('renders copy-safe commands for CLI-managed clients', (): void => {
    const codex = renderClientSetup({ ...options, client: 'codex' });
    const claude = renderClientSetup({ ...options, client: 'claude-code' });
    const gemini = renderClientSetup({ ...options, client: 'gemini-cli' });

    expect(codex).toMatch(/^codex mcp add iceberg /u);
    expect(claude).toMatch(/^claude mcp add --scope user --transport stdio iceberg /u);
    expect(gemini).toMatch(/^gemini mcp add --scope user --transport stdio /u);
    for (const command of [codex, claude, gemini]) {
      expect(command).toContain("'/opt/iceberg mcp/dist/cli.js'");
      expect(command).toContain("'ICEBERG_SOURCE_DIR=/opt/team'\"'\"'s iceberg'");
      expect(command).not.toMatch(/TOKEN|SECRET|CREDENTIAL/u);
    }
  });

  it('renders client-native JSON shapes', (): void => {
    const openCode = JSON.parse(renderClientSetup({ ...options, client: 'opencode' })) as Record<
      string,
      unknown
    >;
    const vsCode = JSON.parse(renderClientSetup({ ...options, client: 'vscode' })) as Record<
      string,
      unknown
    >;
    const cursor = JSON.parse(renderClientSetup({ ...options, client: 'cursor' })) as Record<
      string,
      unknown
    >;
    const generic = JSON.parse(renderClientSetup({ ...options, client: 'generic-json' })) as Record<
      string,
      unknown
    >;

    expect(openCode).toHaveProperty('mcp.servers.iceberg.type', 'local');
    expect(vsCode).toHaveProperty('servers.iceberg.type', 'stdio');
    expect(cursor).toHaveProperty('mcpServers.iceberg.type', 'stdio');
    expect(generic).toHaveProperty('mcpServers.iceberg.command', 'node');
  });

  it('validates paths and the Javadoc version before rendering', (): void => {
    expect(() =>
      renderClientSetup({ ...options, client: 'codex', serverPath: 'dist/cli.js' }),
    ).toThrow(/serverPath must be absolute/u);
    expect(() => renderClientSetup({ ...options, client: 'codex', sourceDir: 'iceberg' })).toThrow(
      /sourceDir must be absolute/u,
    );
    expect(() =>
      renderClientSetup({ ...options, client: 'codex', javadocVersion: 'latest' }),
    ).toThrow(/release semver or nightly/u);
  });
});
