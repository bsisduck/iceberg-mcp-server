import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/server';

import {
  ConfigurationError,
  InputError,
  LimitError,
  NotFoundError,
  UpstreamError,
  errorMessage,
} from './errors.js';
import type { ErrorReporter } from './logging.js';

export interface ToolErrorBody {
  readonly error: {
    readonly correlation_id: string | null;
    readonly message: string;
    readonly retryable: boolean;
    readonly status: number | null;
    readonly type: string;
  };
}

function expectedError(error: unknown): boolean {
  return (
    error instanceof ConfigurationError ||
    error instanceof InputError ||
    error instanceof LimitError ||
    error instanceof NotFoundError ||
    error instanceof UpstreamError
  );
}

function errorBody(error: unknown, reporter: ErrorReporter): ToolErrorBody {
  const expected = expectedError(error);
  const correlationId = expected ? null : randomUUID();
  if (!expected) {
    reporter.report(error, `tool call ${correlationId}`);
  }
  return {
    error: {
      correlation_id: correlationId,
      message: expected ? errorMessage(error) : 'Internal error',
      retryable: error instanceof UpstreamError && error.retryable,
      status: error instanceof UpstreamError ? error.status : null,
      type: error instanceof Error && expected ? error.name : 'InternalError',
    },
  };
}

export async function executeTool<T extends object>(
  operation: () => Promise<T>,
  render: (result: T) => string,
  reporter: ErrorReporter,
): Promise<CallToolResult> {
  try {
    const result = await operation();
    return {
      content: [{ type: 'text', text: render(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const result = errorBody(error, reporter);
    return {
      content: [{ type: 'text', text: `Error: ${result.error.message}` }],
      isError: true,
      structuredContent: result as unknown as Record<string, unknown>,
    };
  }
}
