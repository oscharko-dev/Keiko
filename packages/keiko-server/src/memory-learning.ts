// #4213: Keiko learns from natural conversation later, in passes, instead of after every message.
// A pass starts after a period without Chat activity, when the person opens another Chat, and at
// the next start for anything left over. It never starts while an answer runs, and new foreground
// Chat work cancels it; the provider request is aborted with it. Each Chat keeps only how far it
// has been learned: the text stays in the Chat's own messages, and a turn written while memory was
// off carries no mark and is never learned.

import { randomUUID } from "node:crypto";
import type { ConversationId, ProjectId, WorkspaceId } from "@oscharko-dev/keiko-contracts/memory";
import type { ConversationMemoryCaptureSurfaceWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "./deps.js";
import type { UiStore } from "./store/index.js";
import type {
  ChatMemoryLearningStore,
  MemoryLearningPosition,
  PendingLearningMessage,
} from "./store/chatMemoryLearning.js";
import { chatForegroundActive, onChatForegroundChange } from "./chat-turn-serializer.js";
import {
  LOCAL_CONVERSATION_MEMORY_USER_ID,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { learnStoredTurn, type StoredTurnLearning } from "./memory-salience.js";
import { replayPendingForget } from "./memory-learning-forget.js";
import {
  emptyLearningPassTally,
  logLearningPassSettled,
  logLearningPassStarted,
  type LearningPassTally,
  type MemoryLearningPassOutcome,
  type MemoryLearningTrigger,
} from "./memory-learning-log.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";

const IDLE_MS_ENV = "KEIKO_MEMORY_LEARNING_IDLE_MS";
// Measured, not guessed: see docs/memory/memoria-viva-learning-passes.md. Between 15 and 60 seconds
// the share of passes the next message cancels stays the same; the shortest pause learns most turns
// before the person writes again.
export const DEFAULT_MEMORY_LEARNING_IDLE_MS = 15_000;
const MAX_IDLE_MS = 3_600_000;
// Bounds per pass; the remainder is learned by the next pass. They bound work, not text size, so a
// model with a larger window learns the same turns.
const MAX_CHATS_PER_PASS = 8;
const MAX_TURNS_PER_CHAT_PASS = 16;
const PENDING_PAGE = 64;
const CONTINUATION_DELAY_MS = 1_000;
// Opening Chats in quick succession, or reading one again, starts one pass, not one per read.
const CHAT_CHANGE_DELAY_MS = 1_000;
const STARTUP_DELAY_MS = 5_000;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 1_800_000;
// A turn that keeps failing for a reason other than the model is learned no more after this many
// attempts, so one broken turn cannot hold back the rest of its Chat.
const MAX_FAILED_ATTEMPTS = 3;

interface LearningTurn {
  readonly user: PendingLearningMessage;
  readonly assistantText: string;
  /** The turn's correlation: its first answer's id, which the turn's other evidence carries. */
  readonly correlationId: string;
  readonly end: MemoryLearningPosition;
}

interface TurnPlan {
  /** Rows before the first person's message, which nothing is learned from. */
  readonly leadingEnd?: MemoryLearningPosition | undefined;
  readonly turns: readonly LearningTurn[];
}

// A person's message and the answers after it, up to their next message.
function turnAt(
  user: PendingLearningMessage,
  rows: readonly PendingLearningMessage[],
  index: number,
): {
  readonly turn: Omit<LearningTurn, "end"> & { readonly answered: boolean };
  readonly next: number;
} {
  const following = rows.slice(index + 1);
  const span = following.findIndex((row) => row.role === "user");
  const body = span === -1 ? following : following.slice(0, span);
  const answers = body.filter((row) => row.role === "assistant");
  return {
    turn: {
      user,
      assistantText: answers.map((row) => row.content).join("\n\n"),
      correlationId: answers[0]?.id ?? user.id,
      answered: answers.length > 0,
    },
    next: index + 1 + body.length,
  };
}

// A pass never runs while a Chat turn is in flight, so every stored turn is complete, answered or
// not: an answer that failed or was removed leaves the person's words to learn. Only the last turn
// of a full page may continue on the next page; it waits for that page, unless the page holds nothing
// else, so an oversized turn cannot hold the Chat back.
export function planLearningTurns(
  rows: readonly PendingLearningMessage[],
  pageFull: boolean,
): TurnPlan {
  const firstUser = rows.findIndex((row) => row.role === "user");
  const leading = firstUser === -1 ? rows : rows.slice(0, firstUser);
  const leadingEnd = leading.at(-1)?.position;
  const turns: LearningTurn[] = [];
  let index = firstUser === -1 ? rows.length : firstUser;
  for (let user = rows[index]; user !== undefined; user = rows[index]) {
    const { turn, next } = turnAt(user, rows, index);
    const complete = next < rows.length || !pageFull || index === firstUser;
    const last = rows[next - 1];
    if (!complete || last === undefined) break;
    turns.push({
      user: turn.user,
      assistantText: turn.assistantText,
      correlationId: turn.correlationId,
      end: last.position,
    });
    index = next;
  }
  return { leadingEnd, turns };
}

function memoryContextOfChat(chat: {
  readonly id: string;
  readonly projectPath: string;
}): ConversationMemoryRuntimeContext {
  return {
    userId: LOCAL_CONVERSATION_MEMORY_USER_ID,
    workspaceId: chat.projectPath as WorkspaceId,
    projectId: chat.projectPath as ProjectId,
    conversationId: chat.id as ConversationId,
  };
}

function readIdleMs(deps: UiHandlerDeps): number {
  const raw = deps.env[IDLE_MS_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_MEMORY_LEARNING_IDLE_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_IDLE_MS
    ? parsed
    : DEFAULT_MEMORY_LEARNING_IDLE_MS;
}

type ChatPassOutcome = "done" | "cancelled" | "unavailable";

interface TurnScope {
  readonly context: ConversationMemoryRuntimeContext;
  readonly signal: AbortSignal;
  readonly tally: LearningPassTally;
  readonly passId: string;
}

interface RunningPass {
  readonly controller: AbortController;
  cancelledAt?: number;
}

/** Records that a turn was written with memory on, so a later pass learns it. */
export interface MemoryLearningMarkRequest {
  readonly messageId: string;
  readonly surface: ConversationMemoryCaptureSurfaceWire;
  readonly mode?: CodingWorkbenchMode | undefined;
}

export class MemoryLearningRuntime {
  private readonly idleMs: number;
  private timer: NodeJS.Timeout | undefined;
  private timerTrigger: MemoryLearningTrigger = "inactivity";
  private timerParent: string | undefined;
  private timerDueAt = 0;
  // A trigger that arrived while a pass was still running; the pass runs it when it has settled.
  private missedTrigger = false;
  private running: RunningPass | undefined;
  private retryMs = FIRST_RETRY_MS;
  private disposed = false;
  private openedChatId: string | undefined;
  // The last turn noted since a pass claimed the runtime; that pass learns it, so it clears it.
  private notedTurnCorrelation: string | undefined;
  private readonly failedAttempts = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(private deps: UiHandlerDeps) {
    this.idleMs = readIdleMs(deps);
    this.unsubscribe = onChatForegroundChange(deps, (active) => {
      if (active) this.cancelRunning();
      // Chat work restarts the pause; a waiting backoff is kept.
      else if (this.hasLearningStore()) this.arm("inactivity", this.pauseParent());
    });
  }

  /** The newest deps own the store and model ports; the runtime is shared per store. */
  rebind(deps: UiHandlerDeps): void {
    this.deps = deps;
  }

  /** A turn was committed: learning waits until the person has paused. */
  noteTurn(mark: MemoryLearningMarkRequest, correlationId: string): void {
    const store = this.deps.store.memoryLearning;
    if (store === undefined || this.disposed) return;
    store.markMessage(mark.messageId, {
      surface: mark.surface,
      ...(mark.mode === undefined ? {} : { mode: mark.mode }),
    });
    this.notedTurnCorrelation = correlationId;
    this.arm("inactivity", correlationId);
  }

  /**
   * The person opened a Chat. Opening another one than before is a moment to learn what was said
   * in the previous one; reading the same Chat again is not.
   */
  noteChatOpened(chatId: string, correlationId: string | undefined): void {
    const previous = this.openedChatId;
    this.openedChatId = chatId;
    if (this.disposed || !this.hasLearningStore()) return;
    if (previous === undefined || previous === chatId) return;
    this.schedule(CHAT_CHANGE_DELAY_MS, "chat-change", correlationId);
  }

  /** At start, anything left over from before is learned once the server has settled. */
  start(): void {
    if (this.disposed || !this.hasLearningStore()) return;
    this.schedule(STARTUP_DELAY_MS, "startup", undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.cancelRunning();
    this.unsubscribe();
  }

  private hasLearningStore(): boolean {
    return this.deps.store.memoryLearning !== undefined && this.deps.memoryVault !== undefined;
  }

  // The pause after Chat work belongs to the turn it noted, else to what the waiting timer holds.
  private pauseParent(): string | undefined {
    if (this.notedTurnCorrelation !== undefined) return this.notedTurnCorrelation;
    return this.timer === undefined ? undefined : this.timerParent;
  }

  private arm(trigger: MemoryLearningTrigger, parent?: string): void {
    this.schedule(this.idleMs, trigger, parent);
  }

  // One timer holds the next pass. A new pause after Chat work restarts the wait; a waiting backoff is
  // kept, so neither a Chat change nor another trigger runs a pass against an unavailable model
  // early; otherwise the earliest due trigger wins.
  private schedule(
    delayMs: number,
    trigger: MemoryLearningTrigger,
    parent: string | undefined,
  ): void {
    const dueAt = performance.now() + delayMs;
    if (this.timer !== undefined && !this.replacesTimer(trigger, dueAt)) return;
    this.clearTimer();
    this.timerTrigger = trigger;
    this.timerParent = parent;
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runPass(this.timerTrigger, this.timerParent);
    }, delayMs);
    this.timer.unref();
  }

  private replacesTimer(trigger: MemoryLearningTrigger, dueAt: number): boolean {
    if (this.timerTrigger === "retry") return trigger === "retry";
    return trigger === "inactivity" || dueAt < this.timerDueAt;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private cancelRunning(): void {
    const running = this.running;
    if (running === undefined || running.controller.signal.aborted) return;
    running.cancelledAt = performance.now();
    running.controller.abort("foreground-chat-work");
  }

  /** Runs one pass now, if nothing else is running. Returns how it ended, or undefined. */
  async runPass(
    trigger: MemoryLearningTrigger,
    parent: string | undefined,
  ): Promise<MemoryLearningPassOutcome | undefined> {
    const store = this.deps.store.memoryLearning;
    if (this.disposed || store === undefined || this.deps.memoryVault === undefined)
      return undefined;
    if (this.running !== undefined) {
      this.missedTrigger = true;
      return undefined;
    }
    // Foreground work re-arms the pass when it settles.
    if (chatForegroundActive(this.deps)) return undefined;
    const running: RunningPass = { controller: new AbortController() };
    this.running = running;
    this.notedTurnCorrelation = undefined;
    const ids = { passId: randomUUID(), parentCorrelationId: parent };
    try {
      return await this.runClaimedPass(store, running, trigger, ids);
    } finally {
      this.running = undefined;
    }
  }

  private async runClaimedPass(
    store: ChatMemoryLearningStore,
    running: RunningPass,
    trigger: MemoryLearningTrigger,
    ids: { readonly passId: string; readonly parentCorrelationId: string | undefined },
  ): Promise<MemoryLearningPassOutcome | undefined> {
    const startedAt = performance.now();
    const tally = emptyLearningPassTally();
    let settled: { outcome: MemoryLearningPassOutcome; pendingChatCount: number };
    try {
      const chats = store.listChatsWithPending(MAX_CHATS_PER_PASS);
      if (chats.length === 0) return undefined;
      logLearningPassStarted(ids, { trigger, chatCount: chats.length });
      const outcome = await this.learnChats(
        store,
        chats,
        running.controller.signal,
        tally,
        ids.passId,
      );
      settled = {
        outcome: this.passOutcome(outcome, running),
        // Chats left without progress wait for new work instead of a continuation loop.
        pendingChatCount:
          tally.turnCount === 0 ? 0 : store.listChatsWithPending(MAX_CHATS_PER_PASS).length,
      };
    } catch (error: unknown) {
      reportLearningPassFailure(this.deps, ids.passId, error);
      settled = { outcome: "failed", pendingChatCount: 0 };
    }
    logLearningPassSettled(ids, {
      trigger,
      ...settled,
      tally,
      durationMs: performance.now() - startedAt,
      ...(running.cancelledAt === undefined
        ? {}
        : { cancelLatencyMs: performance.now() - running.cancelledAt }),
    });
    this.afterPass(settled.outcome, settled.pendingChatCount, ids.passId);
    return settled.outcome;
  }

  private passOutcome(outcome: ChatPassOutcome, running: RunningPass): MemoryLearningPassOutcome {
    if (running.controller.signal.aborted || outcome === "cancelled") return "cancelled";
    return outcome === "unavailable" ? "unavailable" : "completed";
  }

  private afterPass(
    outcome: MemoryLearningPassOutcome,
    pendingChatCount: number,
    passId: string,
  ): void {
    if (this.disposed) return;
    const missed = this.missedTrigger;
    this.missedTrigger = false;
    if (outcome === "unavailable" || outcome === "failed") {
      this.schedule(this.retryMs, "retry", passId);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
      return;
    }
    this.retryMs = FIRST_RETRY_MS;
    if (outcome === "completed" && pendingChatCount > 0) {
      this.schedule(CONTINUATION_DELAY_MS, "continuation", passId);
    } else if (outcome === "cancelled" || missed) {
      // A cancelled pass, or a trigger that came while this one ran, resumes after the next pause.
      this.arm("inactivity", passId);
    }
  }

  // One Chat after the other: a single-slot local model serves one learning call at a time.
  private async learnChats(
    store: ChatMemoryLearningStore,
    chats: readonly string[],
    signal: AbortSignal,
    tally: LearningPassTally,
    passId: string,
  ): Promise<ChatPassOutcome> {
    const [chatId, ...rest] = chats;
    if (chatId === undefined) return "done";
    if (signal.aborted) return "cancelled";
    tally.chatCount += 1;
    const outcome = await this.learnChat(store, chatId, signal, tally, passId);
    if (outcome === "cancelled") return "cancelled";
    const remaining = await this.learnChats(store, rest, signal, tally, passId);
    return outcome === "unavailable" && remaining === "done" ? "unavailable" : remaining;
  }

  private async learnChat(
    store: ChatMemoryLearningStore,
    chatId: string,
    signal: AbortSignal,
    tally: LearningPassTally,
    passId: string,
  ): Promise<ChatPassOutcome> {
    const chat = this.deps.store.findChatById(chatId);
    // A deleted Chat took its messages and its position with it; nothing of it is learned.
    if (chat === undefined) return "done";
    const rows = store.listPending(chatId, PENDING_PAGE);
    const plan = planLearningTurns(rows, rows.length === PENDING_PAGE);
    if (plan.leadingEnd !== undefined) store.advance(chatId, plan.leadingEnd);
    const context = memoryContextOfChat(chat);
    return this.learnTurns(store, chat, plan.turns.slice(0, MAX_TURNS_PER_CHAT_PASS), {
      context,
      signal,
      tally,
      passId,
    });
  }

  // Turns are learned in Chat order, and the position moves past each one only once it is learned.
  private async learnTurns(
    store: ChatMemoryLearningStore,
    chat: { readonly id: string; readonly selectedModel: string },
    turns: readonly LearningTurn[],
    scope: TurnScope,
  ): Promise<ChatPassOutcome> {
    const [turn, ...rest] = turns;
    if (turn === undefined) return "done";
    if (scope.signal.aborted) return "cancelled";
    const outcome = await this.learnTurn(turn, chat.selectedModel, scope);
    if (outcome !== "done") return outcome;
    store.advance(chat.id, turn.end);
    return this.learnTurns(store, chat, rest, scope);
  }

  private async learnTurn(
    turn: LearningTurn,
    modelId: string,
    scope: TurnScope,
  ): Promise<ChatPassOutcome> {
    const { context, signal, tally, passId } = scope;
    tally.turnCount += 1;
    const mark = turn.user.mark;
    if (mark === undefined) {
      tally.memoryOffTurnCount += 1;
      return "done";
    }
    const forgotten = replayPendingForget(this.deps, {
      statement: turn.user,
      context,
      correlationId: turn.correlationId,
    });
    if (forgotten !== undefined) {
      tally.forgottenPendingCount += forgotten;
      tally.skippedTurnCount += 1;
      return "done";
    }
    const learning = await learnStoredTurn(
      this.deps,
      {
        request: {
          content: turn.user.content,
          sourceMessageId: turn.user.id,
          memory: { enabled: true, ...(mark.mode === undefined ? {} : { mode: mark.mode }) },
        },
        context,
        modelId,
        assistantText: turn.assistantText,
        surface: mark.surface,
        correlationId: turn.correlationId,
        parentCorrelationId: passId,
      },
      signal,
    );
    return this.settleTurn(turn, learning, tally);
  }

  private settleTurn(
    turn: LearningTurn,
    learning: StoredTurnLearning,
    tally: LearningPassTally,
  ): ChatPassOutcome {
    switch (learning.outcome) {
      case "learned":
        tally.learnedTurnCount += 1;
        tally.actionCount += learning.actionCount;
        this.failedAttempts.delete(turn.user.id);
        return "done";
      case "skipped":
        tally.skippedTurnCount += 1;
        return "done";
      case "cancelled":
        return "cancelled";
      case "unavailable":
        return "unavailable";
      case "failed":
        return this.settleFailedTurn(turn, tally);
    }
  }

  // The turn reported its own failure where it failed; here it only counts toward giving up on it.
  private settleFailedTurn(turn: LearningTurn, tally: LearningPassTally): ChatPassOutcome {
    tally.failedTurnCount += 1;
    const attempts = (this.failedAttempts.get(turn.user.id) ?? 0) + 1;
    if (attempts < MAX_FAILED_ATTEMPTS) {
      this.failedAttempts.set(turn.user.id, attempts);
      return "unavailable";
    }
    this.failedAttempts.delete(turn.user.id);
    return "done";
  }
}

// A pass that failed as a whole, not one of its turns: the runtime stays usable and retries later.
function reportLearningPassFailure(deps: UiHandlerDeps, passId: string, error: unknown): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: passId,
      operation: "memory.learn.pass",
      source: "memory-learning.runPass",
      error,
      redact: (message) => String(deps.redactor(message)),
    }),
  );
}

const runtimes = new WeakMap<UiStore, MemoryLearningRuntime>();

/** The learning runtime of this store, created on first use. */
export function memoryLearningRuntime(deps: UiHandlerDeps): MemoryLearningRuntime {
  const existing = runtimes.get(deps.store);
  if (existing !== undefined) {
    existing.rebind(deps);
    return existing;
  }
  const created = new MemoryLearningRuntime(deps);
  runtimes.set(deps.store, created);
  return created;
}

/** Ends the store's learning runtime, if one was created. */
export function disposeMemoryLearningRuntime(deps: Pick<UiHandlerDeps, "store">): void {
  runtimes.get(deps.store)?.dispose();
  runtimes.delete(deps.store);
}
