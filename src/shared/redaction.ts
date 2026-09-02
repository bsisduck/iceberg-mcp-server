export const REDACTED = '[REDACTED]';

/**
 * Key segments (split on `-`, `_`, `.`, and camelCase boundaries) whose values are credentials.
 * The list covers generic names plus the Iceberg storage-credential properties: `s3.access-key-id`,
 * `s3.secret-access-key`, `s3.session-token`, `s3.sse.key`, `client.credential`,
 * `azure.account-key`, `adls.auth.shared-key.account.key`, `adls.connection-string.<account>`,
 * `adls.sas-token.<account>`, `gcs.oauth2.token`, and `gcs.encryption-key`.
 */
const SENSITIVE_KEY =
  /(?:^|[-_.])(?:access[-_.]?key|account[-_.]?key|api[-_.]?key|authorization|client[-_.]?secret|connection[-_.]?string|credentials?|decryption[-_.]?key|encryption[-_.]?key|passphrase|passwd|passwords?|private[-_.]?key|secrets?|shared[-_.]?key|signing[-_.]?key|sse[-_.]?key|tokens?)(?:$|[-_.])/iu;

/**
 * Keys that describe a credential rather than carry one: feature flags, endpoints, provider class
 * names, token types, lifetimes, and expiry timestamps. `token-refresh-enabled`,
 * `client.credentials-provider`, `gcs.oauth2.token-expires-at`, and `token_type` stay visible.
 * Suffixes such as `-id` are deliberately not exempt, so `s3.access-key-id` remains redacted.
 */
const METADATA_SUFFIX =
  /(?:^|[-_.])(?:enabled|endpoint|expiration|expires[-_.]at(?:[-_.]ms)?|impl|lifetime|name|provider|type|uri|url)$/iu;

const TEXT_MAX_CHARS = 4_096;
const AUTH_SCHEME = /(^|[\s"':,])(bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]+/giu;
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/gu;
const KEY_VALUE =
  /(["']?)([A-Za-z0-9_.-]{1,128})\1(\s*[=:]\s*)(["']?)((?:(?:bearer|basic|digest)\s+)?[^\s,;&"']+)\4/giu;

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/gu, '$1-$2');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY.test(normalized) && !METADATA_SUFFIX.test(normalized);
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactSecrets(nested),
      ]),
    );
  }
  return value;
}

/**
 * Redact credential material embedded in free text such as error messages and stack traces:
 * `Bearer`/`Basic` authorization values, URL userinfo, and `key=value` or `"key": "value"` pairs
 * whose key is sensitive. Output is bounded so a hostile message cannot flood a log line.
 */
export function redactText(text: string): string {
  const bounded = text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}…` : text;
  return bounded
    .replace(AUTH_SCHEME, `$1$2 ${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(KEY_VALUE, (match, quote: string, key: string, separator: string) =>
      isSensitiveKey(key) ? `${quote}${key}${quote}${separator}${REDACTED}` : match,
    );
}
