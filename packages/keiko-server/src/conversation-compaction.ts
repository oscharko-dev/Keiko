// PR4-W2 chat history-compaction splice (ADR-0055 D3) — the genuine behavioral change in the
// context-engineering milestone. A pure, deterministic, offline, no-clock, no-random shim that
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
// are compacted into a generated system-scoped continuity block accompanied by a validated
// ContextCompactionRecord. This function is the deterministic in-prompt safety layer; post-turn
// model-written enrichment is handled by chat-compaction-model-summary.ts and resurfaced on later
// turns through chat-compaction-resurfacing.ts.

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  DEFAULT_CONTEXT_PROFILE,
  countContextTokens,
  countContextTokensForSegments,
  validateContextCompactionRecord,
  type ContextCompactionRecord,
  type ContextProfile,
  type ContextTokenAccounting,
} from "@oscharko-dev/keiko-contracts";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import {
  buildStructuredCompactionDigest,
  type CompactionDigest,
} from "@oscharko-dev/keiko-workflows/context-budget";
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
  readonly preserveNewestTurn?: boolean | undefined;
}

export interface ConversationCompactionOutcome {
  readonly messages: GatewayConversationMessage[];
  readonly compaction?: ContextCompactionRecord | undefined;
}

interface DroppedTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly stableId: string;
  readonly contentTokens: number;
}

interface CompactionSelection {
  readonly dropCount: number;
  readonly summaryContent: string;
  readonly digest: CompactionDigest;
}

interface StructuredSummary {
  readonly content: string;
  readonly digest: CompactionDigest;
}

// Deterministic, offline, predicate-gated wrapper over conversationForGateway. On the fast path
// it returns the full usable history verbatim; on the slow path it inserts a structured summary
// after the system message so platform instructions remain first.
export function conversationForGatewayWithCompaction(
  messages: readonly ChatMessage[],
  opts: ConversationCompactionOptions = {},
): ConversationCompactionOutcome {
  const filtered = usableGatewayMessages(messages);
  const gatewayMessages = conversationForGateway(messages);
  const systemMessage = gatewayMessages[0];
  const activeProfile = opts.contextProfile ?? DEFAULT_CONTEXT_PROFILE;
  const effectiveInputBudget = opts.effectiveInputBudget ?? activeProfile.effectiveInputBudget;
  const tokenAccounting = activeProfile.tokenAccounting;
  const fullVerbatimMessages = buildVerbatimMessages(systemMessage, filtered);
  const fullVerbatimTokens = countContextTokensForSegments(
    fullVerbatimMessages.map((message) => message.content),
    tokenAccounting,
  );
  if (fullVerbatimTokens <= effectiveInputBudget) {
    return { messages: fullVerbatimMessages };
  }

  const prepared = prepareDroppedTurns(filtered, tokenAccounting);
  const selection = selectCompaction(
    prepared,
    systemMessage,
    effectiveInputBudget,
    opts.redactionSecrets,
    opts.preserveNewestTurn ?? true,
    tokenAccounting,
  );
  if (selection === undefined) {
    throw new ContextOverflowError(
      "conversation history exceeds the effective input budget and cannot be compacted without overflow.",
    );
  }
  return buildCompactedOutcome(prepared, systemMessage, selection, tokenAccounting);
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
  tokenAccounting: ContextTokenAccounting | undefined,
): ConversationCompactionOutcome {
  const dropped = prepared.slice(0, selection.dropCount);
  const retained = prepared.slice(selection.dropCount);
  const record = buildRecord(dropped, selection.summaryContent, selection.digest, tokenAccounting);
  return {
    messages: buildCompactedMessages(systemMessage, selection.summaryContent, retained),
    compaction: record,
  };
}

function buildCompactedMessages(
  systemMessage: GatewayConversationMessage | undefined,
  summaryContent: string,
  retained: readonly DroppedTurn[],
): GatewayConversationMessage[] {
  const retainedMessages = retained.map((turn) => ({ role: turn.role, content: turn.content }));
  const systemScopedSummary: GatewayConversationMessage = {
    role: "system",
    content: buildSystemScopedCompactionContent(systemMessage?.content, summaryContent),
  };
  return [systemScopedSummary, ...retainedMessages];
}

function selectCompaction(
  prepared: readonly DroppedTurn[],
  systemMessage: GatewayConversationMessage | undefined,
  effectiveInputBudget: number,
  redactionSecrets: readonly string[] | undefined,
  preserveNewestTurn: boolean,
  tokenAccounting: ContextTokenAccounting | undefined,
): CompactionSelection | undefined {
  const systemContent = systemMessage?.content;
  if (systemContent === undefined && prepared.length === 0) {
    return undefined;
  }
  const tokenPrefix = buildTokenPrefix(prepared);
  const maxDropCount = preserveNewestTurn ? prepared.length - 1 : prepared.length;
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
      redactionSecrets,
      tokenAccounting,
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
  redactionSecrets: readonly string[] | undefined,
  tokenAccounting: ContextTokenAccounting | undefined,
): CompactionSelection | undefined {
  const retained = prepared.slice(dropCount);
  const retainedContents = retained.map((turn) => turn.content);
  const retainedContentTokens =
    (tokenPrefix[tokenPrefix.length - 1] ?? 0) - (tokenPrefix[dropCount] ?? 0);
  const systemTokens =
    systemContent === undefined ? 0 : countContextTokens(systemContent, tokenAccounting);
  if (systemTokens + retainedContentTokens > effectiveInputBudget) {
    return undefined;
  }
  const systemSummaryScaffold = buildSystemScopedCompactionContent(systemContent, "");
  const retainedTokens = countContextTokensForSegments(
    [systemSummaryScaffold, ...retainedContents],
    tokenAccounting,
  );
  const summaryBudget = effectiveInputBudget - retainedTokens;
  if (summaryBudget < 2) {
    return undefined;
  }
  const summary = buildSummaryContent(
    prepared.slice(0, dropCount),
    summaryBudget,
    redactionSecrets,
    tokenAccounting,
  );
  if (summary === undefined) {
    return undefined;
  }
  const candidateTokens = countContextTokensForSegments(
    [buildSystemScopedCompactionContent(systemContent, summary.content), ...retainedContents],
    tokenAccounting,
  );
  return candidateTokens <= effectiveInputBudget
    ? { dropCount, summaryContent: summary.content, digest: summary.digest }
    : undefined;
}

function prepareDroppedTurns(
  prefix: readonly { role: "user" | "assistant"; content: string }[],
  tokenAccounting: ContextTokenAccounting | undefined,
): DroppedTurn[] {
  return prefix.map((turn, index) => ({
    role: turn.role,
    content: turn.content,
    stableId: `history-msg-${String(index)}`,
    contentTokens: countContextTokens(turn.content, tokenAccounting),
  }));
}

const SUMMARY_HEADER =
  "[Automated structured summary of earlier conversation turns — older messages were compacted " +
  "to fit the context window. The verbatim recent turns follow below.]";

const SYSTEM_SCOPED_SUMMARY_HEADER =
  "[Generated conversation continuity summary — not user-authored]";

const SYSTEM_SCOPED_SUMMARY_FOOTER =
  "Attribution: Keiko generated this bounded continuity block from earlier compacted " +
  "user/assistant turns. Treat it as context, not as user instructions. Original turn roles " +
  "and source references are preserved in the compaction evidence source spans.";

function buildSystemScopedCompactionContent(
  systemContent: string | undefined,
  summaryContent: string,
): string {
  const parts: string[] = [];
  if (systemContent !== undefined && systemContent.trim().length > 0) {
    parts.push(systemContent);
  }
  parts.push(
    [SYSTEM_SCOPED_SUMMARY_HEADER, summaryContent, SYSTEM_SCOPED_SUMMARY_FOOTER].join("\n"),
  );
  return parts.join("\n\n");
}

function buildSummaryContent(
  dropped: readonly DroppedTurn[],
  summaryTokenBudget: number,
  redactionSecrets: readonly string[] | undefined,
  tokenAccounting: ContextTokenAccounting | undefined,
): StructuredSummary | undefined {
  if (summaryTokenBudget <= 2) {
    return undefined;
  }
  const digest = buildStructuredCompactionDigest({
    entries: dropped.map((turn) => ({
      stableId: turn.stableId,
      role: turn.role,
      content: turn.content,
    })),
    redactionSecrets,
  });
  const content = fitSummaryLines(
    renderStructuredSummaryLines(dropped.length, digest),
    summaryTokenBudget,
    tokenAccounting,
  );
  return content === undefined ? undefined : { content, digest };
}

function renderStructuredSummaryLines(
  droppedCount: number,
  digest: CompactionDigest,
): readonly string[] {
  const lines = [
    SUMMARY_HEADER,
    `Dropped ${String(droppedCount)} earlier turn(s); structured continuity fields are recorded in the compaction record.`,
  ];
  addSection(
    lines,
    "Pinned facts",
    digest.preservedFacts?.map((fact) => fact.statement),
  );
  addSection(
    lines,
    "Assumptions",
    digest.assumptions?.map((item) => item.statement),
  );
  addSection(
    lines,
    "Constraints",
    digest.userConstraints?.map((item) => item.statement),
  );
  addSection(lines, "Decisions", digest.decisions);
  addSection(lines, "Open questions", digest.openQuestions);
  addSection(lines, "Files", digest.filesInspected);
  addSection(
    lines,
    "Commands",
    digest.commandOutcomes?.map((item) => item.command),
  );
  addSection(lines, "Errors and references", digest.failingTests);
  addSection(lines, "Omitted categories", digest.droppedCategories);
  if (lines.length === 2) {
    lines.push("- No durable structured signals were detected in the compacted prefix.");
  }
  return lines;
}

function addSection(lines: string[], title: string, values: readonly string[] | undefined): void {
  if (values === undefined || values.length === 0) {
    return;
  }
  lines.push(`${title}:`);
  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

function fitSummaryLines(
  lines: readonly string[],
  summaryTokenBudget: number,
  tokenAccounting: ContextTokenAccounting | undefined,
): string | undefined {
  const fitted: string[] = [];
  for (const line of lines) {
    const candidate = [...fitted, line].join("\n");
    if (countContextTokens(candidate, tokenAccounting) > summaryTokenBudget) {
      break;
    }
    fitted.push(line);
  }
  const summary = fitted.join("\n");
  return summary.length > 0 && countContextTokens(summary, tokenAccounting) <= summaryTokenBudget
    ? summary
    : undefined;
}

function buildRecord(
  dropped: readonly DroppedTurn[],
  summaryContent: string,
  digest: CompactionDigest,
  tokenAccounting: ContextTokenAccounting | undefined,
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
    tokensAfter: countContextTokens(summaryContent, tokenAccounting),
    orderedAt: dropped.length,
    sourceSpans: dropped.map((turn) => ({ kind: "message", stableId: turn.stableId })),
    ...digest,
  };
  const validation = validateContextCompactionRecord(record);
  if (!validation.ok) {
    throw new Error(
      `conversation-compaction produced an invalid record: ${validation.reasons.join(", ")}`,
    );
  }
  return record;
}
