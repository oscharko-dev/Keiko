import { describe, expect, it } from "vitest";
import { CHAT_TURN_WAIT_CANCELLED, createChatTurnSerializer } from "./chat-turn-serializer.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("chat turn serializer", () => {
  it("runs turns for one chat in FIFO order", async () => {
    const serializer = createChatTurnSerializer();
    const signal = new AbortController().signal;
    const releaseFirst = deferred<undefined>();
    const firstStarted = deferred<undefined>();
    const events: string[] = [];
    const first = serializer.runExclusive("chat-a", signal, async () => {
      events.push("first:start");
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      events.push("first:end");
      return "first";
    });
    await firstStarted.promise;
    const second = serializer.runExclusive("chat-a", signal, () => {
      events.push("second:start");
      return Promise.resolve("second");
    });

    expect(events).toEqual(["first:start"]);
    releaseFirst.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("allows different chats to run concurrently", async () => {
    const serializer = createChatTurnSerializer();
    const signal = new AbortController().signal;
    const releaseA = deferred<undefined>();
    const startedA = deferred<undefined>();
    const first = serializer.runExclusive("chat-a", signal, async () => {
      startedA.resolve(undefined);
      await releaseA.promise;
      return "a";
    });
    await startedA.promise;

    await expect(
      serializer.runExclusive("chat-b", signal, () => Promise.resolve("b")),
    ).resolves.toBe("b");
    releaseA.resolve(undefined);
    await expect(first).resolves.toBe("a");
  });

  it("lets a successor advance after an aborted middle waiter", async () => {
    const serializer = createChatTurnSerializer();
    const releaseFirst = deferred<undefined>();
    const firstStarted = deferred<undefined>();
    const first = serializer.runExclusive("chat-a", new AbortController().signal, async () => {
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      return "first";
    });
    await firstStarted.promise;
    const middleController = new AbortController();
    let middleRan = false;
    const middle = serializer.runExclusive("chat-a", middleController.signal, () => {
      middleRan = true;
      return Promise.resolve("middle");
    });
    let successorRan = false;
    const successor = serializer.runExclusive("chat-a", new AbortController().signal, () => {
      successorRan = true;
      return Promise.resolve("successor");
    });

    middleController.abort();
    await expect(middle).resolves.toBe(CHAT_TURN_WAIT_CANCELLED);
    expect(middleRan).toBe(false);
    expect(successorRan).toBe(false);
    releaseFirst.resolve(undefined);
    await expect(first).resolves.toBe("first");
    await expect(successor).resolves.toBe("successor");
    expect(successorRan).toBe(true);
  });

  it("releases the queue when an operation throws", async () => {
    const serializer = createChatTurnSerializer();
    const signal = new AbortController().signal;
    const releaseFirst = deferred<undefined>();
    const firstStarted = deferred<undefined>();
    const first = serializer.runExclusive("chat-a", signal, async () => {
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      throw new Error("expected failure");
    });
    await firstStarted.promise;
    const second = serializer.runExclusive("chat-a", signal, () => Promise.resolve("recovered"));

    releaseFirst.resolve(undefined);
    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe("recovered");
  });

  it("keeps the queue closed until an acquired operation that ignored cancellation settles", async () => {
    const serializer = createChatTurnSerializer();
    const controller = new AbortController();
    const abandoned = deferred<string>();
    const started = deferred<undefined>();
    const first = serializer.runExclusive("chat-a", controller.signal, () => {
      started.resolve(undefined);
      return abandoned.promise;
    });
    await started.promise;
    let successorRan = false;
    const successor = serializer.runExclusive("chat-a", new AbortController().signal, () => {
      successorRan = true;
      return Promise.resolve("successor");
    });

    controller.abort();

    await expect(first).resolves.toBe(CHAT_TURN_WAIT_CANCELLED);
    expect(successorRan).toBe(false);
    abandoned.reject(new Error("late abandoned operation rejection"));
    await expect(successor).resolves.toBe("successor");
    expect(successorRan).toBe(true);
  });
});
