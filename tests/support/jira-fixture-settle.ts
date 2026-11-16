/**
 * Runs a synchronous fixture handler behind a promise boundary with the exact
 * semantics of an `async` function body: a returned value resolves and a
 * synchronous throw rejects, never escaping synchronously. An `Error` is
 * rejected unchanged; any other thrown value is carried as the `cause`.
 */
export function settleSync<T>(handler: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(handler());
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error("Fixture handler threw", { cause: error }));
    }
  });
}
