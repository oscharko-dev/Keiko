// The context meter's breakdown of a model's whole window into its shares (field report 1.1.13).
//
// A single "percent used" hid what fills the window: in a grounded chat the retrieved sources are
// usually the largest share, and the room reserved for the answer and for estimation error is not
// input space at all. The shares below sum to the window exactly, in stacking order, so the meter
// can draw one bar over the whole window and list every share. Pure: no store or clock access.

import type {
  ChatContextSegmentWire,
  GroundedPromptContextWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ContextProfile } from "@oscharko-dev/keiko-contracts";

import { AUTOMATIC_COMPACTION_THRESHOLD } from "./chat-compaction-thresholds.js";

export interface ConversationShare {
  readonly systemTokens: number;
  readonly summaryTokens: number;
  readonly summaryCount: number;
  readonly messageTokens: number;
  readonly messageCount: number;
}

export interface ContextBreakdownInput {
  readonly profile: ContextProfile;
  readonly conversation: ConversationShare;
  /** Present while the chat is grounded: the conversation lane cap and the last source share. */
  readonly grounded?:
    | {
        readonly historyLaneTokens: number;
        readonly lastPrompt: GroundedPromptContextWire | undefined;
      }
    | undefined;
}

export interface ContextBreakdown {
  readonly segments: readonly ChatContextSegmentWire[];
  readonly usedTokens: number;
  readonly autoCompactionAtTokens: number;
}

// Inside a grounded question the conversation is compacted into its own lane; the checkpoint keeps
// its share first and the verbatim messages take what the lane leaves.
function groundedConversation(
  conversation: ConversationShare,
  laneTokens: number,
): Pick<ConversationShare, "summaryTokens" | "messageTokens"> {
  const summaryTokens = Math.min(conversation.summaryTokens, laneTokens);
  return {
    summaryTokens,
    messageTokens: Math.min(conversation.messageTokens, laneTokens - summaryTokens),
  };
}

function usedSegments(input: ContextBreakdownInput): readonly ChatContextSegmentWire[] {
  const { conversation, grounded } = input;
  const lastPrompt = grounded?.lastPrompt;
  const shares =
    grounded === undefined
      ? conversation
      : groundedConversation(conversation, grounded.historyLaneTokens);
  return [
    { id: "system", tokens: lastPrompt?.instructionTokens ?? conversation.systemTokens },
    { id: "summary", tokens: shares.summaryTokens, count: conversation.summaryCount },
    { id: "messages", tokens: shares.messageTokens, count: conversation.messageCount },
    ...(grounded === undefined
      ? []
      : [
          {
            id: "knowledge" as const,
            tokens: lastPrompt?.sourceTokens ?? 0,
            count: lastPrompt?.sentReferenceCount ?? 0,
          },
        ]),
  ];
}

function tokensOf(segments: readonly ChatContextSegmentWire[]): number {
  return segments.reduce((sum, segment) => sum + segment.tokens, 0);
}

// A request never carries more than the usable input: the send path compacts the conversation and
// trims the sources by rank. The sources are the share that gives way — they are trimmed per
// question, so a share recorded under a larger window shrinks to what is left beside the exactly
// known system and conversation shares (PR #3678 review). Only a conversation that alone exceeds
// the budget, which the compaction projection prevents, falls back to proportional scaling.
function fittedToBudget(
  segments: readonly ChatContextSegmentWire[],
  budget: number,
): readonly ChatContextSegmentWire[] {
  const total = tokensOf(segments);
  if (total <= budget || total === 0) return segments;
  const fixed = tokensOf(segments.filter((segment) => segment.id !== "knowledge"));
  if (fixed <= budget) {
    return segments.map((segment) =>
      segment.id === "knowledge" ? { ...segment, tokens: budget - fixed } : segment,
    );
  }
  let remaining = budget;
  return segments.map((segment, index) => {
    const tokens =
      index === segments.length - 1
        ? remaining
        : Math.min(remaining, Math.floor((segment.tokens * budget) / total));
    remaining -= tokens;
    return { ...segment, tokens };
  });
}

// Automatic compaction watches the conversation. In a grounded question the conversation has its
// own lane beside the sources, so compaction starts once the conversation reaches the threshold of
// that lane — not of the whole budget, which the sources may fill without anything to compact.
function autoCompactionAt(
  input: ContextBreakdownInput,
  used: readonly ChatContextSegmentWire[],
): number {
  const budget = input.profile.effectiveInputBudget;
  if (input.grounded === undefined) return Math.floor(budget * AUTOMATIC_COMPACTION_THRESHOLD);
  const beside = tokensOf(
    used.filter((segment) => segment.id === "system" || segment.id === "knowledge"),
  );
  const lane = Math.floor(input.grounded.historyLaneTokens * AUTOMATIC_COMPACTION_THRESHOLD);
  return Math.min(budget, beside + lane);
}

function availableSegments(
  input: ContextBreakdownInput,
  used: readonly ChatContextSegmentWire[],
  free: number,
): readonly ChatContextSegmentWire[] {
  const remaining = input.profile.effectiveInputBudget - tokensOf(used) - free;
  if (input.grounded === undefined) return [{ id: "compaction-buffer", tokens: remaining }];
  const conversation = tokensOf(
    used.filter((segment) => segment.id === "summary" || segment.id === "messages"),
  );
  const buffer = Math.min(
    remaining,
    Math.max(0, input.grounded.historyLaneTokens - conversation - free),
  );
  return [
    { id: "compaction-buffer", tokens: buffer },
    { id: "source-capacity", tokens: remaining - buffer },
  ];
}

function unavailableInputCapacity(profile: ContextProfile): readonly ChatContextSegmentWire[] {
  const unavailable =
    profile.maxInputTokens -
    profile.reservedOutputTokens -
    profile.safetyMarginTokens -
    profile.effectiveInputBudget;
  return unavailable > 0 ? [{ id: "input-capacity-unavailable", tokens: unavailable }] : [];
}

export function contextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
  const { profile } = input;
  const budget = profile.effectiveInputBudget;
  const used = fittedToBudget(usedSegments(input), budget);
  const usedTokens = tokensOf(used);
  const autoCompactionAtTokens = autoCompactionAt(input, used);
  const free = Math.max(0, autoCompactionAtTokens - usedTokens);
  return {
    usedTokens,
    autoCompactionAtTokens,
    segments: [
      ...used,
      { id: "free", tokens: free },
      ...availableSegments(input, used, free),
      ...unavailableInputCapacity(profile),
      { id: "output-reserve", tokens: profile.reservedOutputTokens },
      { id: "safety-margin", tokens: profile.safetyMarginTokens },
    ],
  };
}
