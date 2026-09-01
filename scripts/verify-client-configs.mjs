import { CLIENT_IDS, renderClientSetup } from '../dist/client-config.js';

const options = {
  javadocVersion: '1.11.0',
  serverPath: '/opt/iceberg-mcp-server/dist/cli.js',
  sourceDir: '/opt/iceberg',
};

const rendered = Object.fromEntries(
  CLIENT_IDS.map((client) => [client, renderClientSetup({ ...options, client })]),
);

for (const client of ['opencode', 'vscode', 'cursor', 'generic-json']) {
  JSON.parse(rendered[client]);
}

const expectedPrefixes = {
  'claude-code': 'claude mcp add ',
  codex: 'codex mcp add ',
  'gemini-cli': 'gemini mcp add ',
};
for (const [client, prefix] of Object.entries(expectedPrefixes)) {
  if (!rendered[client].startsWith(prefix)) {
    throw new Error(`${client} setup does not start with ${prefix}`);
  }
}

for (const [client, output] of Object.entries(rendered)) {
  if (!output.includes(options.serverPath) || !output.includes(options.sourceDir)) {
    throw new Error(`${client} setup omitted an absolute runtime path`);
  }
  if (/TOKEN|SECRET|CREDENTIAL/u.test(output)) {
    throw new Error(`${client} setup unexpectedly contains a secret-bearing field`);
  }
}

process.stdout.write(`Client configuration templates verified: ${CLIENT_IDS.length} clients\n`);
