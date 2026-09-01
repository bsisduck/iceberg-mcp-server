import type { CatalogOperationId } from './operations.js';

export interface CatalogDiscovery {
  readonly defaults: Readonly<Record<string, string>>;
  readonly endpoints: ReadonlySet<string>;
  readonly idempotencyKeyLifetime: string | undefined;
  readonly merged: Readonly<Record<string, string>>;
  readonly namespaceSeparator: string;
  readonly overrides: Readonly<Record<string, string>>;
  readonly prefix: string;
  readonly retrievedAt: Date;
}

export interface CatalogCall {
  readonly body?: unknown;
  readonly cursor?: string | undefined;
  readonly operationId: CatalogOperationId;
  readonly path: Readonly<Record<string, string | readonly string[]>>;
  readonly query?:
    Readonly<Record<string, boolean | number | string | readonly string[] | undefined>> | undefined;
}

export interface CatalogResult {
  readonly data: unknown;
  readonly next_cursor: string | null;
  readonly operation_id: CatalogOperationId;
  readonly status: number;
}
