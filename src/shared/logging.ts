export interface ErrorReporter {
  report(error: unknown, context: string): void;
}

export const stderrReporter: ErrorReporter = {
  report(error: unknown, context: string): void {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        context,
        error_name: error instanceof Error ? error.name : 'NonErrorThrown',
        message: 'Unexpected internal error',
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  },
};
