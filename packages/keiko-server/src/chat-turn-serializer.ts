import type { Chat, UpdateChatPatch, UiStore } from "./store/index.js";
import { deriveChatGroundingScopeIdentity } from "./store/chat-grounding-scope-identity.js";
import { logChatScopeUpdate } from "./chat-scope-update-log.js";
import { AbortRaceError, raceAbort } from "./abort-race.js";

export const CHAT_TURN_WAIT_CANCELLED = Symbol("chat-turn-wait-cancelled");

export interface ChatTurnSerializer {
  readonly runExclusive: <T>(
    chatId: string,
    signal: AbortSignal,
    operation: () => T | Promise<T>,
    generation?: AbortController,
  ) => Promise<T | typeof CHAT_TURN_WAIT_CANCELLED>;
  readonly interruptGenerations: (chatId: string) => number;
  readonly hasGenerations: (chatId: string) => boolean;
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
  const generations = new Map<string, Set<PendingChatGeneration>>();
  const runExclusive = async <T>(
    chatId: string,
    signal: AbortSignal,
    operation: () => T | Promise<T>,
    generation?: AbortController,
  ): Promise<T | typeof CHAT_TURN_WAIT_CANCELLED> => {
    const unregister = registerGeneration(generations, chatId, signal, generation);
    const predecessor = tails.get(chatId) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = (): void => {
        unregister();
        resolve();
      };
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
    return settleTurn(work, signal);
  };
  return {
    runExclusive,
    interruptGenerations: (chatId): number => interruptGenerations(generations.get(chatId)),
    hasGenerations: (chatId): boolean => activeGenerations(generations.get(chatId)).length > 0,
  };
}

async function settleTurn<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof CHAT_TURN_WAIT_CANCELLED> {
  try {
    return await raceAbort(work, signal);
  } catch (error) {
    if (error instanceof AbortRaceError) return CHAT_TURN_WAIT_CANCELLED;
    throw error;
  }
}

interface PendingChatGeneration {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
}

function activeGenerations(
  generations: ReadonlySet<PendingChatGeneration> | undefined,
): readonly PendingChatGeneration[] {
  return [...(generations ?? [])].filter(({ signal }) => !signal.aborted);
}

function interruptGenerations(generations: ReadonlySet<PendingChatGeneration> | undefined): number {
  const pending = activeGenerations(generations);
  for (const { controller } of pending) controller.abort("connected sources changed");
  return pending.length;
}

function registerGeneration(
  generations: Map<string, Set<PendingChatGeneration>>,
  chatId: string,
  signal: AbortSignal,
  controller: AbortController | undefined,
): () => void {
  if (controller === undefined) return (): void => undefined;
  const entries = generations.get(chatId) ?? new Set<PendingChatGeneration>();
  const entry = { controller, signal };
  entries.add(entry);
  generations.set(chatId, entries);
  return (): void => {
    entries.delete(entry);
    if (entries.size === 0) generations.delete(chatId);
  };
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
  generation?: AbortController,
): Promise<T | typeof CHAT_TURN_WAIT_CANCELLED> {
  return (deps.chatTurnSerializer ?? serializerForStore(deps.store)).runExclusive(
    chatId,
    signal,
    operation,
    generation,
  );
}

export function interruptChatGenerations(deps: ChatTurnSerializationDeps, chatId: string): number {
  return (deps.chatTurnSerializer ?? serializerForStore(deps.store)).interruptGenerations(chatId);
}

export function hasChatGenerations(deps: ChatTurnSerializationDeps, chatId: string): boolean {
  return (deps.chatTurnSerializer ?? serializerForStore(deps.store)).hasGenerations(chatId);
}

export function interruptChangedChatGenerations(
  deps: ChatTurnSerializationDeps,
  previous: Chat | undefined,
  current: Chat,
  correlationId: string | undefined,
  patch: UpdateChatPatch = {},
): void {
  if (
    previous === undefined ||
    deriveChatGroundingScopeIdentity(previous) === deriveChatGroundingScopeIdentity(current)
  )
    return;
  const count = interruptChatGenerations(deps, current.id);
  if (count > 0)
    logChatScopeUpdate("cancellation-requested", previous, current, patch, correlationId, count);
}
