import { describe, expect, it, vi } from 'vitest';

import { createCatalogAuthProvider } from '../../src/catalog/auth.js';
import type { CatalogConfig } from '../../src/config.js';

function config(overrides: Partial<CatalogConfig> = {}): CatalogConfig {
  return {
    allowMutations: false,
    oauth2Credential: undefined,
    oauth2Uri: undefined,
    token: undefined,
    uri: new URL('https://catalog.example.test'),
    warehouse: undefined,
    ...overrides,
  };
}

function oauthConfig(credential = 'client:secret'): CatalogConfig {
  return config({
    oauth2Credential: credential,
    oauth2Uri: new URL('https://identity.example.test/token'),
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('catalog authentication', (): void => {
  it('supports absent and static bearer credentials and clears secrets', async (): Promise<void> => {
    const anonymous = createCatalogAuthProvider(config(), 1_000);
    expect(await anonymous.authorization()).toBeUndefined();

    const bearer = createCatalogAuthProvider(config({ token: 'catalog-secret' }), 1_000);
    expect(await bearer.authorization()).toBe('Bearer catalog-secret');
    bearer.clear();
    expect(await bearer.authorization()).toBeUndefined();
  });

  it('validates the OAuth credential shape', (): void => {
    expect(() => createCatalogAuthProvider(oauthConfig('invalid'), 1_000)).toThrow(
      /client_id:client_secret/u,
    );
    expect(() => createCatalogAuthProvider(oauthConfig(':secret'), 1_000)).toThrow(
      /client_id:client_secret/u,
    );
    expect(() => createCatalogAuthProvider(oauthConfig('client:'), 1_000)).toThrow(
      /client_id:client_secret/u,
    );
  });

  it('exchanges OAuth credentials once, encodes the form, and caches the token', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://identity.example.test/token');
      expect(request.method).toBe('POST');
      expect(request.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
      return Promise.resolve(
        json({ access_token: 'issued-secret', expires_in: 3600, token_type: 'bearer' }),
      );
    });
    const provider = createCatalogAuthProvider(oauthConfig('my-client:my:secret'), 1_000, fetch);

    const [first, concurrent] = await Promise.all([
      provider.authorization(),
      provider.authorization(),
    ]);
    const cached = await provider.authorization();

    expect(first).toBe('Bearer issued-secret');
    expect(concurrent).toBe(first);
    expect(cached).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    if (call === undefined) {
      throw new Error('OAuth fetch was not called');
    }
    const body = await new Request(call[0], call[1]).text();
    expect(body).toContain('client_id=my-client');
    expect(body).toContain('client_secret=my%3Asecret');

    provider.clear();
    await expect(provider.authorization()).rejects.toThrow(/closed/u);
  });

  it.each([
    [json({ error: 'denied' }, 401), /HTTP 401/u],
    [new Response('{'), /invalid JSON/u],
    [json({ token_type: 'Bearer' }), /invalid response/u],
    [json({ access_token: 'token', token_type: 'MAC' }), /unsupported token type/u],
  ])('rejects malformed OAuth responses %#', async (response, expected): Promise<void> => {
    const provider = createCatalogAuthProvider(oauthConfig(), 1_000, () =>
      Promise.resolve(response.clone()),
    );
    await expect(provider.authorization()).rejects.toThrow(expected);
  });

  it('bounds token bodies before parsing', async (): Promise<void> => {
    const provider = createCatalogAuthProvider(oauthConfig(), 1_000, () =>
      Promise.resolve(new Response('x'.repeat(65_537))),
    );
    await expect(provider.authorization()).rejects.toThrow(/too large/u);
  });

  it('normalizes network failures and timeouts without leaking credentials', async (): Promise<void> => {
    const failed = createCatalogAuthProvider(oauthConfig(), 1_000, () =>
      Promise.reject(new Error('network details include secret')),
    );
    await expect(failed.authorization()).rejects.toMatchObject({ retryable: true, status: 502 });

    const timedOut = createCatalogAuthProvider(oauthConfig(), 1, (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    await expect(timedOut.authorization()).rejects.toMatchObject({ retryable: true, status: 504 });
  });
});
