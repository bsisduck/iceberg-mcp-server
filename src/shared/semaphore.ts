interface Waiter {
  cleanup: (() => void) | undefined;
  readonly reject: (reason: unknown) => void;
  readonly resolve: () => void;
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('This operation was aborted', 'AbortError');
}

/**
 * Counting semaphore with FIFO fairness. `use` acquires a permit, runs the operation, and always
 * releases the permit, including when the operation throws. An optional abort signal makes waiting
 * callers give up promptly: a signal that is already aborted rejects before touching the queue, and
 * a signal that aborts while waiting removes the waiter and rejects with the signal's reason.
 */
export class Semaphore {
  readonly #permits: number;
  readonly #waiting: Waiter[] = [];
  #available: number;

  public constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError('Semaphore permits must be a positive integer');
    }
    this.#available = permits;
    this.#permits = permits;
  }

  public get available(): number {
    return this.#available;
  }

  public get pending(): number {
    return this.#waiting.length;
  }

  public get permits(): number {
    return this.#permits;
  }

  public async use<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(abortError(signal));
    }
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { cleanup: undefined, reject, resolve };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.#waiting.indexOf(waiter);
          if (index !== -1) {
            this.#waiting.splice(index, 1);
          }
          reject(abortError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = (): void => {
          signal.removeEventListener('abort', onAbort);
        };
      }
      this.#waiting.push(waiter);
    });
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#available += 1;
      return;
    }
    next.cleanup?.();
    next.resolve();
  }
}
