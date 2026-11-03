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

function heldGeneration(
  serializer: ReturnType<typeof createChatTurnSerializer>,
  chatId: string,
): {
  controller: AbortController;
  started: Promise<undefined>;
  release: ReturnType<typeof deferred<string>>;
  result: Promise<string | typeof CHAT_TURN_WAIT_CANCELLED>;
} {
  const controller = new AbortController();
  const started = deferred<undefined>();
  const release = deferred<string>();
  const result = serializer.runExclusive(
    chatId,
    controller.signal,
    () => {
      started.resolve(undefined);
      return release.promise;
    },
    controller,
  );
  return { controller, started: started.promise, release, result };
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
  it("interrupts active and queued generation without releasing noncooperative work or mutations", async () => {
    const serializer = createChatTurnSerializer();
    const first = heldGeneration(serializer, "chat-a");
    await first.started;
    const queued = heldGeneration(serializer, "chat-a");
    let mutationRan = false;
    const mutation = serializer.runExclusive("chat-a", new AbortController().signal, () => {
      mutationRan = true;
      return "updated";
    });
    expect(serializer.interruptGenerations("chat-a")).toBe(2);
    expect(await first.result).toBe(CHAT_TURN_WAIT_CANCELLED);
    expect(await queued.result).toBe(CHAT_TURN_WAIT_CANCELLED);
    expect(mutationRan).toBe(false);
    expect(serializer.interruptGenerations("chat-a")).toBe(0);
    first.release.resolve("late ignored answer");
    expect(await mutation).toBe("updated");
    const next = heldGeneration(serializer, "chat-a");
    await next.started;
    next.release.resolve("new answer");
    expect(await next.result).toBe("new answer");
    expect(serializer.interruptGenerations("chat-a")).toBe(0);
  });

  it("keeps other chats and serializer instances running", async () => {
    const serializer = createChatTurnSerializer();
    const first = heldGeneration(serializer, "chat-a");
    const other = heldGeneration(serializer, "chat-b");
    const differentStore = heldGeneration(createChatTurnSerializer(), "chat-a");
    await Promise.all([first.started, other.started, differentStore.started]);
    expect(serializer.interruptGenerations("chat-a")).toBe(1);
    expect(first.controller.signal.aborted).toBe(true);
    expect(other.controller.signal.aborted).toBe(false);
    expect(differentStore.controller.signal.aborted).toBe(false);
    first.release.resolve("discarded");
    other.release.resolve("other chat answer");
    differentStore.release.resolve("other store answer");
    expect(await first.result).toBe(CHAT_TURN_WAIT_CANCELLED);
    expect(await other.result).toBe("other chat answer");
    expect(await differentStore.result).toBe("other store answer");
  });
});
