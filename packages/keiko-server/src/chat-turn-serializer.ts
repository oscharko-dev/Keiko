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
  /** `keepRunning` spares the Chat's running turn, which has taken the interruption itself. */
  readonly interruptGenerations: (chatId: string, keepRunning?: boolean) => number;
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
    const { entry, unregister } = registerGeneration(generations, chatId, signal, generation);
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
    if (entry !== undefined) entry.running = true;
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
    interruptGenerations: (chatId, keepRunning = false): number =>
      interruptGenerations(generations.get(chatId), keepRunning),
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
  /** The predecessors settled. A running turn may hold no entry: buffered routes register none. */
  running: boolean;
}

function activeGenerations(
  generations: ReadonlySet<PendingChatGeneration> | undefined,
): readonly PendingChatGeneration[] {
  return [...(generations ?? [])].filter(({ signal }) => !signal.aborted);
}

function interruptGenerations(
  generations: ReadonlySet<PendingChatGeneration> | undefined,
  keepRunning: boolean,
): number {
  const interrupted = activeGenerations(generations).filter(
    ({ running }) => !(keepRunning && running),
  );
  for (const { controller } of interrupted) controller.abort("connected sources changed");
  return interrupted.length;
}

function registerGeneration(
  generations: Map<string, Set<PendingChatGeneration>>,
  chatId: string,
  signal: AbortSignal,
  controller: AbortController | undefined,
): { readonly entry?: PendingChatGeneration; readonly unregister: () => void } {
  if (controller === undefined) return { unregister: (): void => undefined };
  const entries = generations.get(chatId) ?? new Set<PendingChatGeneration>();
  const entry = { controller, signal, running: false };
  entries.add(entry);
  generations.set(chatId, entries);
  return {
    entry,
    unregister: (): void => {
      entries.delete(entry);
      if (entries.size === 0) generations.delete(chatId);
    },
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

// #4213: background learning never competes with the person's work. Every serialized Chat
// mutation (a send, a stream, a deletion) is foreground work from the moment it waits for its turn
// until its operation settles; a learning pass yields to it.
type ChatForegroundListener = (active: boolean) => void;

interface ChatForegroundActivity {
  count: number;
  readonly listeners: Set<ChatForegroundListener>;
}

const foregroundByStore = new WeakMap<UiStore, ChatForegroundActivity>();

function foregroundOf(store: UiStore): ChatForegroundActivity {
  const existing = foregroundByStore.get(store);
  if (existing !== undefined) return existing;
  const created: ChatForegroundActivity = { count: 0, listeners: new Set() };
  foregroundByStore.set(store, created);
  return created;
}

function notifyForeground(activity: ChatForegroundActivity, active: boolean): void {
  for (const listener of [...activity.listeners]) listener(active);
}

function beginChatForeground(store: UiStore): () => void {
  const activity = foregroundOf(store);
  activity.count += 1;
  if (activity.count === 1) notifyForeground(activity, true);
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    activity.count -= 1;
    if (activity.count === 0) notifyForeground(activity, false);
  };
}

/** True while any Chat mutation of this store waits or runs. */
export function chatForegroundActive(deps: Pick<ChatTurnSerializationDeps, "store">): boolean {
  return foregroundOf(deps.store).count > 0;
}

/** Calls the listener when foreground Chat work starts (true) and when all of it settled (false). */
export function onChatForegroundChange(
  deps: Pick<ChatTurnSerializationDeps, "store">,
  listener: ChatForegroundListener,
): () => void {
  const activity = foregroundOf(deps.store);
  activity.listeners.add(listener);
  return (): void => {
    activity.listeners.delete(listener);
  };
}

export async function runSerializedChatTurn<T>(
  deps: ChatTurnSerializationDeps,
  chatId: string,
  signal: AbortSignal,
  operation: () => T | Promise<T>,
  generation?: AbortController,
): Promise<T | typeof CHAT_TURN_WAIT_CANCELLED> {
  const release = beginChatForeground(deps.store);
  const turn = { started: false };
  const tracked = async (): Promise<T> => {
    turn.started = true;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  try {
    return await (deps.chatTurnSerializer ?? serializerForStore(deps.store)).runExclusive(
      chatId,
      signal,
      tracked,
      generation,
    );
  } finally {
    // A turn that never ran (its wait was cancelled) holds no foreground; one that runs releases
    // when its operation settles, which can be after a cancelled caller stopped waiting.
    if (!turn.started) release();
  }
}

export function interruptChatGenerations(deps: ChatTurnSerializationDeps, chatId: string): number {
  return (deps.chatTurnSerializer ?? serializerForStore(deps.store)).interruptGenerations(chatId);
}

type ChatTurnInterruption = () => boolean;
const turnInterruptions = new WeakMap<UiStore, Map<string, ChatTurnInterruption>>();

/**
 * Lets the Chat's running tool turn take a change of the Chat's scope itself: the handler returns
 * true when the turn ends with its own answer. Returns the release for when the turn stops listening.
 */
export function onChatScopeInterruption(
  deps: Pick<ChatTurnSerializationDeps, "store">,
  chatId: string,
  interruption: ChatTurnInterruption,
): () => void {
  const interruptions =
    turnInterruptions.get(deps.store) ?? new Map<string, ChatTurnInterruption>();
  turnInterruptions.set(deps.store, interruptions);
  interruptions.set(chatId, interruption);
  return (): void => {
    if (interruptions.get(chatId) === interruption) interruptions.delete(chatId);
  };
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
  const keepRunning = turnInterruptions.get(deps.store)?.get(current.id)?.() === true;
  const count = (deps.chatTurnSerializer ?? serializerForStore(deps.store)).interruptGenerations(
    current.id,
    keepRunning,
  );
  if (count > 0)
    logChatScopeUpdate("cancellation-requested", previous, current, patch, correlationId, count);
}
