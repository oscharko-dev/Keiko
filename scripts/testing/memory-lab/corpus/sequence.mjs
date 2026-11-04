// Sequential asynchronous mapping (#4208). Writer calls must run one after another: the seeded random
// source is shared, so an interleaved call would change the order in which it is drawn and with it the
// scenario. A promise chain keeps that order without an `await` inside a loop body.
export function mapSequential(items, operation) {
  return items.reduce(
    (chain, item, index) =>
      chain.then(async (results) => {
        results.push(await operation(item, index));
        return results;
      }),
    Promise.resolve([]),
  );
}
