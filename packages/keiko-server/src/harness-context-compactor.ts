// Server-side HarnessCompactionPort wiring (KEIKO-0726, #3323). The harness package stays
// decoupled from keiko-workflows (context-compaction-port.ts, mirroring the existing
// harness-tool-shaper.ts precedent for HarnessShaperPort); the server already depends on
// keiko-workflows/context-budget and is the right tier to inject the compactor.
//
// Reference shape: the keiko-workflows context-budget allocator (allocateContext +
// DEFAULT_CONTEXT_BUDGET) is the SAME allocator/eviction-policy machinery
// chat-prompt-budget.ts's selectPromptLanes already runs for the chat path. Growth here is
// mapped onto its "history-summary" lane.
//
// Segmentation (fixed post-review, KEIKO-0726 blocker 2): the harness NEVER produces more than
// one role:"user" message in a run's entire lifetime — every task plan seeds exactly one
// `[system, user]` pair (tasks/*.ts) and the loop thereafter appends only role:"assistant"
// (handleModelCall) and role:"tool" (handleToolCall) messages, confirmed by grepping every
// producer under packages/keiko-harness/src. Segmenting on role:"user" boundaries (the original
// shape of this file) therefore always produced exactly one turn and the port always declined —
// a structural no-op against every real harness run. The units the harness actually produces are
// ASSISTANT-message boundaries: each model response plus the tool-role results it triggers. Turns
// now split on role:"assistant", and the leading `[system, user]` seed (everything before the
// FIRST assistant message) is protected as non-evictable head, exactly like the chat path's
// non-evictable "system-contract" lane.
//
// Profile-present precondition (mirrors chat-handlers.ts's
// `currentContextProfileForModel(deps, modelId) ?? DEFAULT_CONTEXT_PROFILE`): a ContextProfile is
// ALWAYS resolved here too, via the identical fallback, so the allocator always has real
// token-budget/eviction-policy math to run against.
//
// Reconciliation with HarnessShaperPort (ADR-0055 D4): this port never rewrites the CONTENT of a
// role:"tool" message (whether raw or already substituted by the shaper) — it only ever keeps or
// evicts a whole turn, so the two mechanisms are scoped to disjoint responsibilities and never
// fight over the same edit (context-compaction-port.ts documents the full contract).
//
// The allocator reasons in TOKENS (ADR-0052); maxContextBytes is the harness's own
// zero-dependency byte proxy (ADR-0004 D3). The allocator's exclusion count is used as a
// starting point, but the final decision is re-verified against actual bytes and escalated one
// turn at a time until it truly fits — ground truth is always the byte count, never the
// allocator's token estimate alone.

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import type {
  HarnessCompactionInput,
  HarnessCompactionPort,
  HarnessEvent,
} from "@oscharko-dev/keiko-harness";
import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import { DEFAULT_CONTEXT_PROFILE } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  allocateContext,
  DEFAULT_CONTEXT_BUDGET,
  type ContextLaneInput,
} from "@oscharko-dev/keiko-workflows/context-budget";
import { processServerLogSink } from "./process-log-sink.js";
import type { ServerLogSink } from "./observability/server-log.js";

const HISTORY_LANE = "history-summary" as const;
const NOTICE_KIND = "keiko.compactedHistoryNotice";

interface Turn {
  readonly id: string;
  readonly messages: readonly ChatMessage[];
}

interface LeadingSplit {
  readonly head: readonly ChatMessage[];
  readonly rest: readonly ChatMessage[];
}

// Everything before the FIRST role:"assistant" message is the harness's non-evictable seed — the
// task-defining system prompt(s) plus the single role:"user" message every task plan seeds
// (tasks/*.ts). Never a candidate for eviction, structurally equivalent to the chat path's
// non-evictable "system-contract" lane.
function splitLeadingSeed(messages: readonly ChatMessage[]): LeadingSplit {
  let index = 0;
  while (index < messages.length && messages[index]?.role !== "assistant") {
    index += 1;
  }
  return { head: messages.slice(0, index), rest: messages.slice(index) };
}

// Splits the post-seed remainder into turns: each turn starts at a role:"assistant" message
// (a model response) and includes every following message up to (not including) the next
// role:"assistant" message — this keeps an assistant's tool calls and their role:"tool" results
// together as one atomic unit, so evicting a turn can never orphan a tool result from the
// assistant call that produced it.
function splitTurns(messages: readonly ChatMessage[]): readonly Turn[] {
  const turns: Turn[] = [];
  let current: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && current.length > 0) {
      turns.push({ id: `turn-${String(turns.length).padStart(4, "0")}`, messages: current });
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) {
    turns.push({ id: `turn-${String(turns.length).padStart(4, "0")}`, messages: current });
  }
  return turns;
}

function turnText(turn: Turn): string {
  return turn.messages.map((message) => `${message.role}:${message.content}`).join("\n");
}

// Older turns score lower (mirrors chat-prompt-budget.ts's historyLaneItems `score: index + 1`)
// so the allocator's score-descending fill keeps the newest evictable turns first and excludes
// the oldest ones under budget pressure.
function historyLane(evictable: readonly Turn[]): ContextLaneInput {
  return {
    laneId: HISTORY_LANE,
    items: evictable.map((turn, index) => ({
      id: turn.id,
      text: turnText(turn),
      score: index + 1,
    })),
  };
}

interface ParsedNotice {
  readonly droppedTurns: number;
}

function parseNotice(content: string): ParsedNotice | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { kind?: unknown }).kind === NOTICE_KIND
    ) {
      const dropped = (parsed as { droppedTurns?: unknown }).droppedTurns;
      return { droppedTurns: typeof dropped === "number" ? dropped : 0 };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Non-blocking defect fixed post-review: a notice inserted by an earlier compaction pass sits at
// role:"system" and would otherwise be absorbed into the permanently non-evictable head on the
// NEXT pass (splitLeadingSeed stops only at the first role:"assistant" message), silently
// accumulating one stale notice per pass. Every existing notice is stripped out and its count
// folded into the running total BEFORE segmentation, so exactly one notice — reflecting the TOTAL
// turns dropped across every pass, not just this one — is ever present in the result.
interface StrippedNotices {
  readonly messages: readonly ChatMessage[];
  readonly priorDroppedTurns: number;
}

function stripNotices(messages: readonly ChatMessage[]): StrippedNotices {
  let priorDroppedTurns = 0;
  const kept: ChatMessage[] = [];
  for (const message of messages) {
    const notice = message.role === "system" ? parseNotice(message.content) : undefined;
    if (notice === undefined) {
      kept.push(message);
    } else {
      priorDroppedTurns += notice.droppedTurns;
    }
  }
  return { messages: kept, priorDroppedTurns };
}

// A content-free, deterministic placeholder marking that older turns were evicted for budget —
// no summarization, no raw content, just a count (ADR-0173 D4 body-free discipline).
function droppedNoticeMessage(totalDroppedTurns: number): ChatMessage {
  return {
    role: "system",
    content: JSON.stringify({ kind: NOTICE_KIND, droppedTurns: totalDroppedTurns }),
  };
}

function flatten(turns: readonly Turn[]): readonly ChatMessage[] {
  return turns.flatMap((turn) => turn.messages);
}

const byteEncoder = new TextEncoder();

function messageBytes(messages: readonly ChatMessage[]): number {
  return byteEncoder.encode(JSON.stringify(messages)).length;
}

// Escalates dropCount one turn at a time, starting from the allocator's own exclusion count,
// until the reconstructed array actually fits maxContextBytes. Returns undefined if even
// dropping every evictable turn (keeping only the protected tail) does not fit. `priorDroppedTurns`
// carries forward the count from any notice this pass stripped, so a merged notice always states
// the total ever dropped, never only this pass's contribution.
interface FitUnderBytesResult {
  readonly messages: readonly ChatMessage[];
  // Raw content messages actually evicted THIS pass (the dropped turns), excluding the
  // replacement notice — never a net array-length delta, which undercounts whenever a notice is
  // inserted in place of what was removed.
  readonly messagesEvicted: number;
}

function fitUnderBytes(
  head: readonly ChatMessage[],
  evictable: readonly Turn[],
  protectedTail: readonly Turn[],
  startDropCount: number,
  priorDroppedTurns: number,
  maxContextBytes: number,
): FitUnderBytesResult | undefined {
  for (let dropCount = startDropCount; dropCount <= evictable.length; dropCount += 1) {
    const droppedTurns = evictable.slice(0, dropCount);
    const kept = evictable.slice(dropCount);
    const totalDropped = priorDroppedTurns + dropCount;
    const notice = totalDropped > 0 ? [droppedNoticeMessage(totalDropped)] : [];
    const candidate = [...head, ...notice, ...flatten(kept), ...flatten(protectedTail)];
    if (messageBytes(candidate) <= maxContextBytes) {
      return { messages: candidate, messagesEvicted: flatten(droppedTurns).length };
    }
  }
  return undefined;
}

function excludedTurnCount(evictable: readonly Turn[], profile: ContextProfile): number {
  if (evictable.length === 0) {
    return 0;
  }
  const allocation = allocateContext({
    profile,
    budget: { ...DEFAULT_CONTEXT_BUDGET, profile },
    lanes: [historyLane(evictable)],
  });
  return allocation.lanes.find((lane) => lane.laneId === HISTORY_LANE)?.excludedItemIds.length ?? 0;
}

export interface ServerHarnessContextCompactorOptions {
  readonly contextProfile?: ContextProfile | undefined;
}

export function createServerHarnessContextCompactor(
  options: ServerHarnessContextCompactorOptions = {},
): HarnessCompactionPort {
  const profile = options.contextProfile ?? DEFAULT_CONTEXT_PROFILE;
  return (input: HarnessCompactionInput) => {
    const { messages: withoutNotices, priorDroppedTurns } = stripNotices(input.messages);
    const { head, rest } = splitLeadingSeed(withoutNotices);
    const turns = splitTurns(rest);
    // Fewer than 2 turns means there is nothing to evict without dropping the run's only
    // (most recent) turn — the same "preserve the newest turn" guarantee
    // conversationForGatewayWithCompaction makes for the chat path.
    if (turns.length < 2) {
      return undefined;
    }
    const protectedTail = turns.slice(-1);
    const evictable = turns.slice(0, -1);
    const startDropCount = Math.max(1, excludedTurnCount(evictable, profile));
    const fit = fitUnderBytes(
      head,
      evictable,
      protectedTail,
      startDropCount,
      priorDroppedTurns,
      input.maxContextBytes,
    );
    return fit === undefined
      ? undefined
      : { messages: fit.messages, messagesEvicted: fit.messagesEvicted };
  };
}

export const serverHarnessContextCompactor: HarnessCompactionPort =
  createServerHarnessContextCompactor();

export interface HarnessCompactionLogContext {
  // The correlation id of the request/run that spawned this HarnessEvent run, when one is known
  // (ADR-0173 D5 / g12). event.runId is a fresh id the harness mints for its own run — with no
  // parentCorrelationId, a background compaction line cannot be joined back to the governed run
  // that spawned it.
  readonly parentCorrelationId?: string | undefined;
}

// KEIKO-0726 (#3323) / AGENTS.md §8 Rule 1: bridges the harness's own body-free
// "context:compacted" event (emitted via ctx.emitter by loop.ts's tryCompact the moment this port
// succeeds) into the server's activity log, so a run whose history was evicted is reconstructable
// from server.log alone. The harness package itself never imports the server's logging port
// (ADR-0019); this bridge lives at the server tier that already owns both. Call once per resolved
// RunResult, mirroring agentProducerRoute.ts's existing post-hoc `result.events.filter(...)`
// pattern — a run with no compaction emits nothing, so this is a no-op for the overwhelming
// majority of runs. Body-free by construction: counts and byte totals only (ADR-0173 D4).
export function logHarnessContextCompactionEvents(
  events: readonly HarnessEvent[],
  context: HarnessCompactionLogContext = {},
  activityLog: ServerLogSink = processServerLogSink(),
): void {
  for (const event of events) {
    if (event.type !== "context:compacted") {
      continue;
    }
    activityLog.write({
      category: "process",
      op: "harness.context.compacted",
      correlationId: event.runId,
      ...(context.parentCorrelationId === undefined
        ? {}
        : { parentCorrelationId: context.parentCorrelationId }),
      extra: {
        messagesDropped: event.messagesDropped,
        bytesBefore: event.bytesBefore,
        bytesAfter: event.bytesAfter,
      },
    });
  }
}
