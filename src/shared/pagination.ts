import { createHash } from 'node:crypto';

import { z } from 'zod';

import { InputError } from './errors.js';

const MAX_CURSOR_LENGTH = 2_048;
const cursorSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  offset: z.number().int().min(0),
  version: z.literal(1),
});
const tokenCursorSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  token: z.string().max(16_384),
  version: z.literal(1),
});

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function queryDigest(query: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(query)))
    .digest('hex');
}

export function encodeCursor(offset: number, query: unknown): string {
  return Buffer.from(
    JSON.stringify({ digest: queryDigest(query), offset, version: 1 }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, query: unknown): number {
  if (cursor === undefined) {
    return 0;
  }
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new InputError('Cursor is malformed');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch (error) {
    throw new InputError('Cursor is malformed', { cause: error });
  }
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success || parsed.data.digest !== queryDigest(query)) {
    throw new InputError('Cursor does not match this query');
  }
  return parsed.data.offset;
}

export function encodeTokenCursor(token: string, query: unknown): string {
  return Buffer.from(
    JSON.stringify({ digest: queryDigest(query), token, version: 1 }),
    'utf8',
  ).toString('base64url');
}

export function decodeTokenCursor(cursor: string | undefined, query: unknown): string {
  if (cursor === undefined) {
    return '';
  }
  if (cursor.length > 24_000 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new InputError('Cursor is malformed');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch (error) {
    throw new InputError('Cursor is malformed', { cause: error });
  }
  const parsed = tokenCursorSchema.safeParse(value);
  if (!parsed.success || parsed.data.digest !== queryDigest(query)) {
    throw new InputError('Cursor does not match this query');
  }
  return parsed.data.token;
}

export interface Page<T> {
  readonly hasMore: boolean;
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
}

export function paginate<T>(
  items: readonly T[],
  offset: number,
  limit: number,
  query: unknown,
): Page<T> {
  if (offset > items.length) {
    throw new InputError('Cursor points beyond the available results');
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < items.length;
  return {
    hasMore,
    items: page,
    nextCursor: hasMore ? encodeCursor(nextOffset, query) : undefined,
  };
}
