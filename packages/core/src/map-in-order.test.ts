import { describe, expect, it } from 'vitest';
import { mapInOrder } from './map-in-order.js';

/**
 * Work whose calls wait until the test lets each one finish, so a test chooses the order
 * calls finish in and sees which have started. Letting one finish before it has started
 * makes it finish the moment it starts.
 */
function gatedWork(): {
  readonly work: (item: string) => Promise<string>;
  readonly started: string[];
  finish(item: string): void;
} {
  const started: string[] = [];
  const waiting = new Map<string, () => void>();
  const early = new Set<string>();
  return {
    work: (item) => {
      started.push(item);
      if (early.has(item)) return Promise.resolve(item.toUpperCase());
      return new Promise((resolve) => waiting.set(item, () => resolve(item.toUpperCase())));
    },
    started,
    finish(item) {
      const release = waiting.get(item);
      if (release === undefined) early.add(item);
      else release();
    },
  };
}

/** Lets every callback of a settled promise run, so the calls started after it are seen. */
function settle(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

describe('mapInOrder', () => {
  it('starts the next item the moment any call finishes, never more than the limit at once', async () => {
    const { work, started, finish } = gatedWork();
    const run = mapInOrder(['a', 'b', 'c', 'd', 'e'], 2, work);

    expect(started).toEqual(['a', 'b']);
    finish('b');
    await settle();
    expect(started).toEqual(['a', 'b', 'c']);
    finish('c');
    await settle();
    expect(started).toEqual(['a', 'b', 'c', 'd']);

    for (const item of ['d', 'e', 'a']) finish(item);
    expect(await run).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('gives the results in the items order, whichever call finished first', async () => {
    const { work, finish } = gatedWork();
    const run = mapInOrder(['a', 'b', 'c', 'd'], 3, work);

    for (const item of ['d', 'c', 'b', 'a']) finish(item);

    expect(await run).toEqual(['A', 'B', 'C', 'D']);
  });

  it('passes each call its index', async () => {
    expect(await mapInOrder(['a', 'b', 'c'], 2, async (item, index) => `${item}${index}`)).toEqual([
      'a0',
      'b1',
      'c2',
    ]);
  });

  it('resolves with nothing, calling nothing, for no items', async () => {
    let calls = 0;
    expect(
      await mapInOrder([], 4, async () => {
        calls += 1;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  it('counts a limit below one as one', async () => {
    const { work, started, finish } = gatedWork();
    const run = mapInOrder(['a', 'b'], 0, work);

    expect(started).toEqual(['a']);
    finish('a');
    finish('b');
    expect(await run).toEqual(['A', 'B']);
  });

  it('rejects with the first error, starts nothing after it, and waits for the calls in progress', async () => {
    const { work, started, finish } = gatedWork();
    let settled = false;
    const outcome = mapInOrder(['a', 'b', 'c', 'd'], 2, (item) =>
      item === 'b' ? Promise.reject(new Error('b failed')) : work(item),
    )
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });

    await settle();
    expect(started).toEqual(['a']);
    expect(settled).toBe(false);

    finish('a');
    expect(await outcome).toEqual(new Error('b failed'));
    expect(started).toEqual(['a']);
  });

  it('treats a call that throws before returning a promise as one that failed', async () => {
    const { work, started, finish } = gatedWork();
    const outcome = mapInOrder(['a', 'b', 'c'], 3, (item) => {
      if (item === 'b') throw new Error('b threw');
      return work(item);
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(started).toEqual(['a']);
    finish('a');
    expect(await outcome).toEqual(new Error('b threw'));
    expect(started).toEqual(['a']);
  });

  it('rejects at once when the only call in progress throws', async () => {
    await expect(
      mapInOrder(['a'], 1, () => {
        throw new Error('a threw');
      }),
    ).rejects.toThrow('a threw');
  });
});
