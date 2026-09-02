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
