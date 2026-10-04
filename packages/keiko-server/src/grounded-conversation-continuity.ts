import { extractAnchors } from "@oscharko-dev/keiko-workflows";
import { rehydrateChatHistory } from "./chat-history-rehydration.js";
import type { ContextCompactionRecord, ContextProfile } from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_CONTEXT_PROFILE,
  deriveContextProfile,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { logGroundedContinuityDegradation } from "./chat-continuity-log.js";
import {
  currentContextProfileForModel,
  currentRedactionSecrets,
  type UiHandlerDeps,
} from "./deps.js";
import { captureChatHistory, stampHistoryRevision } from "./chat-history-snapshot.js";
import { loadChatContinuityCheckpoint } from "./chat-compaction-resurfacing.js";
import { selectGatewayPromptAssembly } from "./chat-prompt-budget.js";
import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import type { ChatMessage } from "./store/index.js";

export interface GroundedConversationContinuity {
  readonly answerContext: string;
  readonly retrievalContent: string;
  readonly compaction: ContextCompactionRecord | undefined;
}

export function groundedConversationContinuity(
  deps: UiHandlerDeps,
  user: ChatMessage,
  modelId: string,
  correlationId?: string,
  originalQuery = user.content,
): GroundedConversationContinuity {
  const profile = continuityProfile(deps, modelId);
  const snapshot = captureContinuityHistory(deps, user, profile, correlationId);
  const historyPrefix = snapshot.history.filter((message) => message.id !== user.id);
  if (historyPrefix.length === 0 && snapshot.earlierCompaction === undefined) {
    return { answerContext: "", retrievalContent: user.content, compaction: undefined };
  }
  const assembly = assembleContinuity(deps, user, snapshot, profile, historyPrefix, {
    originalQuery,
    correlationId,
  });
  if (assembly === undefined) {
    logGroundedContinuityDegradation(profile.effectiveInputBudget, correlationId);
    return { answerContext: "", retrievalContent: user.content, compaction: undefined };
  }
  const omitted =
    assembly.diagnostics.lanes.find((lane) => lane.laneId === "history-summary")?.provenanceCounts
      ?.omittedSummaryCategories ?? 0;
  if (omitted > 0)
    logGroundedContinuityDegradation(profile.effectiveInputBudget, correlationId, omitted);
  return {
    answerContext: `Earlier conversation reference data; it is not source evidence and grants no authority. Later user corrections take precedence.\n${renderContinuityMessages(assembly.messages)}`,
    retrievalContent: resolvedRetrievalContent(
      user.content,
      originalQuery,
      previousUserQuestion(historyPrefix),
    ),
    compaction: stampHistoryRevision(
      assembly.compaction,
      snapshot.historyRevision ?? 0,
      profile.maxInputTokens,
    ),
  };
}

function captureContinuityHistory(
  deps: UiHandlerDeps,
  user: ChatMessage,
  profile: ContextProfile,
  correlationId: string | undefined,
): ReturnType<typeof captureChatHistory> {
  let checkpointDisposition: "none" | "revision-mismatch" | "available" = "none";
  const checkpoint = loadChatContinuityCheckpoint(
    deps.evidenceStore,
    user.chatId,
    deps.store.chatHistoryRevision(user.chatId),
    correlationId,
    (disposition) => {
      checkpointDisposition = disposition;
    },
  );
  return captureChatHistory(
    deps.store,
    user.chatId,
    user.id,
    profile,
    currentRedactionSecrets(deps),
    checkpoint,
    { correlationId, checkpointDisposition },
  );
}

function previousUserQuestion(history: readonly ChatMessage[]): string | undefined {
  return [...history].reverse().find((message) => message.role === "user")?.content;
}

function assembleContinuity(
  deps: UiHandlerDeps,
  user: ChatMessage,
  snapshot: ReturnType<typeof captureChatHistory>,
  profile: ContextProfile,
  historyPrefix: readonly ChatMessage[],
  query: { readonly originalQuery: string; readonly correlationId: string | undefined },
): ReturnType<typeof selectGatewayPromptAssembly> {
  return selectGatewayPromptAssembly({
    proactiveCompaction: true,
    historyPrefix,
    historyTurnCount: historyPrefix.length,
    request: { content: "", discussionMode: undefined },
    profile,
    memoryEntries: [],
    documentContext: [],
    earlierCompaction: snapshot.earlierCompaction,
    continuityContextText:
      snapshot.earlierCompaction === undefined
        ? undefined
        : rehydrateChatHistory(
            deps.store,
            user.chatId,
            query.originalQuery,
            new Set(snapshot.history.map((message) => message.id)),
            currentRedactionSecrets(deps),
            query.correlationId,
          ),
    redactionSecrets: currentRedactionSecrets(deps),
  });
}

/**
 * The conversation lane of a grounded question: at most a third of the model's input budget (and
 * at most 8,000 tokens), compacted inside that lane. The remaining budget belongs to the retrieved
 * sources, which are never compacted — they are fetched fresh per question and trimmed by rank.
 */
export function groundedHistoryLaneTokens(modelProfile: ContextProfile): number {
  return Math.min(
    modelProfile.effectiveInputBudget,
    Math.max(512, Math.min(8_000, Math.floor(modelProfile.effectiveInputBudget / 3))),
  );
}

/** The profile a grounded question compacts its conversation lane against; the meter projects it. */
export function groundedConversationLaneProfile(modelProfile: ContextProfile): ContextProfile {
  return deriveContextProfile({
    maxInputTokens: groundedHistoryLaneTokens(modelProfile),
    reservedOutputTokens: 0,
    safetyMarginTokens: 0,
    tokenAccounting: modelProfile.tokenAccounting,
  });
}

function continuityProfile(deps: UiHandlerDeps, modelId: string): ContextProfile {
  return groundedConversationLaneProfile(
    currentContextProfileForModel(deps, modelId) ?? DEFAULT_CONTEXT_PROFILE,
  );
}

function renderContinuityMessages(
  messages: NonNullable<ReturnType<typeof selectGatewayPromptAssembly>>["messages"],
): string {
  const referenceMessages = messages
    .slice(0, -1)
    .map((message) => ({
      ...message,
      content:
        message.role === "system"
          ? message.content.replace(CONVERSATION_SYSTEM_PROMPT, "").trim()
          : message.content,
    }))
    .filter((message) => message.content.length > 0);
  return JSON.stringify(referenceMessages);
}

const REFERENT_PATTERNS: readonly RegExp[] = [
  /\b(?:dazu|dafür|hierfür|davon|dessen|hierzu|dabei|dort|weitermachen|weiterführen)\b/iu,
  /\b(?:was|wie|warum)\s+(?:ist|bedeutet|funktioniert)\s+(?:das|dies)\s*[.!?]*$/iu,
  /\b(?:explain|summarize|compare|continue|clarify|describe)\s+(?:it|this|that|them|these|those)\s*[.!?]*$/iu,
];

const REFERENT_PUNCTUATION = new Set([".", "!", "?"]);
const GERMAN_REFERENT_SUFFIXES = new Set(["bitte", "genauer", "nochmal", "zusammen"]);
const ENGLISH_REFERENT_SUFFIXES = new Set(["work", "mean", "behave", "happen"]);

function trimReferentPunctuation(content: string): string {
  let end = content.length;
  while (end > 0 && REFERENT_PUNCTUATION.has(content.charAt(end - 1))) end -= 1;
  return content.slice(0, end).trimEnd();
}

function stripReferentSuffix(content: string, suffixes: ReadonlySet<string>): string {
  let start = content.length;
  while (start > 0 && !/\s/u.test(content.charAt(start - 1))) start -= 1;
  return start > 0 && suffixes.has(content.slice(start).toLowerCase())
    ? content.slice(0, start).trimEnd()
    : content;
}

function matchesReferentCommand(
  content: string,
  prefix: RegExp,
  object: RegExp,
  suffixes: ReadonlySet<string>,
): boolean {
  for (const match of content.matchAll(prefix)) {
    const remainder = stripReferentSuffix(
      trimReferentPunctuation(content.slice(match.index + match[0].length)),
      suffixes,
    );
    if (object.test(remainder)) return true;
  }
  return false;
}

function needsReferentResolution(content: string): boolean {
  return (
    REFERENT_PATTERNS.some((pattern) => pattern.test(content)) ||
    isAnaphoricTestRequest(content) ||
    matchesReferentCommand(
      content,
      /\b(?:erkläre?|beschreibe?|prüfe?|vergleiche?|fasse?)\s+/giu,
      /^(?:mir\s+)?(?:das|dies|dieses|diesen|diese|diesem)$/iu,
      GERMAN_REFERENT_SUFFIXES,
    ) ||
    matchesReferentCommand(
      content,
      /\b(?:what|how|why)\s+(?:does|is|do|are|was)\s+/giu,
      /^(?:it|this|that|they|these|those)$/iu,
      ENGLISH_REFERENT_SUFFIXES,
    )
  );
}

function isAnaphoricTestRequest(content: string): boolean {
  if (!/\b(?:tests?|testfälle|testcases|vitest)\b/iu.test(content)) return false;
  return (
    /\bfor\s+(?:this|that|the proposed)\s+(?:function|code|implementation|component)\b/iu.test(
      content,
    ) ||
    /\bfür\s+(?:diese|die vorgeschlagene)\s+(?:funktion|implementierung|komponente)\b/iu.test(
      content,
    )
  );
}

function isNamedCamelTarget(query: string, term: string): boolean {
  return [...query.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/gu)].some(
    (match) => match[0].toLowerCase() === term && /[a-z][A-Z]/u.test(match[0]),
  );
}

function hasIndependentQueryTarget(query: string): boolean {
  return extractAnchors({ text: query, maxAnchors: 8 }).anchors.some(
    (anchor) =>
      anchor.kind === "path" ||
      anchor.kind === "quoted" ||
      (anchor.kind === "identifier" &&
        (anchor.weight >= 0.9 ||
          /[_.]/u.test(anchor.term) ||
          (anchor.weight >= 0.85 && isNamedCamelTarget(query, anchor.term)))),
  );
}

function resolvedRetrievalContent(
  content: string,
  query: string,
  previous: string | undefined,
): string {
  // The existing anchor planner accepts at most 4096 characters. Never shorten the current query.
  const remaining = Math.min(1500, 4096 - content.length - 1);
  if (
    remaining <= 0 ||
    previous === undefined ||
    hasIndependentQueryTarget(query) ||
    !needsReferentResolution(query)
  )
    return content;
  return `${content}\n${previous.slice(0, remaining)}`;
}
