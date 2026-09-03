import { z } from 'zod';

import type { CatalogConfig } from '../config.js';
import { abortError, LimitError, UpstreamError } from '../shared/errors.js';
import { cancelBody, readBoundedText } from '../shared/fetch.js';
import { Secret } from '../shared/secret.js';

const oauthResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().int().min(1).optional(),
  token_type: z.string().optional(),
});

/** The longest a token is refreshed ahead of its expiry; short-lived tokens use half their life. */
const MAX_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_EXPIRES_IN_SECONDS = 3_600;

/**
 * Resolves with the shared refresh, or rejects as soon as this caller's own signal aborts. The
 * shared request keeps running for everyone else: one caller giving up must not cancel the token
 * every other caller is waiting for. Callers reject an already-aborted signal before they get here.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export interface CatalogAuthProvider {
  authorization(signal?: AbortSignal): Promise<string | undefined>;
  clear(): void;
}

class StaticAuthProvider implements CatalogAuthProvider {
  #token: Secret | undefined;

  public constructor(token: Secret | undefined) {
    this.#token = token;
  }

  public authorization(): Promise<string | undefined> {
    return Promise.resolve(this.#token === undefined ? undefined : `Bearer ${this.#token.value()}`);
  }

  public clear(): void {
    this.#token = undefined;
  }
}

class OAuthAuthProvider implements CatalogAuthProvider {
  readonly #clientId: string;
  #clientSecret: Secret | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #uri: URL;
  #cached:
    { readonly expiresAt: number; readonly header: string; readonly marginMs: number } | undefined;
  #loading: Promise<string> | undefined;

  public constructor(options: {
    credential: Secret;
    fetch?: typeof globalThis.fetch | undefined;
    timeoutMs: number;
    uri: URL;
  }) {
    const credential = options.credential.value();
    const delimiter = credential.indexOf(':');
    if (delimiter < 1 || delimiter === credential.length - 1) {
      throw new UpstreamError('OAuth credential must use client_id:client_secret form', 400, false);
    }
    this.#clientId = credential.slice(0, delimiter);
    this.#clientSecret = new Secret(credential.slice(delimiter + 1));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs;
    this.#uri = new URL(options.uri);
  }

  public authorization(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) {
      return Promise.reject(abortError(signal));
    }
    const cached = this.#cached;
    if (cached !== undefined && cached.expiresAt > Date.now() + cached.marginMs) {
      return Promise.resolve(cached.header);
    }
    const refresh = this.#refresh();
    return signal === undefined ? refresh : raceAbort(refresh, signal);
  }

  /**
   * Single-flight refresh. Concurrent callers share one token request; a failure clears the shared
   * state so the next caller starts a fresh attempt instead of replaying the same error.
   */
  #refresh(): Promise<string> {
    const inFlight = this.#loading;
    if (inFlight !== undefined) {
      return inFlight;
    }
    const loading = this.#load().finally(() => {
      if (this.#loading === loading) {
        this.#loading = undefined;
      }
    });
    // Every caller may have raced away from this promise; keep its failure from going unhandled.
    void loading.catch(() => undefined);
    this.#loading = loading;
    return loading;
  }

  public clear(): void {
    this.#cached = undefined;
    this.#clientSecret = undefined;
  }

  /** Runs under its own timeout controller only, so no caller's signal can cancel it. */
  async #load(): Promise<string> {
    if (this.#clientSecret === undefined) {
      throw new UpstreamError('OAuth provider is closed', 500, false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const body = new URLSearchParams({
        client_id: this.#clientId,
        client_secret: this.#clientSecret.value(),
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
        signal: controller.signal,
      });
      if (!response.ok) {
        cancelBody(response);
        throw new UpstreamError(
          `OAuth token endpoint returned HTTP ${response.status}`,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
      const text = await readBoundedText(response, 65_536, 'OAuth token response');
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
      const lifetimeMs = (parsed.data.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1_000;
      this.#cached = {
        expiresAt: Date.now() + lifetimeMs,
        header,
        marginMs: Math.min(MAX_REFRESH_MARGIN_MS, Math.floor(lifetimeMs / 2)),
      };
      return header;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new UpstreamError('OAuth token request timed out', 504, true, { cause: error });
      }
      if (!(error instanceof UpstreamError) && !(error instanceof LimitError)) {
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
