// PR4-W2 chat history-compaction splice (ADR-0055 D3) — the ONE genuine behavioral change in the
// context-engineering milestone. A PURE, deterministic, offline, no-clock, no-random shim that
// wraps conversationForGateway (conversation-gateway.ts).
//
// ACTIVATION PREDICATE (budget-safe verbatim preservation, ADR-0055 D6):
//   activeProfile = opts.contextProfile ?? DEFAULT_CONTEXT_PROFILE
//   effectiveInputBudget = opts.effectiveInputBudget ?? activeProfile.effectiveInputBudget
//   fullFilteredGatewayTokens <= effectiveInputBudget
// When true, this returns the system message plus the full usable filtered history — no
// count-based slice truncation — so budget-safe conversations stay verbatim.
//
// SLOW PATH (full filtered history exceeds the effective input budget): the oldest prefix that
// still allows the system message, a deterministic redacted summary, and the retained recent tail
// are compacted into a single summary segment (role "user", model-agnostic-safe — not a second
// system turn) placed immediately AFTER the existing system message, accompanied by a validated
// ContextCompactionRecord. No model call.

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  DEFAULT_CONTEXT_PROFILE,
  estimateTokens,
  estimateTokensForSegments,
  stripUnsafeFormatChars,
  validateContextCompactionRecord,
  type ContextCompactionRecord,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import { redact } from "@oscharko-dev/keiko-security";
import type { ChatMessage } from "./store/index.js";
import {
  conversationForGateway,
  usableGatewayMessages,
  type GatewayConversationMessage,
} from "./conversation-gateway.js";

export interface ConversationCompactionOptions {
  readonly contextProfile?: ContextProfile | undefined;
  readonly effectiveInputBudget?: number | undefined;
  readonly redactionSecrets?: readonly string[] | undefined;
}

export interface ConversationCompactionOutcome {
  readonly messages: GatewayConversationMessage[];
  readonly compaction?: ContextCompactionRecord | undefined;
}

// Per-dropped-message redacted snippet budget (UTF-8 bytes). Bounds a single noisy turn.
const SNIPPET_BYTE_BUDGET = 200;

interface DroppedTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly stableId: string;
  readonly contentTokens: number;
  readonly redactedSnippet: string;
}

interface CompactionSelection {
  readonly dropCount: number;
  readonly summaryContent: string;
}

// Deterministic, offline, predicate-gated wrapper over conversationForGateway. On the fast path it
// returns the full usable history verbatim; on the slow path it inserts a redacted summary after
// the system message so platform instructions remain first.
export function conversationForGatewayWithCompaction(
  messages: readonly ChatMessage[],
  opts: ConversationCompactionOptions = {},
): ConversationCompactionOutcome {
  const filtered = usableGatewayMessages(messages);
  const gatewayMessages = conversationForGateway(messages);
  const systemMessage = gatewayMessages[0];
  const activeProfile = opts.contextProfile ?? DEFAULT_CONTEXT_PROFILE;
  const effectiveInputBudget = opts.effectiveInputBudget ?? activeProfile.effectiveInputBudget;
  const fullVerbatimMessages = buildVerbatimMessages(systemMessage, filtered);
  const fullVerbatimTokens = estimateTokensForSegments(
    fullVerbatimMessages.map((message) => message.content),
  );
  if (fullVerbatimTokens <= effectiveInputBudget) {
    return { messages: fullVerbatimMessages };
  }

  const prepared = prepareDroppedTurns(filtered, opts.redactionSecrets);
  const selection = selectCompaction(prepared, systemMessage, effectiveInputBudget);
  if (selection === undefined) {
    throw new ContextOverflowError(
      "conversation history exceeds the effective input budget and cannot be compacted without overflow.",
    );
  }
  return buildCompactedOutcome(prepared, systemMessage, selection);
}

function buildVerbatimMessages(
  systemMessage: GatewayConversationMessage | undefined,
  filtered: readonly { role: "user" | "assistant"; content: string }[],
): GatewayConversationMessage[] {
  const retained = filtered.map((turn) => ({ role: turn.role, content: turn.content }));
  return systemMessage === undefined ? retained : [systemMessage, ...retained];
}

function buildCompactedOutcome(
  prepared: readonly DroppedTurn[],
  systemMessage: GatewayConversationMessage | undefined,
  selection: CompactionSelection,
): ConversationCompactionOutcome {
  const dropped = prepared.slice(0, selection.dropCount);
  const retained = prepared.slice(selection.dropCount);
  const summarySegment: GatewayConversationMessage = {
    role: "user",
    content: selection.summaryContent,
  };
  const record = buildRecord(dropped, selection.summaryContent);
  return {
    messages: buildCompactedMessages(systemMessage, summarySegment, retained),
    compaction: record,
  };
}

function buildCompactedMessages(
  systemMessage: GatewayConversationMessage | undefined,
  summarySegment: GatewayConversationMessage,
  retained: readonly DroppedTurn[],
): GatewayConversationMessage[] {
  const retainedMessages = retained.map((turn) => ({ role: turn.role, content: turn.content }));
  return systemMessage === undefined
    ? [summarySegment, ...retainedMessages]
    : [systemMessage, summarySegment, ...retainedMessages];
}

function selectCompaction(
  prepared: readonly DroppedTurn[],
  systemMessage: GatewayConversationMessage | undefined,
  effectiveInputBudget: number,
): CompactionSelection | undefined {
  const systemContent = systemMessage?.content;
  if (systemContent === undefined && prepared.length === 0) {
    return undefined;
  }
  const tokenPrefix = buildTokenPrefix(prepared);
  const maxDropCount = prepared.length - 1;
  if (maxDropCount < 1) {
    return undefined;
  }
  for (let dropCount = 1; dropCount <= maxDropCount; dropCount += 1) {
    const selection = selectCompactionCandidate(
      prepared,
      tokenPrefix,
      dropCount,
      systemContent,
      effectiveInputBudget,
    );
    if (selection !== undefined) {
      return selection;
    }
  }
  return undefined;
}

function buildTokenPrefix(prepared: readonly DroppedTurn[]): number[] {
  const tokenPrefix: number[] = [0];
  for (const turn of prepared) {
    const previousTotal = tokenPrefix[tokenPrefix.length - 1] ?? 0;
    tokenPrefix.push(previousTotal + turn.contentTokens);
  }
  return tokenPrefix;
}

function selectCompactionCandidate(
  prepared: readonly DroppedTurn[],
  tokenPrefix: readonly number[],
  dropCount: number,
  systemContent: string | undefined,
  effectiveInputBudget: number,
): CompactionSelection | undefined {
  const retained = prepared.slice(dropCount);
  const retainedContents = retained.map((turn) => turn.content);
  const retainedContentTokens =
    (tokenPrefix[tokenPrefix.length - 1] ?? 0) - (tokenPrefix[dropCount] ?? 0);
  const systemTokens = systemContent === undefined ? 0 : estimateTokens(systemContent);
  if (systemTokens + retainedContentTokens > effectiveInputBudget) {
    return undefined;
  }
  const candidatePrefix =
    systemContent === undefined ? retainedContents : [systemContent, ...retainedContents];
  const retainedTokens = estimateTokensForSegments(candidatePrefix);
  const summaryBudget = effectiveInputBudget - retainedTokens;
  if (summaryBudget < 2) {
    return undefined;
  }
  const summaryContent = buildSummaryContent(prepared.slice(0, dropCount), summaryBudget);
  if (summaryContent === undefined) {
    return undefined;
  }
  const candidateTokens = estimateTokensForSegments([
    ...(systemContent === undefined ? [] : [systemContent]),
    summaryContent,
    ...retainedContents,
  ]);
  return candidateTokens <= effectiveInputBudget ? { dropCount, summaryContent } : undefined;
}

function prepareDroppedTurns(
  prefix: readonly { role: "user" | "assistant"; content: string }[],
  redactionSecrets: readonly string[] | undefined,
): DroppedTurn[] {
  return prefix.map((turn, index) => ({
    role: turn.role,
    content: turn.content,
    stableId: `history-msg-${String(index)}`,
    contentTokens: estimateTokens(turn.content),
    redactedSnippet: snippetFor(turn.content, redactionSecrets),
  }));
}

// Redact + byte-bound a single dropped turn to a one-line snippet. UTF-8-safe truncation.
function snippetFor(content: string, redactionSecrets: readonly string[] | undefined): string {
  const redacted = redact(stripUnsafeFormatChars(content), redactionSecrets ?? [])
    .replace(/\s+/gu, " ")
    .trim();
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

function buildSummaryContent(
  dropped: readonly DroppedTurn[],
  summaryTokenBudget: number,
): string | undefined {
  if (summaryTokenBudget <= 2) {
    return undefined;
  }
  const lines: string[] = [
    SUMMARY_HEADER,
    `Dropped ${String(dropped.length)} earlier turn(s); represented in the compaction provenance record.`,
  ];
  for (const turn of dropped) {
    const candidate = `- [${turn.role}] ${turn.redactedSnippet}`;
    const next = [...lines, candidate].join("\n");
    if (estimateTokens(next) > summaryTokenBudget) {
      break;
    }
    lines.push(candidate);
  }
  const summary = lines.join("\n");
  return estimateTokens(summary) <= summaryTokenBudget ? summary : undefined;
}

function buildRecord(
  dropped: readonly DroppedTurn[],
  summaryContent: string,
): ContextCompactionRecord {
  if (dropped.length === 0) {
    throw new Error("conversation-compaction cannot emit a zero-item summary record");
  }
  const tokensBefore = dropped.reduce((sum, turn) => sum + turn.contentTokens, 0);
  const record: ContextCompactionRecord = {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "history-summary",
    reason: "exceeded effective input budget",
    itemsBefore: dropped.length,
    itemsAfter: 1,
    tokensBefore,
    tokensAfter: estimateTokens(summaryContent),
    orderedAt: dropped.length,
    sourceSpans: dropped.map((turn) => ({ kind: "message", stableId: turn.stableId })),
  };
  const validation = validateContextCompactionRecord(record);
  if (!validation.ok) {
    throw new Error(
      `conversation-compaction produced an invalid record: ${validation.reasons.join(", ")}`,
    );
  }
  return record;
}
