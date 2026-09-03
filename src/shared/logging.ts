import { errorMessage } from './errors.js';
import { redactSecrets, redactText } from './redaction.js';

export const LOG_LEVELS = ['error', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Higher is more verbose. An entry is written when its own level is at most the configured one. */
const VERBOSITY: Record<LogLevel, number> = { debug: 2, error: 0, info: 1 };

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface ErrorReporter {
  report(error: unknown, event: string, correlationId?: string): void;
  /**
   * One structured, non-fatal diagnostic: something was degraded or skipped but the call continues.
   * Optional, so a minimal reporter only has to implement `report`.
   */
  warn?(event: string, details: Record<string, unknown>): void;
}

/**
 * One mutation of catalog state, recorded so an operator can answer "who dropped that table".
 * `args` is redacted before it is written, so it may carry the raw tool arguments.
 */
export interface AuditEvent {
  readonly args?: unknown;
  readonly correlationId?: string | undefined;
  readonly durationMs: number;
  readonly idempotencyKey?: string | undefined;
  readonly identifier: string;
  readonly operation: string;
  readonly outcome: 'failure' | 'success';
  readonly status?: number | undefined;
}

/**
 * The MCP `logging` capability is deprecated as of the 2026-07-28 specification, so diagnostics go
 * to stderr as one JSON object per line. stdout stays reserved for the stdio transport's protocol
 * frames.
 */
function write(entry: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

function enabled(entryLevel: LogLevel, configuredLevel: LogLevel): boolean {
  return VERBOSITY[entryLevel] <= VERBOSITY[configuredLevel];
}

/**
 * Reports an unexpected internal error as a structured stderr line. The error message is always
 * included after text redaction, so a failure can be diagnosed without reproducing it; the stack is
 * added only at `debug`, where the extra detail is asked for explicitly.
 */
export function createStderrReporter(level: LogLevel = 'info'): ErrorReporter {
  return {
    report(error: unknown, event: string, correlationId?: string): void {
      const stack = error instanceof Error ? error.stack : undefined;
      write({
        ts: new Date().toISOString(),
        level: 'error',
        event,
        correlation_id: correlationId ?? null,
        error_name: error instanceof Error ? error.name : 'NonErrorThrown',
        message: redactText(errorMessage(error)),
        ...(level === 'debug' && stack !== undefined ? { stack: redactText(stack) } : {}),
      });
    },
    warn(event: string, details: Record<string, unknown>): void {
      if (!enabled('info', level)) {
        return;
      }
      write({
        ts: new Date().toISOString(),
        level: 'warn',
        event,
        details: redactSecrets(details),
      });
    },
  };
}

export const stderrReporter: ErrorReporter = createStderrReporter();

/** Appends one `catalog.mutation` audit line. Suppressed only when the level is set to `error`. */
export function auditLog(event: AuditEvent, level: LogLevel = 'info'): void {
  if (!enabled('info', level)) {
    return;
  }
  write({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'catalog.mutation',
    operation: event.operation,
    identifier: event.identifier,
    idempotency_key: event.idempotencyKey ?? null,
    outcome: event.outcome,
    status: event.status ?? null,
    duration_ms: event.durationMs,
    correlation_id: event.correlationId ?? null,
    args: redactSecrets(event.args ?? null),
  });
}
