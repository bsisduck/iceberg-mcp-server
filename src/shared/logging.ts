import { errorMessage } from './errors.js';

export interface ErrorReporter {
  report(error: unknown, context: string): void;
}

export const stderrReporter: ErrorReporter = {
  report(error: unknown, context: string): void {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        context,
        message: errorMessage(error),
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  },
};
