import { z } from 'zod';

import type { CatalogConfig } from '../config.js';
import { UpstreamError } from '../shared/errors.js';

const oauthResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  token_type: z.string().optional(),
});

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let length = 0;
  let result = await reader.read();
  while (!result.done) {
    length += result.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new UpstreamError('OAuth token response is too large', 502, false);
    }
    chunks.push(result.value);
    result = await reader.read();
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

export interface CatalogAuthProvider {
  authorization(signal?: AbortSignal): Promise<string | undefined>;
  clear(): void;
}

class StaticAuthProvider implements CatalogAuthProvider {
  #token: string | undefined;

  public constructor(token: string | undefined) {
    this.#token = token;
  }

  public authorization(): Promise<string | undefined> {
    return Promise.resolve(this.#token === undefined ? undefined : `Bearer ${this.#token}`);
  }

  public clear(): void {
    this.#token = undefined;
  }
}

class OAuthAuthProvider implements CatalogAuthProvider {
  readonly #clientId: string;
  #clientSecret: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #uri: URL;
  #cached: { readonly expiresAt: number; readonly header: string } | undefined;
  #loading: Promise<string> | undefined;

  public constructor(options: {
    credential: string;
    fetch?: typeof globalThis.fetch | undefined;
    timeoutMs: number;
    uri: URL;
  }) {
    const delimiter = options.credential.indexOf(':');
    if (delimiter < 1 || delimiter === options.credential.length - 1) {
      throw new UpstreamError('OAuth credential must use client_id:client_secret form', 400, false);
    }
    this.#clientId = options.credential.slice(0, delimiter);
    this.#clientSecret = options.credential.slice(delimiter + 1);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs;
    this.#uri = new URL(options.uri);
  }

  public async authorization(signal?: AbortSignal): Promise<string> {
    if (this.#cached !== undefined && this.#cached.expiresAt > Date.now() + 60_000) {
      return this.#cached.header;
    }
    this.#loading ??= this.#load(signal).finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  public clear(): void {
    this.#cached = undefined;
    this.#clientSecret = undefined;
  }

  async #load(signal: AbortSignal | undefined): Promise<string> {
    if (this.#clientSecret === undefined) {
      throw new UpstreamError('OAuth provider is closed', 500, false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const combined =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    try {
      const body = new URLSearchParams({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        grant_type: 'client_credentials',
        scope: 'catalog',
      });
      const response = await this.#fetch(this.#uri, {
        body,
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
        redirect: 'error',
        signal: combined,
      });
      if (!response.ok) {
        if (response.body !== null) {
          void response.body.cancel().catch(() => undefined);
        }
        throw new UpstreamError(
          `OAuth token endpoint returned HTTP ${response.status}`,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
      const text = await readLimitedText(response, 65_536);
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
      if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
        throw new UpstreamError(
          'OAuth token endpoint returned an unexpected content type',
          502,
          false,
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch (error) {
        throw new UpstreamError('OAuth token endpoint returned invalid JSON', 502, false, {
          cause: error,
        });
      }
      const parsed = oauthResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new UpstreamError('OAuth token endpoint returned an invalid response', 502, false);
      }
      const tokenType = parsed.data.token_type ?? 'Bearer';
      if (tokenType.toLowerCase() !== 'bearer') {
        throw new UpstreamError(
          'OAuth token endpoint returned an unsupported token type',
          502,
          false,
        );
      }
      const header = `Bearer ${parsed.data.access_token}`;
      this.#cached = {
        expiresAt: Date.now() + (parsed.data.expires_in ?? 3_600) * 1_000,
        header,
      };
      return header;
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new UpstreamError('OAuth token request timed out', 504, true, { cause: error });
      }
      if (!(error instanceof UpstreamError)) {
        throw new UpstreamError('OAuth token request failed', 502, true, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createCatalogAuthProvider(
  config: CatalogConfig,
  timeoutMs: number,
  fetch?: typeof globalThis.fetch,
): CatalogAuthProvider {
  if (config.oauth2Uri !== undefined && config.oauth2Credential !== undefined) {
    return new OAuthAuthProvider({
      credential: config.oauth2Credential,
      fetch,
      timeoutMs,
      uri: config.oauth2Uri,
    });
  }
  return new StaticAuthProvider(config.token);
}
