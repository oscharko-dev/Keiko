import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { CodingAppSessionContentSource } from "./coding-app-session/sessionChannel.js";
import { redactToolTexts } from "./coding-runtime/codingSafeActivityToolDetail.js";
import type {
  CodingSafeActivityContent,
  CodingSafeActivityProjection,
} from "./coding-runtime/codingSafeActivityProjection.js";

export function requiresReasoningContinuation(config: GatewayConfig, model: string): boolean {
  return (
    config.providers.find((provider) => provider.modelId === model)?.reasoningContinuation ===
    "required-with-tools"
  );
}

/** Hide presentation without removing the native runtime's required continuation state. */
export function presentCodingReasoning(
  content: CodingSafeActivityContent | null,
  visible: boolean,
): CodingSafeActivityContent | null {
  if (content === null || visible || content.feed.availability !== "available") return content;
  const textDeltas = content.textDeltas?.filter((delta) => delta.part !== "reasoning");
  const { textDeltas: _all, ...rest } = content;
  return {
    ...rest,
    feed: {
      ...content.feed,
      turns: content.feed.turns.map((turn) => ({
        ...turn,
        messages: turn.messages.map(
          ({ reasoning: _hidden, fullReasoning: _hiddenLength, ...message }) => message,
        ),
      })),
    },
    ...(textDeltas === undefined || textDeltas.length === 0 ? {} : { textDeltas }),
  };
}

/**
 * The authenticated channel's view of the safe-activity projection, with the deployment's reasoning
 * display applied. Reasoning the deployment does not show is never served, as a snapshot, a delta
 * or a page.
 */
export function codingSafeActivityContentSource(
  projection: CodingSafeActivityProjection | undefined,
  visible: () => boolean,
  secrets: () => readonly string[] = () => [],
): CodingAppSessionContentSource | undefined {
  const present = (content: CodingSafeActivityContent | null): CodingSafeActivityContent | null =>
    presentCodingToolTexts(presentCodingReasoning(content, visible()), secrets());
  return projection === undefined
    ? undefined
    : {
        contentFor: () => present(projection.currentContent()),
        subscribeContent: (listener) =>
          projection.subscribeContent((content) => {
            listener(present(content));
          }),
        answerPageFor: ({ runId, ...request }) =>
          request.part === "reasoning" && !visible() ? null : projection.answerPage(runId, request),
      };
}

/**
 * The deployment's own secret values removed from every tool text the update carries. A redaction
 * that made the update longer drops its text deltas, so the snapshot stays inside its budget; the
 * reader reads what they carried as pages. A redaction that outgrows even that keeps the changed
 * rows without their texts, never an update the channel would refuse whole.
 */
export function presentCodingToolTexts(
  content: CodingSafeActivityContent | null,
  secrets: readonly string[],
): CodingSafeActivityContent | null {
  if (content === null || secrets.length === 0 || content.feed.availability !== "available") {
    return content;
  }
  const feed = mapTools(content.feed, (tool) =>
    tool.presentation === undefined
      ? tool
      : { ...tool, presentation: redactToolTexts(tool.presentation, secrets) },
  );
  const { textDeltas, ...rest } = content;
  const before = utf8Bytes(content.feed);
  const after = utf8Bytes(feed);
  if (after <= before)
    return textDeltas === undefined ? { ...rest, feed } : { ...rest, feed, textDeltas };
  if (after <= before + utf8Bytes(textDeltas ?? [])) return { ...rest, feed };
  return { ...rest, feed: withoutChangedTexts(content.feed, feed) };
}

type AvailableFeed = Extract<
  CodingSafeActivityContent["feed"],
  { readonly availability: "available" }
>;
type FeedTool = AvailableFeed["turns"][number]["tools"][number];

function mapTools(feed: AvailableFeed, map: (tool: FeedTool) => FeedTool): AvailableFeed {
  return {
    ...feed,
    turns: feed.turns.map((turn) => ({ ...turn, tools: turn.tools.map(map) })),
  };
}

// The original rows, with the texts of every row the redaction changed left out and said so.
function withoutChangedTexts(original: AvailableFeed, redacted: AvailableFeed): AvailableFeed {
  const redactedById = new Map(allTools(redacted).map((tool) => [tool.callId, tool.presentation]));
  return mapTools(original, (tool) => {
    const { presentation } = tool;
    if (presentation === undefined) return tool;
    if (JSON.stringify(redactedById.get(tool.callId)) === JSON.stringify(presentation)) return tool;
    const { command: _command, output: _output, errorText: _errorText, ...facts } = presentation;
    return { ...tool, presentation: { ...facts, detailOmitted: true } };
  });
}

function allTools(feed: AvailableFeed): readonly FeedTool[] {
  return feed.turns.flatMap((turn) => turn.tools);
}

const utf8 = new TextEncoder();

function utf8Bytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}
