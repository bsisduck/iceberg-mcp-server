import { abortError } from './errors.js';

/**
 * Abort-aware pause built on the global timer so callers can drive it with fake timers. A signal
 * that is already aborted rejects before a timer is armed, and a signal that aborts while the
 * pause is running clears the timer and rejects with the signal's reason.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(abortError(signal));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort !== undefined) {
        signal?.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
    if (signal !== undefined) {
      onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
