import type { UiStore } from "./store/index.js";
import { AbortRaceError, raceAbort } from "./abort-race.js";

export const CHAT_TURN_WAIT_CANCELLED = Symbol("chat-turn-wait-cancelled");

export interface ChatTurnSerializer {
  readonly runExclusive: <T>(
    chatId: string,
    signal: AbortSignal,
    operation: () => T | Promise<T>,
  ) => Promise<T | typeof CHAT_TURN_WAIT_CANCELLED>;
}

interface ChatTurnSerializationDeps {
  readonly store: UiStore;
  readonly chatTurnSerializer?: ChatTurnSerializer | undefined;
}

function waitForPredecessor(predecessor: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (acquired: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(acquired);
    };
    const abort = (): void => {
      finish(false);
    };
    signal.addEventListener("abort", abort, { once: true });
    void predecessor.then(() => {
      finish(true);
    });
  });
}

function releaseTurn(
  tails: Map<string, Promise<void>>,
  chatId: string,
  gate: Promise<void>,
  releaseGate: () => void,
): void {
  releaseGate();
  if (tails.get(chatId) === gate) tails.delete(chatId);
}

export function createChatTurnSerializer(): ChatTurnSerializer {
  const tails = new Map<string, Promise<void>>();
  const runExclusive = async <T>(
    chatId: string,
    signal: AbortSignal,
    operation: () => T | Promise<T>,
  ): Promise<T | typeof CHAT_TURN_WAIT_CANCELLED> => {
    const predecessor = tails.get(chatId) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    tails.set(chatId, gate);
    if (!(await waitForPredecessor(predecessor, signal))) {
      void predecessor.then(() => {
        releaseTurn(tails, chatId, gate, releaseGate);
      });
      return CHAT_TURN_WAIT_CANCELLED;
    }
    if (signal.aborted) {
      releaseTurn(tails, chatId, gate, releaseGate);
      return CHAT_TURN_WAIT_CANCELLED;
    }
    const work = Promise.resolve().then(operation);
    // Cancellation may settle the HTTP-facing result before an external port cooperates. Keep the
    // per-chat gate owned by the underlying mutation until that work actually settles; otherwise a
    // late predecessor could mutate the same conversation concurrently with its successor.
    void work.then(
      () => {
        releaseTurn(tails, chatId, gate, releaseGate);
      },
      () => {
        releaseTurn(tails, chatId, gate, releaseGate);
      },
    );
    try {
      return await raceAbort(work, signal);
    } catch (error) {
      if (error instanceof AbortRaceError) return CHAT_TURN_WAIT_CANCELLED;
      throw error;
    }
  };
  return { runExclusive };
}

const serializersByStore = new WeakMap<UiStore, ChatTurnSerializer>();

function serializerForStore(store: UiStore): ChatTurnSerializer {
  const existing = serializersByStore.get(store);
  if (existing !== undefined) return existing;
  const created = createChatTurnSerializer();
  serializersByStore.set(store, created);
  return created;
}

export function runSerializedChatTurn<T>(
  deps: ChatTurnSerializationDeps,
  chatId: string,
  signal: AbortSignal,
  operation: () => T | Promise<T>,
): Promise<T | typeof CHAT_TURN_WAIT_CANCELLED> {
  return (deps.chatTurnSerializer ?? serializerForStore(deps.store)).runExclusive(
    chatId,
    signal,
    operation,
  );
}
