import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isSupportedNodeVersion,
  MINIMUM_NODE_VERSION,
  NODE_ENGINE_RANGE,
  SERVER_NAME,
  SERVER_VERSION,
  USER_AGENT,
} from '../../src/version.js';

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

describe('supported Node runtime', (): void => {
  it('takes the requirement from the package manifest, not a second literal', async (): Promise<void> => {
    const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      engines?: { node?: string };
    };

    expect(NODE_ENGINE_RANGE).toBe(manifest.engines?.node);
    expect(MINIMUM_NODE_VERSION).toBeDefined();
    expect(NODE_ENGINE_RANGE).toContain(MINIMUM_NODE_VERSION);
  });

  it('accepts the declared minimum and anything newer', (): void => {
    const [major = 0, minor = 0, patch = 0] = (MINIMUM_NODE_VERSION ?? '')
      .split('.')
      .map((part) => Number(part));

    expect(isSupportedNodeVersion(`${major}.${minor}.${patch}`)).toBe(true);
    expect(isSupportedNodeVersion(`${major}.${minor}.${patch + 1}`)).toBe(true);
    expect(isSupportedNodeVersion(`${major}.${minor + 1}.0`)).toBe(true);
    expect(isSupportedNodeVersion(`${major + 1}.0.0`)).toBe(true);
    expect(isSupportedNodeVersion(process.versions.node)).toBe(true);
  });

  it('rejects an older runtime and accepts an unparsable one', (): void => {
    const [major = 0, minor = 0] = (MINIMUM_NODE_VERSION ?? '')
      .split('.')
      .map((part) => Number(part));

    expect(isSupportedNodeVersion(`${major - 1}.99.99`)).toBe(false);
    expect(isSupportedNodeVersion(`${major}.${minor - 1}.99`)).toBe(false);
    expect(isSupportedNodeVersion(`${major}`)).toBe(false);
    expect(isSupportedNodeVersion('unknown')).toBe(true);
  });
});
