interface QueuedRequest {
  readonly grant: () => void;
  readonly cancel: () => void;
}
interface LockState {
  readonly held: Map<string, Lock>;
  readonly pending: Map<string, QueuedRequest[]>;
}
function drain(state: LockState, name: string): void {
  if (state.held.has(name)) return;
  state.pending.get(name)?.shift()?.grant();
}
function complete(state: LockState, name: string, settle: () => void): void {
  state.held.delete(name);
  drain(state, name);
  settle();
}
function removePending(state: LockState, name: string, request: QueuedRequest): void {
  const queue = state.pending.get(name);
  if (queue === undefined) return;
  const index = queue.indexOf(request);
  if (index >= 0) queue.splice(index, 1);
}
function cancelPending(
  state: LockState,
  name: string,
  request: QueuedRequest,
  reject: (reason: unknown) => void,
): void {
  removePending(state, name, request);
  reject(new DOMException("Cancelled", "AbortError"));
  drain(state, name);
}
function enqueue<R>(
  state: LockState,
  name: string,
  options: LockOptions,
  callback: LockGrantedCallback<R>,
): Promise<R> {
  if (options.signal?.aborted === true)
    return Promise.reject(new DOMException("Cancelled", "AbortError"));
  if (
    options.ifAvailable === true &&
    (state.held.has(name) || (state.pending.get(name)?.length ?? 0) > 0)
  ) {
    return Promise.resolve().then(() => callback(null));
  }
  return new Promise<R>((resolve, reject): void => {
    const cancel = (): void => {
      cancelPending(state, name, request, reject);
    };
    const request: QueuedRequest = {
      cancel,
      grant: (): void => {
        options.signal?.removeEventListener("abort", cancel);
        const lock: Lock = { name, mode: "exclusive" };
        state.held.set(name, lock);
        Promise.resolve()
          .then(() => callback(lock))
          .then(
            (value): void => {
              complete(state, name, (): void => {
                resolve(value);
              });
            },
            (error: unknown): void => {
              complete(state, name, (): void => {
                reject(error);
              });
            },
          );
      },
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const queue = state.pending.get(name) ?? [];
    queue.push(request);
    state.pending.set(name, queue);
    queueMicrotask((): void => {
      drain(state, name);
    });
  });
}
/** A test-only exclusive WebLocks model; callbacks hold their named slot until settlement. */
export function createOriginLocksFixture(): Pick<LockManager, "request" | "query"> {
  const state: LockState = { held: new Map(), pending: new Map() };
  const request = <R>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<R>,
    callback?: LockGrantedCallback<R>,
  ): Promise<R> => {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const run = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    if (run === undefined || options.mode === "shared" || options.steal === true) {
      return Promise.reject(new TypeError("Fixture supports exclusive queued locks."));
    }
    return enqueue(state, name, options, run);
  };
  return {
    request,
    query: (): Promise<LockManagerSnapshot> =>
      Promise.resolve({
        held: [...state.held.values()].map(({ name, mode }) => ({ name, mode })),
        pending: [...state.pending].flatMap(([name, queue]) =>
          queue.map(() => ({ name, mode: "exclusive" as const })),
        ),
      }),
  };
}
