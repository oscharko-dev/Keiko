/**
 * Runs `step` for each item strictly one after the other: the next call starts only after the
 * previous one settled, and a step that rejects ends the walk with that rejection. Git work uses
 * this where the order, the spawn budget or one index lock forbids running the steps in parallel.
 */
export async function eachInSequence<T>(
  items: readonly T[],
  step: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await items.reduce<Promise<void>>(
    (previous, item, index) => previous.then(() => step(item, index)),
    Promise.resolve(),
  );
}
