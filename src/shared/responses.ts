import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/server';

import {
  ConfigurationError,
  CapabilityError,
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
    readonly iceberg_code: number | null;
    readonly iceberg_type: string | null;
    readonly message: string;
    readonly retryable: boolean;
    readonly status: number | null;
    readonly type: string;
  };
}

function expectedError(error: unknown): boolean {
  return (
    error instanceof ConfigurationError ||
    error instanceof CapabilityError ||
    error instanceof InputError ||
    error instanceof LimitError ||
    error instanceof NotFoundError ||
    error instanceof UpstreamError
  );
}

function errorBody(error: unknown, reporter: ErrorReporter): ToolErrorBody {
  const expected = expectedError(error);
  const correlationId = expected ? null : randomUUID();
  if (correlationId !== null) {
    reporter.report(error, 'tool.call', correlationId);
  }
  return {
    error: {
      correlation_id: correlationId,
      iceberg_code: error instanceof UpstreamError ? error.upstreamCode : null,
      iceberg_type: error instanceof UpstreamError ? error.upstreamType : null,
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
  maxResponseChars: number,
): Promise<CallToolResult> {
  try {
    const result = await operation();
    const response: CallToolResult = {
      content: [{ type: 'text', text: render(result) }],
      structuredContent: result,
    };
    if (JSON.stringify(response).length > maxResponseChars) {
      throw new LimitError(
        `Tool response exceeds ${maxResponseChars} characters; request a smaller page or source window`,
      );
    }
    return response;
  } catch (error) {
    let result = errorBody(error, reporter);
    let response: CallToolResult = {
      content: [{ type: 'text', text: `Error: ${result.error.message}` }],
      isError: true,
      structuredContent: result,
    };
    if (JSON.stringify(response).length > maxResponseChars) {
      result = errorBody(
        new LimitError(`Tool error response exceeds ${maxResponseChars} characters`),
        reporter,
      );
      response = {
        content: [{ type: 'text', text: `Error: ${result.error.message}` }],
        isError: true,
        structuredContent: result,
      };
    }
    return response;
  }
}
