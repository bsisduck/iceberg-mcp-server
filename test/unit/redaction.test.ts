import { describe, expect, it } from 'vitest';

import { REDACTED, isSensitiveKey, redactSecrets, redactText } from '../../src/shared/redaction.js';

describe('sensitive key detection', (): void => {
  it.each([
    // Generic credential names in kebab, snake, dotted, and camel forms.
    'token',
    'tokens',
    'Token',
    'access_token',
    'accessToken',
    'refresh-token',
    'secret',
    'secrets',
    'client-secret',
    'client_secret',
    'clientSecret',
    'credential',
    'credentials',
    'storage-credentials',
    'password',
    'passwords',
    'passwd',
    'passphrase',
    'authorization',
    'Authorization',
    'private-key',
    'privateKey',
    'api-key',
    'api_key',
    'apikey',
    'apiKey',
    'x-api-key',
    'account-key',
    'accountKey',
    'shared-key',
    'connection-string',
    'connectionString',
    'signing-key',
    'encryption-key',
    'decryption-key',
    // Iceberg storage and client properties.
    's3.access-key',
    's3.access-key-id',
    's3.secret-access-key',
    's3.session-token',
    's3.sse.key',
    'client.credential',
    'azure.account-key',
    'adls.auth.shared-key.account.key',
    'adls.connection-string.myaccount',
    'adls.sas-token.myaccount',
    'adls.sas-token-expires-at-ms.myaccount',
    'adls.token',
    'gcs.oauth2.token',
    'gcs.client-lib-token',
    'gcs.encryption-key',
    'gcs.decryption-key',
    'ICEBERG_CATALOG_TOKEN',
    'ICEBERG_OAUTH2_CREDENTIAL',
  ])('redacts %s', (key): void => {
    expect(isSensitiveKey(key)).toBe(true);
    expect(redactSecrets({ [key]: 'private' })).toEqual({ [key]: REDACTED });
  });

  it.each([
    // Ordinary metadata.
    'prefix',
    'region',
    'warehouse',
    'namespace',
    'tokenized_name',
    'tokenizer',
    'secretary',
    'keyword',
    'key',
    'key-id',
    'idempotency-key-lifetime',
    'idempotency_key_lifetime',
    'oauth2-server-uri',
    'oauth2-server-uri.example',
    // Descriptions of a credential rather than the credential itself.
    'token-refresh-enabled',
    'token_type',
    'token-endpoint',
    'token-url',
    'client.credentials-provider',
    'client.refresh-credentials-enabled',
    'adls.refresh-credentials-endpoint',
    'adls.token-credential-provider',
    'adls.auth.shared-key.account.name',
    'gcs.oauth2.token-expires-at',
    's3.session-token-expires-at-ms',
    'secret-lifetime',
    'password-type',
  ])('keeps %s visible', (key): void => {
    expect(isSensitiveKey(key)).toBe(false);
    expect(redactSecrets({ [key]: 'visible' })).toEqual({ [key]: 'visible' });
  });

  it('redacts nested objects and arrays while preserving structure', (): void => {
    const redacted = redactSecrets({
      config: {
        'client.credentials-provider': 'org.example.Provider',
        'client.credential': 'client:secret',
        's3.access-key-id': 'AKIA',
        's3.secret-access-key': 'secret',
      },
      'storage-credentials': [{ config: { 's3.session-token': 'private' }, prefix: 's3://bucket' }],
      tables: [{ name: 'events', properties: { 'gcs.oauth2.token': 'private' } }],
    });

    expect(redacted).toEqual({
      config: {
        'client.credentials-provider': 'org.example.Provider',
        'client.credential': REDACTED,
        's3.access-key-id': REDACTED,
        's3.secret-access-key': REDACTED,
      },
      'storage-credentials': REDACTED,
      tables: [{ name: 'events', properties: { 'gcs.oauth2.token': REDACTED } }],
    });
    expect(JSON.stringify(redacted)).not.toMatch(/private|AKIA|secret"/u);
    expect(redactSecrets('plain')).toBe('plain');
    expect(redactSecrets(null)).toBeNull();
  });
});

describe('free-text redaction', (): void => {
  it.each([
    ['Bearer abc.def-ghi=', `Bearer ${REDACTED}`],
    ['authorization: bearer abc', `authorization: ${REDACTED}`],
    ['Authorization=Bearer abc', `Authorization=${REDACTED}`],
    ['Basic dXNlcjpwYXNz', `Basic ${REDACTED}`],
    ['https://user:pass@catalog.example.test/v1', `https://${REDACTED}@catalog.example.test/v1`],
    ['ICEBERG_CATALOG_TOKEN=abc123 failed', `ICEBERG_CATALOG_TOKEN=${REDACTED} failed`],
    [
      'client_secret=xyz&grant_type=client_credentials',
      `client_secret=${REDACTED}&grant_type=client_credentials`,
    ],
    ['{"token":"abc","region":"eu"}', `{"token":${REDACTED},"region":"eu"}`],
    ["error at s3.secret-access-key: 'abc'", `error at s3.secret-access-key: ${REDACTED}`],
    [
      'token_type=bearer token-refresh-enabled=true',
      'token_type=bearer token-refresh-enabled=true',
    ],
    ['Catalog returned HTTP 503', 'Catalog returned HTTP 503'],
    ['region=eu-central-1 prefix=s3://warehouse', 'region=eu-central-1 prefix=s3://warehouse'],
  ])('rewrites %j', (input, expected): void => {
    expect(redactText(input)).toBe(expected);
  });

  it('bounds the rewritten text', (): void => {
    const output = redactText(`token=${'x'.repeat(10_000)}`);

    expect(output.length).toBeLessThanOrEqual(4_097 + REDACTED.length);
    expect(output).not.toContain('xxxx');
  });
});
