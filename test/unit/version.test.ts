import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SERVER_NAME, SERVER_VERSION, USER_AGENT } from '../../src/version.js';

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../package.json',
);

describe('server identity', (): void => {
  it('reads the single published name and version from package.json', async (): Promise<void> => {
    const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      name: string;
      version: string;
    };

    expect(SERVER_NAME).toBe(manifest.name);
    expect(SERVER_VERSION).toBe(manifest.version);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('derives the outbound User-Agent from the same identity', (): void => {
    expect(USER_AGENT).toBe(`${SERVER_NAME}/${SERVER_VERSION}`);
    expect(USER_AGENT).toMatch(/^[a-z0-9-]+\/\d+\.\d+\.\d+/u);
  });
});
