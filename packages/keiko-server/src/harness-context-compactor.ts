// Server-side HarnessCompactionPort wiring (KEIKO-0726, #3323). The harness package stays
// decoupled from keiko-workflows (context-compaction-port.ts, mirroring the existing
// harness-tool-shaper.ts precedent for HarnessShaperPort).
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
// Reconciliation with HarnessShaperPort (ADR-0055 D4): this port never rewrites the CONTENT of a
// role:"tool" message (whether raw or already substituted by the shaper) — it only ever keeps or
// evicts a whole turn, so the two mechanisms are scoped to disjoint responsibilities and never
// fight over the same edit (context-compaction-port.ts documents the full contract).
//
// Byte ground truth, no token estimate involved (2895 audit KEIKO-0900/KEIKO-0901 follow-up): this
// gate is governed exclusively by maxContextBytes, the harness's own zero-dependency byte proxy
// (ADR-0004 D3) — never by a token estimate. An earlier revision seeded the eviction-count search
// from the keiko-workflows context-budget allocator's exclusion count for a "history-summary" lane
// capped at a fixed 16,000 TOKENS, regardless of the actual byte budget or which ContextProfile was
// resolved for the call. Because the search below only ever escalates upward from that seed, a
// history just one byte over maxContextBytes could lose nearly every old turn merely for exceeding
// the allocator's unrelated 16k-token lane cap — the opposite of the "bytes are ground truth"
// contract this file documents, and irreversible (evicted turns are never restored once the byte
// check passes). The fix removes the allocator from this decision entirely: fitUnderBytes always
// starts its search at the true minimum (drop exactly the single oldest turn) and escalates one
// turn at a time, re-measuring real bytes at every step, so the search itself — never a token
// estimate, and never any particular ContextProfile — determines how much history is lost. A
// ContextProfile is therefore no longer resolved or accepted by this module: there is no remaining
// decision left for one to govern (AGENTS.md §6 — this file no longer carries the now-dead
// allocator/profile plumbing that used to feed that decision).

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import type {
  HarnessCompactionInput,
  HarnessCompactionPort,
  HarnessEvent,
} from "@oscharko-dev/keiko-harness";
import { processServerLogSink } from "./process-log-sink.js";
import type { ServerLogSink } from "./observability/server-log.js";

const NOTICE_KIND = "keiko.compactedHistoryNotice";

interface Turn {
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
      turns.push({ messages: current });
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) {
    turns.push({ messages: current });
  }
  return turns;
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

// Escalates dropCount one turn at a time STARTING AT THE MINIMUM (the single oldest turn), until
// the reconstructed array actually fits maxContextBytes — never trusting anything but a fresh
// byte measurement of the candidate array itself. Returns undefined if even dropping every
// evictable turn (keeping only the protected tail) does not fit. `priorDroppedTurns` carries
// forward the count from any notice this pass stripped, so a merged notice always states the
// total ever dropped, never only this pass's contribution.
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
  priorDroppedTurns: number,
  maxContextBytes: number,
): FitUnderBytesResult | undefined {
  for (let dropCount = 1; dropCount <= evictable.length; dropCount += 1) {
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

export function createServerHarnessContextCompactor(): HarnessCompactionPort {
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
    const fit = fitUnderBytes(
      head,
      evictable,
      protectedTail,
      priorDroppedTurns,
      input.maxContextBytes,
    );
    return fit === undefined
      ? undefined
      : { messages: fit.messages, messagesEvicted: fit.messagesEvicted };
  };
}

// A single shared instance is safe and sufficient: the port is a pure, stateless function of its
// input (no per-model/per-session configuration remains — see the header comment), so every
// production call site can inject this same instance rather than constructing its own.
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
