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

export class UpstreamError extends Error {
  public readonly retryable: boolean;
  public readonly status: number;

  public constructor(message: string, status: number, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown error occurred';
}
