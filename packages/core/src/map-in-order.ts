/**
 * Calls `work` on every item, at most `limit` at a time, and resolves with the results in
 * the items' order, whichever call finished first.
 *
 * The next item starts the moment any call finishes, so one slow item never holds back the
 * others the way a group that waits for its slowest does. After a call fails, by rejecting
 * or by throwing, no further item starts, and the promise rejects once the calls already
 * started have finished: nothing it started is still running when the caller hears of the
 * failure. It rejects with the error of the earliest item that failed, in the items' order,
 * so the same failures give the same error whichever call was quicker. Every item before
 * the first to fail has started by then, so it is the error running them one at a time
 * would have stopped at.
 *
 * @param items the inputs, in the order the results are wanted
 * @param limit the most calls in progress at once; below 1 counts as 1
 * @param work the call for one item, given the item and its index
 * @returns one result per item, in the items' order
 * @example
 * const sizes = await mapInOrder(paths, 16, async (path) => (await stat(path)).size);
 */
export function mapInOrder<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const most = Math.max(1, limit);
  const results = new Array<Result>(items.length);
  let next = 0;
  let running = 0;
  let failure: { readonly index: number; readonly error: unknown } | null = null;
  const failed = (index: number, error: unknown): void => {
    if (failure === null || index < failure.index) failure = { index, error };
  };

  return new Promise((resolve, reject) => {
    const finished = (): void => {
      running -= 1;
      if (failure !== null) {
        if (running === 0) reject(failure.error);
      } else if (next === items.length && running === 0) {
        resolve(results);
      } else {
        startMore();
      }
    };

    const startMore = (): void => {
      while (failure === null && running < most && next < items.length) {
        const index = next;
        next += 1;
        running += 1;
        let call: Promise<Result>;
        try {
          call = work(items[index] as Item, index);
        } catch (error) {
          failed(index, error);
          finished();
          return;
        }
        call.then(
          (result) => {
            results[index] = result;
            finished();
          },
          (error: unknown) => {
            failed(index, error);
            finished();
          },
        );
      }
    };

    if (items.length === 0) resolve(results);
    else startMore();
  });
}
