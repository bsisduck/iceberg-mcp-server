import { createRequire } from 'node:module';

import { z } from 'zod';

const packageSchema = z.object({
  engines: z.object({ node: z.string().optional() }).optional(),
  name: z.string().min(1),
  version: z.string().min(1),
});

// package.json sits one level above both src/ (tsx, vitest) and dist/ (tsc output), so the same
// relative path resolves in every runtime layout without importing JSON through the compiler.
const packageJson = packageSchema.parse(createRequire(import.meta.url)('../package.json'));

export const SERVER_NAME = packageJson.name;
export const SERVER_VERSION = packageJson.version;
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

/** The published `engines.node` range, for example `>=20.19.0`. */
export const NODE_ENGINE_RANGE = packageJson.engines?.node;

/**
 * Lowest runtime the package claims to support, taken from `NODE_ENGINE_RANGE` so the requirement
 * is never restated as a second literal. `undefined` when the manifest declares no range.
 */
export const MINIMUM_NODE_VERSION = /\d+(?:\.\d+){0,2}/u.exec(NODE_ENGINE_RANGE ?? '')?.[0];

/** Leading dotted-numeric part of a version, so a suffix such as `-nightly` is ignored. */
function versionOrder(version: string): readonly number[] {
  const numeric = /^\d+(?:\.\d+)*/u.exec(version)?.[0];
  return numeric === undefined ? [] : numeric.split('.').map(Number);
}

/**
 * Whether a runtime satisfies the declared minimum. Only the lower bound is compared: `engines`
 * here is a simple `>=` range, and an unparsable runtime version is accepted rather than blocking
 * an unusual build.
 */
export function isSupportedNodeVersion(version: string = process.versions.node): boolean {
  if (MINIMUM_NODE_VERSION === undefined) {
    return true;
  }
  const running = versionOrder(version);
  if (running.length === 0) {
    return true;
  }
  const minimum = versionOrder(MINIMUM_NODE_VERSION);
  for (let index = 0; index < minimum.length; index += 1) {
    const left = running[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return true;
}
