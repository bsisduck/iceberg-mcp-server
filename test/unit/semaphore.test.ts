import { describe, expect, it, vi } from 'vitest';

import { Semaphore } from '../../src/shared/semaphore.js';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settled(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('Semaphore', (): void => {
  it('rejects non-positive or fractional permit counts', (): void => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
    expect(new Semaphore(2).permits).toBe(2);
  });

  it('grants permits in FIFO order and releases them after completion', async (): Promise<void> => {
    const semaphore = new Semaphore(1);
    const started: string[] = [];
    const gates = { first: deferred(), second: deferred(), third: deferred() };
    const run = (name: keyof typeof gates): Promise<string> =>
      semaphore.use(async () => {
        started.push(name);
        await gates[name].promise;
        return name;
      });

    const first = run('first');
    const second = run('second');
    const third = run('third');
    await settled();

    expect(started).toEqual(['first']);
    expect(semaphore.available).toBe(0);
    expect(semaphore.pending).toBe(2);

    gates.first.resolve();
    expect(await first).toBe('first');
    await settled();
    expect(started).toEqual(['first', 'second']);

    gates.second.resolve();
    expect(await second).toBe('second');
    await settled();
    expect(started).toEqual(['first', 'second', 'third']);

    gates.third.resolve();
    expect(await third).toBe('third');
    expect(semaphore.available).toBe(1);
    expect(semaphore.pending).toBe(0);
  });

  it('releases the permit when the operation throws', async (): Promise<void> => {
    const semaphore = new Semaphore(1);

    await expect(semaphore.use(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(semaphore.available).toBe(1);
    expect(await semaphore.use(() => Promise.resolve('next'))).toBe('next');
  });

  it('rejects promptly with the abort reason when the signal is already aborted', async (): Promise<void> => {
    const semaphore = new Semaphore(1);
    const operation = vi.fn(() => Promise.resolve('unused'));
    const controller = new AbortController();
    controller.abort(new Error('cancelled before start'));

    await expect(semaphore.use(operation, controller.signal)).rejects.toThrow(
      'cancelled before start',
    );
    expect(operation).not.toHaveBeenCalled();
    expect(semaphore.available).toBe(1);
    expect(semaphore.pending).toBe(0);
  });

  it('removes a waiter that aborts while queued without disturbing others', async (): Promise<void> => {
    const semaphore = new Semaphore(1);
    const holder = deferred();
    const holding = semaphore.use(async () => {
      await holder.promise;
      return 'held';
    });
    const controller = new AbortController();
    const abortedOperation = vi.fn(() => Promise.resolve('never'));
    const aborted = semaphore.use(abortedOperation, controller.signal);
    const survivor = semaphore.use(() => Promise.resolve('survivor'));
    await settled();
    expect(semaphore.pending).toBe(2);

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedOperation).not.toHaveBeenCalled();
    expect(semaphore.pending).toBe(1);

    holder.resolve();
    expect(await holding).toBe('held');
    expect(await survivor).toBe('survivor');
    expect(semaphore.available).toBe(1);
    expect(semaphore.pending).toBe(0);
  });

  it('stops listening to a signal once the waiter acquires the permit', async (): Promise<void> => {
    const semaphore = new Semaphore(1);
    const holder = deferred();
    const holding = semaphore.use(async () => {
      await holder.promise;
    });
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const gate = deferred();
    const waiting = semaphore.use(async () => {
      await gate.promise;
      return 'acquired';
    }, controller.signal);
    await settled();

    holder.resolve();
    await holding;
    await settled();
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

    controller.abort();
    gate.resolve();
    expect(await waiting).toBe('acquired');
  });
});
