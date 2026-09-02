import { describe, expect, it } from 'vitest';

import {
  DEFAULT_JAVADOC_VERSION,
  ICEBERG_VERSION_PATTERN,
  MAX_ICEBERG_VERSION_LENGTH,
  icebergVersionSchema,
  isIcebergVersion,
} from '../../src/shared/iceberg-version.js';

describe('Iceberg version identifiers', (): void => {
  it.each([
    '1.11.0',
    '1.10.1',
    '2.0.0-rc.1',
    '1.12.0-SNAPSHOT',
    'nightly',
    DEFAULT_JAVADOC_VERSION,
  ])('accepts %s', (value): void => {
    expect(isIcebergVersion(value)).toBe(true);
    expect(ICEBERG_VERSION_PATTERN.test(value)).toBe(true);
    expect(icebergVersionSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    '',
    'latest',
    'Nightly',
    '1.11',
    '1.11.0.1',
    'v1.11.0',
    '1.11.0 ',
    '../nightly',
    '1.11.0/../',
    '1.11.0-',
    '1.11.0-rc_1',
    `1.11.0-${'a'.repeat(MAX_ICEBERG_VERSION_LENGTH)}`,
  ])('rejects %j', (value): void => {
    expect(isIcebergVersion(value)).toBe(false);
    expect(icebergVersionSchema.safeParse(value).success).toBe(false);
  });

  it('bounds identifier length even when the pattern would match', (): void => {
    const long = `1.11.0-${'a'.repeat(MAX_ICEBERG_VERSION_LENGTH)}`;

    expect(ICEBERG_VERSION_PATTERN.test(long)).toBe(true);
    expect(isIcebergVersion(long)).toBe(false);
    expect(icebergVersionSchema.safeParse(long).success).toBe(false);
  });

  it('keeps the shared default a valid release', (): void => {
    expect(DEFAULT_JAVADOC_VERSION).toBe('1.11.0');
    expect(isIcebergVersion(DEFAULT_JAVADOC_VERSION)).toBe(true);
  });
});
