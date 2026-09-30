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

/** Automatic compaction starts at this share of the usable input (chat-prompt-budget.ts). */
export const AUTOMATIC_COMPACTION_THRESHOLD = 0.9;

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

// Scales the used shares down proportionally when they exceed the usable input: a request never
// carries more (the send path compacts and trims), so the bar never runs past its budget.
function fittedToBudget(
  segments: readonly ChatContextSegmentWire[],
  budget: number,
): readonly ChatContextSegmentWire[] {
  const total = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  if (total <= budget || total === 0) return segments;
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

export function contextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
  const { profile } = input;
  const budget = profile.effectiveInputBudget;
  const autoCompactionAtTokens = Math.floor(budget * AUTOMATIC_COMPACTION_THRESHOLD);
  const used = fittedToBudget(usedSegments(input), budget);
  const usedTokens = used.reduce((sum, segment) => sum + segment.tokens, 0);
  const free = Math.max(0, autoCompactionAtTokens - usedTokens);
  return {
    usedTokens,
    autoCompactionAtTokens,
    segments: [
      ...used,
      { id: "free", tokens: free },
      { id: "compaction-buffer", tokens: budget - usedTokens - free },
      { id: "output-reserve", tokens: profile.reservedOutputTokens },
      { id: "safety-margin", tokens: profile.safetyMarginTokens },
    ],
  };
}
