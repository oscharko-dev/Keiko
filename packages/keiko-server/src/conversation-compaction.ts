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
  maxUtf8BytesForTokenBudget,
  stripUnsafeFormatChars,
  validateContextCompactionRecord,
  type ContextCompactionRecord,
  type ContextProfile,
  type ContextProvenanceRef,
} from "@oscharko-dev/keiko-contracts";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
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
  if (filtered.length === 0) {
    return { messages: gatewayMessages };
  }
  const prepared = prepareDroppedTurns(filtered, opts.redactionSecrets);
  const systemMessage = gatewayMessages[0];
  const systemTokens = systemMessage === undefined ? 0 : estimateTokens(systemMessage.content);
  const totalContentTokens = prepared.reduce((sum, turn) => sum + turn.contentTokens, 0);
  const assembledTokens = systemTokens + totalContentTokens;
  if (assembledTokens <= opts.contextProfile.effectiveInputBudget) {
    return { messages: gatewayMessages };
  }
  const selection = selectCompaction(prepared, systemTokens, opts.contextProfile.effectiveInputBudget);
  if (selection === undefined) {
    throw new ContextOverflowError(
      "conversation history exceeds the effective input budget and cannot be compacted without overflow.",
    );
  }
  return buildCompactedOutcome(prepared, systemMessage, selection);
}

function buildCompactedOutcome(
  prepared: readonly DroppedTurn[],
  systemMessage: GatewayConversationMessage | undefined,
  selection: { readonly dropCount: number; readonly summaryContent: string },
): ConversationCompactionOutcome {
  const dropped = prepared.slice(0, selection.dropCount);
  const retained = prepared.slice(selection.dropCount);
  const summarySegment: GatewayConversationMessage = {
    role: "user",
    content: selection.summaryContent,
  };
  const record = buildRecord(dropped, selection.summaryContent);
  return {
    messages:
      systemMessage === undefined
        ? [summarySegment, ...retained.map((turn) => ({ role: turn.role, content: turn.content }))]
        : [
            systemMessage,
            summarySegment,
            ...retained.map((turn) => ({ role: turn.role, content: turn.content })),
          ],
    compaction: record,
  };
}

function selectCompaction(
  prepared: readonly DroppedTurn[],
  systemTokens: number,
  effectiveInputBudget: number,
): { readonly dropCount: number; readonly summaryContent: string } | undefined {
  const remainingForSummary = effectiveInputBudget - systemTokens;
  if (remainingForSummary < 2) {
    return undefined;
  }
  const tokenPrefix: number[] = [0];
  for (const turn of prepared) {
    const previousTotal = tokenPrefix[tokenPrefix.length - 1] ?? 0;
    tokenPrefix.push(previousTotal + turn.contentTokens);
  }
  const initialDropCount =
    prepared.length > MAX_CONTEXT_MESSAGES ? prepared.length - MAX_CONTEXT_MESSAGES : 1;
  for (
    let dropCount = Math.min(Math.max(1, initialDropCount), prepared.length);
    dropCount <= prepared.length;
    dropCount += 1
  ) {
    const retainedTokens = (tokenPrefix[prepared.length] ?? 0) - (tokenPrefix[dropCount] ?? 0);
    const summaryBudget = remainingForSummary - retainedTokens;
    if (summaryBudget < 2) {
      continue;
    }
    const summaryContent = buildSummaryContent(prepared.slice(0, dropCount), summaryBudget);
    if (estimateTokens(summaryContent) <= summaryBudget) {
      return { dropCount, summaryContent };
    }
  }
  return undefined;
}

function prepareDroppedTurns(
  prefix: readonly { role: "user" | "assistant"; content: string }[],
  redactionSecrets: readonly string[] | undefined,
): DroppedTurn[] {
  return prefix.map((turn, index) => {
    const content = turn.content;
    const stableId = `history-msg-${String(index)}`;
    const redactedSnippet = snippetFor(content, redactionSecrets);
    return {
      role: turn.role,
      content,
      stableId,
      contentTokens: estimateTokens(content),
      redactedSnippet,
    };
  });
}

// Redact + byte-bound a single dropped turn to a one-line snippet. UTF-8-safe truncation.
function snippetFor(content: string, redactionSecrets: readonly string[] | undefined): string {
  const redacted = redact(stripUnsafeFormatChars(content), redactionSecrets ?? []).replace(
    /\s+/gu,
    " ",
  ).trim();
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

function buildSummaryContent(dropped: readonly DroppedTurn[], summaryTokenBudget: number): string {
  if (summaryTokenBudget <= 2) {
    return "";
  }
  const lines: string[] = [SUMMARY_HEADER, `Dropped ${String(dropped.length)} earlier turn(s):`];
  let omitted = 0;
  for (const turn of dropped) {
    const candidate = `- [${turn.role}] ${turn.redactedSnippet}`;
    const next = [...lines, candidate].join("\n");
    if (estimateTokens(next) > summaryTokenBudget) {
      omitted += 1;
      continue;
    }
    lines.push(candidate);
  }
  if (omitted > 0) {
    const omittedLine = `…and ${String(omitted)} further turn(s) omitted to stay within the summary budget.`;
    const next = [...lines, omittedLine].join("\n");
    if (estimateTokens(next) <= summaryTokenBudget) {
      lines.push(omittedLine);
    }
  }
  let summary = lines.join("\n");
  if (estimateTokens(summary) > summaryTokenBudget) {
    const byteLimit = maxUtf8BytesForTokenBudget(summaryTokenBudget);
    if (byteLimit === 0) {
      return "";
    }
    summary = new TextDecoder("utf-8", { fatal: false })
      .decode(new TextEncoder().encode(summary).slice(0, byteLimit))
      .trimEnd();
  }
  return summary;
}

function sourceSpansFor(dropped: readonly DroppedTurn[]): ContextProvenanceRef[] {
  return dropped.map((turn) => ({ kind: "message", stableId: turn.stableId }));
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
