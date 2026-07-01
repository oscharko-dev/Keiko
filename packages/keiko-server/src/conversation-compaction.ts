// PR4-W2 chat history-compaction splice (ADR-0055 D3) — the ONE genuine behavioral change in the
// context-engineering milestone. A PURE, deterministic, offline, no-clock, no-random shim that
// wraps conversationForGateway (chat-handlers.ts).
//
// ACTIVATION PREDICATE (the unchanged-guarantee, ADR-0055 D6):
//   opts.contextProfile === undefined  ||  assembledGatewayTokens <= opts.contextProfile.effectiveInputBudget
// When true, this returns the EXACT return value of conversationForGateway(messages) — no copy,
// no spread, no transform — so short sessions and no-profile callers are byte-identical to today.
//
// SLOW PATH (profile present AND assembled tokens exceed the effective input budget): the older
// turns that would otherwise overrun the budget are folded into a single deterministic, REDACTED,
// byte-bounded summary segment (role "user", model-agnostic-safe — not a second system turn)
// placed immediately AFTER the existing system message, accompanied by a validated
// ContextCompactionRecord. No model call.

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  estimateTokens,
  estimateTokensForSegments,
  validateContextCompactionRecord,
  type ContextCompactionRecord,
  type ContextProfile,
  type ContextProvenanceRef,
} from "@oscharko-dev/keiko-contracts";
import { redact } from "@oscharko-dev/keiko-security";
import type { ChatMessage } from "./store/index.js";
import {
  MAX_CONTEXT_MESSAGES,
  conversationForGateway,
  usableGatewayMessages,
  type GatewayConversationMessage,
} from "./chat-handlers.js";

export interface ConversationCompactionOptions {
  readonly contextProfile?: ContextProfile | undefined;
}

export interface ConversationCompactionOutcome {
  readonly messages: GatewayConversationMessage[];
  readonly compaction?: ContextCompactionRecord | undefined;
}

// Per-dropped-message redacted snippet budget (UTF-8 bytes). Bounds a single noisy turn.
const SNIPPET_BYTE_BUDGET = 200;
// Total token budget for the whole synthetic summary segment (a few KB at ~3.5 bytes/token).
const SUMMARY_TOKEN_BUDGET = 1024;

interface DroppedTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly stableId: string;
}

// Deterministic, offline, predicate-gated wrapper over conversationForGateway. On the fast path it
// returns the existing function's value verbatim; on the slow path it inserts a redacted summary
// after the system message so platform instructions remain first.
export function conversationForGatewayWithCompaction(
  messages: readonly ChatMessage[],
  opts: ConversationCompactionOptions = {},
): ConversationCompactionOutcome {
  const filtered = usableGatewayMessages(messages);
  const gatewayMessages = conversationForGateway(messages);
  if (opts.contextProfile === undefined) {
    return { messages: gatewayMessages };
  }
  const assembledTokens = estimateTokensForSegments(gatewayMessages.map((message) => message.content));
  if (assembledTokens <= opts.contextProfile.effectiveInputBudget) {
    return { messages: gatewayMessages };
  }
  return buildCompactedOutcome(filtered, gatewayMessages[0], opts.contextProfile.effectiveInputBudget);
}

function buildCompactedOutcome(
  filtered: readonly { role: "user" | "assistant"; content: string }[],
  systemMessage: GatewayConversationMessage | undefined,
  effectiveInputBudget: number,
): ConversationCompactionOutcome {
  const dropCount = selectDropCount(filtered, systemMessage, effectiveInputBudget);
  const dropped = toDroppedTurns(filtered.slice(0, dropCount));
  const retained = filtered.slice(dropCount);
  const summaryContent = buildSummaryContent(dropped);
  const summarySegment: GatewayConversationMessage = { role: "user", content: summaryContent };
  const record = buildRecord(dropped, summaryContent);
  return {
    messages: systemMessage === undefined ? [summarySegment, ...retained] : [systemMessage, summarySegment, ...retained],
    compaction: record,
  };
}

function selectDropCount(
  filtered: readonly { role: "user" | "assistant"; content: string }[],
  systemMessage: GatewayConversationMessage | undefined,
  effectiveInputBudget: number,
): number {
  const initialDropCount =
    filtered.length > MAX_CONTEXT_MESSAGES ? filtered.length - MAX_CONTEXT_MESSAGES : 1;
  let dropCount = Math.min(Math.max(1, initialDropCount), filtered.length);
  while (dropCount <= filtered.length) {
    const dropped = toDroppedTurns(filtered.slice(0, dropCount));
    const summaryContent = buildSummaryContent(dropped);
    const retained = filtered.slice(dropCount);
    if (assembledTokens(systemMessage, summaryContent, retained) <= effectiveInputBudget) {
      return dropCount;
    }
    if (dropCount === filtered.length) {
      return dropCount;
    }
    dropCount += 1;
  }
  return filtered.length;
}

function toDroppedTurns(
  prefix: readonly { role: "user" | "assistant"; content: string }[],
): DroppedTurn[] {
  return prefix.map((turn, index) => ({
    role: turn.role,
    content: turn.content,
    stableId: `history-msg-${String(index)}`,
  }));
}

// Redact + byte-bound a single dropped turn to a one-line snippet. UTF-8-safe truncation.
function snippetFor(turn: DroppedTurn): string {
  const redacted = redact(turn.content).replace(/\s+/gu, " ").trim();
  const bytes = new TextEncoder().encode(redacted);
  if (bytes.length <= SNIPPET_BYTE_BUDGET) {
    return redacted;
  }
  const slice = bytes.slice(0, SNIPPET_BYTE_BUDGET);
  return new TextDecoder("utf-8", { fatal: false }).decode(slice).trimEnd() + "…";
}

const SUMMARY_HEADER =
  "[Automated summary of earlier conversation turns — older messages were compacted to fit the " +
  "context window. The verbatim recent turns follow below.]";

function buildSummaryContent(dropped: readonly DroppedTurn[]): string {
  const lines: string[] = [SUMMARY_HEADER, `Dropped ${String(dropped.length)} earlier turn(s):`];
  let omitted = 0;
  for (const turn of dropped) {
    const candidate = `- [${turn.role}] ${snippetFor(turn)}`;
    const next = [...lines, candidate].join("\n");
    if (estimateTokens(next) > SUMMARY_TOKEN_BUDGET) {
      omitted += 1;
      continue;
    }
    lines.push(candidate);
  }
  if (omitted > 0) {
    lines.push(
      `…and ${String(omitted)} further turn(s) omitted to stay within the summary budget.`,
    );
  }
  return lines.join("\n");
}

function sourceSpansFor(dropped: readonly DroppedTurn[]): ContextProvenanceRef[] {
  return dropped.map((turn) => ({ kind: "message", stableId: turn.stableId }));
}

function assembledTokens(
  systemMessage: GatewayConversationMessage | undefined,
  summaryContent: string,
  retained: readonly { role: "user" | "assistant"; content: string }[],
): number {
  const segments =
    systemMessage === undefined
      ? [summaryContent, ...retained.map((turn) => turn.content)]
      : [systemMessage.content, summaryContent, ...retained.map((turn) => turn.content)];
  return estimateTokensForSegments(segments);
}

function buildRecord(
  dropped: readonly DroppedTurn[],
  summaryContent: string,
): ContextCompactionRecord {
  const tokensBefore = estimateTokensForSegments(dropped.map((turn) => turn.content));
  const record: ContextCompactionRecord = {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "history-summary",
    reason: "exceeded effective input budget",
    itemsBefore: dropped.length,
    itemsAfter: 0,
    tokensBefore,
    tokensAfter: estimateTokens(summaryContent),
    orderedAt: dropped.length,
    sourceSpans: sourceSpansFor(dropped),
  };
  const validation = validateContextCompactionRecord(record);
  if (!validation.ok) {
    throw new Error(
      `conversation-compaction produced an invalid record: ${validation.reasons.join(", ")}`,
    );
  }
  return record;
}
