export class ConfigurationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown error occurred';
}
