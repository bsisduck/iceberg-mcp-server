const SENSITIVE_KEY =
  /(?:^|[-_.])(access[-_.]?key|authorization|client[-_.]?secret|credential|password|private[-_.]?key|secret|session[-_.]?token|token)(?:$|[-_.])/iu;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSecrets(nested),
      ]),
    );
  }
  return value;
}
