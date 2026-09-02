import { z } from 'zod';

export const DEFAULT_JAVADOC_VERSION = '1.11.0';
export const MAX_ICEBERG_VERSION_LENGTH = 100;
export const ICEBERG_VERSION_PATTERN = /^(?:nightly|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

export function isIcebergVersion(value: string): boolean {
  return value.length <= MAX_ICEBERG_VERSION_LENGTH && ICEBERG_VERSION_PATTERN.test(value);
}

export const icebergVersionSchema = z
  .string()
  .max(MAX_ICEBERG_VERSION_LENGTH)
  .regex(ICEBERG_VERSION_PATTERN, 'must be a release or nightly');
