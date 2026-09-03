export class ConfigurationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

export class InputError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InputError';
  }
}

export class NotFoundError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NotFoundError';
  }
}

export class LimitError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LimitError';
  }
}

export class CapabilityError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CapabilityError';
  }
}

/**
 * The caller went away: an `AbortSignal` from the client or the transport aborted before the work
 * finished. Cancellation is never retryable, because nobody is waiting for a second attempt.
 */
export class CancelledError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CancelledError';
  }
}

export class UpstreamError extends Error {
  public readonly retryable: boolean;
  public readonly status: number;
  public readonly upstreamCode: number | null;
  public readonly upstreamType: string | null;

  public constructor(
    message: string,
    status: number,
    retryable: boolean,
    options?: ErrorOptions,
    details?: { readonly code?: number | undefined; readonly type?: string | undefined },
  ) {
    super(message, options);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
    this.upstreamCode = details?.code ?? null;
    this.upstreamType = details?.type ?? null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown error occurred';
}
