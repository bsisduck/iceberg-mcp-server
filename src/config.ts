import { isIP } from 'node:net';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { ConfigurationError } from './shared/errors.js';
import { DEFAULT_JAVADOC_VERSION, icebergVersionSchema } from './shared/iceberg-version.js';
import { isLogLevel, LOG_LEVELS } from './shared/logging.js';
import type { LogLevel } from './shared/logging.js';
import { Secret } from './shared/secret.js';

export { DEFAULT_JAVADOC_VERSION } from './shared/iceberg-version.js';

const DEFAULT_JAVADOC_BASE_URL = 'https://iceberg.apache.org/javadoc/';
const MAX_SECRET_BYTES = 16_384;

const transportSchema = z.enum(['stdio', 'http']);

export interface JavadocConfig {
  readonly baseUrl: URL;
  readonly version: string;
}

export interface CatalogConfig {
  readonly allowMutations: boolean;
  readonly oauth2Credential: Secret | undefined;
  readonly oauth2Uri: URL | undefined;
  readonly token: Secret | undefined;
  readonly uri: URL | undefined;
  readonly warehouse: string | undefined;
}

export interface HttpConfig {
  readonly allowedOrigins: readonly string[];
  readonly authToken: Secret | undefined;
  readonly host: string;
  readonly maxRequestBytes: number;
  readonly port: number;
}

export interface LimitsConfig {
  readonly maxResponseChars: number;
  readonly requestTimeoutMs: number;
}

export interface AppConfig {
  readonly catalog: CatalogConfig;
  readonly http: HttpConfig;
  readonly javadoc: JavadocConfig;
  readonly limits: LimitsConfig;
  readonly logLevel: LogLevel;
  readonly sourceDir: string | undefined;
  readonly transport: 'http' | 'stdio';
}

function optionalValue(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value;
}

function parseInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optionalValue(value);
  if (raw === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${name} must be an integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const raw = optionalValue(value) ?? 'info';
  if (!isLogLevel(raw)) {
    throw new ConfigurationError(`ICEBERG_MCP_LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
  }
  return raw;
}

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const raw = optionalValue(value);
  if (raw === undefined) {
    return defaultValue;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new ConfigurationError(`${name} must be true or false`);
}

/** RFC 1123 label syntax, plus the underscore that container DNS names use in practice. */
const BIND_HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/iu;
/** `::1` and its uncompressed spellings, for example `0:0:0:0:0:0:0:1`. */
const IPV6_LOOPBACK = /^(?:0*:)+0*1$/u;
/** IPv4-mapped IPv6, for example `::ffff:127.0.0.1`. */
const IPV4_MAPPED = /^(?:0*:)+ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u;

/** Strips the brackets that `URL.hostname` and operator input use around an IPv6 literal. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = unbracket(hostname).toLowerCase();
  if (normalized === 'localhost') {
    return true;
  }
  const family = isIP(normalized);
  if (family === 4) {
    return normalized.startsWith('127.');
  }
  if (family !== 6) {
    return false;
  }
  return (
    IPV6_LOOPBACK.test(normalized) || IPV4_MAPPED.exec(normalized)?.[1]?.startsWith('127.') === true
  );
}

function parseUrl(name: string, value: string, options: { httpsOutsideLoopback: boolean }): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ConfigurationError(`${name} must be an absolute URL`, { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigurationError(`${name} must use http or https`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigurationError(`${name} must not contain embedded credentials`);
  }
  if (
    options.httpsOutsideLoopback &&
    !isLoopbackHostname(parsed.hostname) &&
    parsed.protocol !== 'https:'
  ) {
    throw new ConfigurationError(`${name} must use https outside loopback`);
  }
  return parsed;
}

function parseJavadocBaseUrl(value: string | undefined): URL {
  const parsed = parseUrl(
    'ICEBERG_JAVADOC_BASE_URL',
    optionalValue(value) ?? DEFAULT_JAVADOC_BASE_URL,
    {
      httpsOutsideLoopback: true,
    },
  );
  if (parsed.protocol !== 'https:') {
    throw new ConfigurationError('ICEBERG_JAVADOC_BASE_URL must use https');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new ConfigurationError('ICEBERG_JAVADOC_BASE_URL must not contain a query or fragment');
  }
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed;
}

async function readSecret(
  env: NodeJS.ProcessEnv,
  directName: string,
  fileName: string,
): Promise<Secret | undefined> {
  const direct = optionalValue(env[directName]);
  const file = optionalValue(env[fileName]);
  if (direct !== undefined && file !== undefined) {
    throw new ConfigurationError(`${directName} and ${fileName} are mutually exclusive`);
  }
  if (direct !== undefined) {
    if (Buffer.byteLength(direct, 'utf8') > MAX_SECRET_BYTES) {
      throw new ConfigurationError(`${directName} must be at most ${MAX_SECRET_BYTES} bytes`);
    }
    return new Secret(direct);
  }
  if (file === undefined) {
    return undefined;
  }
  let metadata;
  try {
    metadata = await stat(file);
  } catch (error) {
    throw new ConfigurationError(`${fileName} is not readable`, { cause: error });
  }
  if (!metadata.isFile() || metadata.size > MAX_SECRET_BYTES) {
    throw new ConfigurationError(
      `${fileName} must reference a regular file up to ${MAX_SECRET_BYTES} bytes`,
    );
  }
  let contents: string;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    throw new ConfigurationError(`${fileName} is not readable`, { cause: error });
  }
  const secret = contents.replace(/[\r\n]+$/u, '');
  if (secret === '') {
    throw new ConfigurationError(`${fileName} must not be empty`);
  }
  return new Secret(secret);
}

function parseOrigins(value: string | undefined, port: number): readonly string[] {
  const rawOrigins = optionalValue(value)?.split(',') ?? [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
  if (rawOrigins.length > 32) {
    throw new ConfigurationError('ICEBERG_MCP_ALLOWED_ORIGINS may contain at most 32 origins');
  }
  const origins = rawOrigins.map((raw) => {
    const candidate = raw.trim();
    if (candidate === '*') {
      throw new ConfigurationError('ICEBERG_MCP_ALLOWED_ORIGINS does not support wildcards');
    }
    const parsed = parseUrl('ICEBERG_MCP_ALLOWED_ORIGINS', candidate, {
      httpsOutsideLoopback: true,
    });
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new ConfigurationError('ICEBERG_MCP_ALLOWED_ORIGINS entries must be exact origins');
    }
    return parsed.origin;
  });
  return [...new Set(origins)];
}

async function resolveSourceDir(env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
  const configured = optionalValue(env['ICEBERG_SOURCE_DIR']);
  const candidate = path.resolve(cwd, configured ?? '../iceberg');
  if (configured === undefined) {
    try {
      await access(path.join(candidate, 'api', 'src', 'main', 'java'));
    } catch {
      return undefined;
    }
  }
  let canonical: string;
  try {
    canonical = await realpath(candidate);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new Error('not a directory');
    }
    await access(path.join(canonical, 'api', 'src', 'main', 'java'));
  } catch (error) {
    throw new ConfigurationError('ICEBERG_SOURCE_DIR must be a readable Apache Iceberg checkout', {
      cause: error,
    });
  }
  return canonical;
}

/**
 * Normalizes the bind address so configuration, the loopback classification, and `server.listen`
 * all read the same value. `net.Server.listen` rejects a bracketed IPv6 literal with `ENOTFOUND`,
 * so `[::1]` is unwrapped to `::1` here; brackets around anything else are an error.
 */
function parseBoundHost(value: string | undefined): string {
  const raw = optionalValue(value) ?? '127.0.0.1';
  const unwrapped = unbracket(raw);
  const host = unwrapped.toLowerCase();
  if (isIP(host) === 6) {
    return host;
  }
  if (unwrapped !== raw || (isIP(host) === 0 && !BIND_HOSTNAME.test(host))) {
    throw new ConfigurationError('ICEBERG_MCP_HOST is not a valid bind hostname or address');
  }
  return host;
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<AppConfig> {
  // Every variable treats a blank value as unset, so a cleared entry in a client env map falls back
  // to the default instead of failing startup.
  const versionResult = icebergVersionSchema.safeParse(
    optionalValue(env['ICEBERG_JAVADOC_VERSION']) ?? DEFAULT_JAVADOC_VERSION,
  );
  if (!versionResult.success) {
    throw new ConfigurationError('ICEBERG_JAVADOC_VERSION must be a release or nightly');
  }
  const transportResult = transportSchema.safeParse(
    optionalValue(env['ICEBERG_MCP_TRANSPORT']) ?? 'stdio',
  );
  if (!transportResult.success) {
    throw new ConfigurationError('ICEBERG_MCP_TRANSPORT must be stdio or http');
  }

  const port = parseInteger('ICEBERG_MCP_PORT', env['ICEBERG_MCP_PORT'], 3000, 1, 65_535);
  const host = parseBoundHost(env['ICEBERG_MCP_HOST']);
  const allowedOrigins = parseOrigins(env['ICEBERG_MCP_ALLOWED_ORIGINS'], port);
  const authToken = await readSecret(env, 'ICEBERG_MCP_AUTH_TOKEN', 'ICEBERG_MCP_AUTH_TOKEN_FILE');
  if (transportResult.data === 'http' && !isLoopbackHostname(host)) {
    if (authToken === undefined) {
      throw new ConfigurationError('non-loopback HTTP requires ICEBERG_MCP_AUTH_TOKEN');
    }
    if (optionalValue(env['ICEBERG_MCP_ALLOWED_ORIGINS']) === undefined) {
      throw new ConfigurationError('non-loopback HTTP requires ICEBERG_MCP_ALLOWED_ORIGINS');
    }
  }

  const catalogUriValue = optionalValue(env['ICEBERG_CATALOG_URI']);
  const oauth2UriValue = optionalValue(env['ICEBERG_OAUTH2_URI']);
  const warehouse = optionalValue(env['ICEBERG_CATALOG_WAREHOUSE']);
  if (warehouse !== undefined && warehouse.length > 2_048) {
    throw new ConfigurationError('ICEBERG_CATALOG_WAREHOUSE must be at most 2048 characters');
  }

  const catalogToken = await readSecret(env, 'ICEBERG_CATALOG_TOKEN', 'ICEBERG_CATALOG_TOKEN_FILE');
  const oauth2Credential = await readSecret(
    env,
    'ICEBERG_OAUTH2_CREDENTIAL',
    'ICEBERG_OAUTH2_CREDENTIAL_FILE',
  );
  if ((oauth2UriValue === undefined) !== (oauth2Credential === undefined)) {
    throw new ConfigurationError(
      'ICEBERG_OAUTH2_URI and ICEBERG_OAUTH2_CREDENTIAL must be configured together',
    );
  }
  if (catalogToken !== undefined && oauth2Credential !== undefined) {
    throw new ConfigurationError('catalog bearer and OAuth credentials are mutually exclusive');
  }
  if (
    catalogUriValue === undefined &&
    (catalogToken !== undefined || oauth2Credential !== undefined || warehouse !== undefined)
  ) {
    throw new ConfigurationError('catalog credentials and warehouse require ICEBERG_CATALOG_URI');
  }

  return {
    catalog: {
      allowMutations: parseBoolean(
        'ICEBERG_CATALOG_ALLOW_MUTATIONS',
        env['ICEBERG_CATALOG_ALLOW_MUTATIONS'],
        false,
      ),
      oauth2Credential,
      oauth2Uri:
        oauth2UriValue === undefined
          ? undefined
          : parseUrl('ICEBERG_OAUTH2_URI', oauth2UriValue, { httpsOutsideLoopback: true }),
      token: catalogToken,
      uri:
        catalogUriValue === undefined
          ? undefined
          : parseUrl('ICEBERG_CATALOG_URI', catalogUriValue, { httpsOutsideLoopback: true }),
      warehouse,
    },
    http: {
      allowedOrigins,
      authToken,
      host,
      maxRequestBytes: parseInteger(
        'ICEBERG_MCP_MAX_REQUEST_BYTES',
        env['ICEBERG_MCP_MAX_REQUEST_BYTES'],
        1_048_576,
        4_096,
        10_485_760,
      ),
      port,
    },
    javadoc: {
      baseUrl: parseJavadocBaseUrl(env['ICEBERG_JAVADOC_BASE_URL']),
      version: versionResult.data,
    },
    limits: {
      maxResponseChars: parseInteger(
        'ICEBERG_MAX_RESPONSE_CHARS',
        env['ICEBERG_MAX_RESPONSE_CHARS'],
        30_000,
        4_096,
        100_000,
      ),
      requestTimeoutMs: parseInteger(
        'ICEBERG_REQUEST_TIMEOUT_MS',
        env['ICEBERG_REQUEST_TIMEOUT_MS'],
        15_000,
        1_000,
        120_000,
      ),
    },
    logLevel: parseLogLevel(env['ICEBERG_MCP_LOG_LEVEL']),
    sourceDir: await resolveSourceDir(env, cwd),
    transport: transportResult.data,
  };
}

export function isLoopbackHost(host: string): boolean {
  return isLoopbackHostname(host);
}

/**
 * `Host` header spelling of a bind address. IPv6 literals are bracketed in `Host` and in the SDK's
 * allowed-hostname list, while IPv4 addresses and names are not.
 */
export function hostHeaderName(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}
