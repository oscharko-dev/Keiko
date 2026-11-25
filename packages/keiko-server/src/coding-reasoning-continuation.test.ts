import { expect, it } from "vitest";
import {
  CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
  unavailableCodingSafeActivityFeed,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import type { CodingSafeActivityContent } from "./coding-runtime/codingSafeActivityProjection.js";
import { createCodingSafeActivityProjection } from "./coding-runtime/codingSafeActivityProjection.js";
import {
  codingSafeActivityContentSource,
  presentCodingReasoning,
  presentCodingToolTexts,
} from "./coding-reasoning-continuation.js";

it("hides live reasoning without changing native transport content or answer text", () => {
  const content: CodingSafeActivityContent = {
    kind: "safe-activity",
    feed: {
      schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
      availability: "available",
      runId: "run",
      updatedAt: "2026-11-05T00:00:00Z",
      truncated: false,
      droppedEventCount: 0,
      turns: [
        {
          turnId: "turn",
          tools: [],
          truncated: false,
          messages: [
            {
              messageId: "message",
              role: "assistant",
              occurredAt: "2026-11-05T00:00:00Z",
              truncated: false,
              segments: [{ kind: "text", text: "Visible answer", truncated: false }],
              reasoning: { text: "Private native continuation", truncated: false },
            },
          ],
        },
      ],
    },
  };
  const hidden = presentCodingReasoning(content, false);
  expect(JSON.stringify(hidden)).not.toContain("Private native continuation");
  expect(JSON.stringify(hidden)).toContain("Visible answer");
  expect(JSON.stringify(content)).toContain("Private native continuation");
  expect(presentCodingReasoning(content, true)).toBe(content);
  expect(presentCodingReasoning(null, false)).toBeNull();
  const unavailable: CodingSafeActivityContent = {
    kind: "safe-activity",
    feed: unavailableCodingSafeActivityFeed("run", "2026-11-05T00:00:00Z"),
  };
  expect(presentCodingReasoning(unavailable, false)).toBe(unavailable);
});

it("hides reasoning a live update names or streams, and keeps the answer's own", () => {
  const content: CodingSafeActivityContent = {
    kind: "safe-activity",
    feed: {
      schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
      availability: "available",
      runId: "run",
      updatedAt: "2026-11-05T00:00:00Z",
      truncated: false,
      droppedEventCount: 0,
      turns: [
        {
          turnId: "turn",
          tools: [],
          truncated: false,
          messages: [
            {
              messageId: "message",
              role: "assistant",
              occurredAt: "2026-11-05T00:00:00Z",
              truncated: false,
              segments: [],
              fullAnswer: { length: 40_000, truncated: false },
              fullReasoning: { length: 30_000, truncated: false },
            },
          ],
        },
      ],
    },
    textDeltas: [
      { messageId: "message", part: "answer", offset: 0, text: "Visible answer" },
      { messageId: "message", part: "reasoning", offset: 0, text: "Private thought" },
    ],
  };
  const hidden = presentCodingReasoning(content, false);
  const shown = JSON.stringify(hidden);
  expect(shown).not.toContain("Private thought");
  expect(shown).not.toContain("fullReasoning");
  expect(shown).toContain("Visible answer");
  expect(shown).toContain('"fullAnswer"');
});

it("serves no reasoning page while the deployment hides reasoning, and the answer page always", () => {
  const projection = createCodingSafeActivityProjection({ now: () => 1_721_323_200_000 });
  projection.open({
    runId: "run",
    workspaceId: "ws",
    authorityExpiresAt: "2026-07-18T18:00:00.000Z",
    workspaceIsCurrent: () => true,
  });
  const occurredAt = "2026-07-18T17:00:00.000Z";
  projection.ingest("run", { kind: "message", messageId: "task", role: "user", occurredAt });
  projection.ingest("run", {
    kind: "message",
    messageId: "answer",
    role: "assistant",
    parentMessageId: "task",
    occurredAt,
  });
  projection.ingest("run", { kind: "reasoning", messageId: "answer", text: "Thought", occurredAt });
  projection.ingest("run", { kind: "text", messageId: "answer", text: "Answer", occurredAt });
  let visible = false;
  const source = codingSafeActivityContentSource(projection, () => visible);
  const request = { runId: "run", messageId: "answer", offset: 0 } as const;

  expect(source?.answerPageFor?.({ ...request, part: "reasoning" })).toBeNull();
  expect(source?.answerPageFor?.({ ...request, part: "answer" })).toMatchObject({ text: "Answer" });
  visible = true;
  expect(source?.answerPageFor?.({ ...request, part: "reasoning" })).toMatchObject({
    part: "reasoning",
    text: "Thought",
  });
  expect(codingSafeActivityContentSource(undefined, () => true)).toBeUndefined();
});

const SECRET = "Zq9wXy7kPm";

function toolContent(
  commands: readonly string[],
  textDeltas?: CodingSafeActivityContent["textDeltas"],
): CodingSafeActivityContent {
  return {
    kind: "safe-activity",
    feed: {
      schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
      availability: "available",
      runId: "run",
      updatedAt: "2026-11-05T00:00:00Z",
      truncated: false,
      droppedEventCount: 0,
      turns: [
        {
          turnId: "turn",
          messages: [],
          truncated: false,
          tools: commands.map((text, index) => ({
            callId: `call-${String(index)}`,
            tool: "shell",
            state: "succeeded" as const,
            occurredAt: "2026-11-05T00:00:00Z",
            presentation: { exitCode: 0, command: { text, truncated: false } },
          })),
        },
      ],
    },
    ...(textDeltas === undefined ? {} : { textDeltas }),
  };
}

function commandsOf(content: CodingSafeActivityContent | null): readonly unknown[] {
  if (content?.feed.availability !== "available") return [];
  return content.feed.turns.flatMap((turn) => turn.tools.map((tool) => tool.presentation));
}

it("removes a deployment secret from a tool text and keeps the update's deltas when it fits", () => {
  const redacted = presentCodingToolTexts(toolContent([`echo ${SECRET}`]), [SECRET]);
  expect(JSON.stringify(redacted)).not.toContain(SECRET);
  expect(commandsOf(redacted)).toEqual([
    { exitCode: 0, command: { text: "echo [REDACTED]", truncated: false } },
  ]);
});

it("drops the text deltas of an update the redaction made longer, so it stays in budget", () => {
  const deltas: CodingSafeActivityContent["textDeltas"] = [
    { messageId: "message", part: "answer", offset: 0, text: "a long streamed answer text" },
  ];
  // "[REDACTED]" is longer than this secret, so the redacted rows outgrow the original feed.
  const short = "Zq9wXy7k";
  const redacted = presentCodingToolTexts(toolContent([`echo ${short}`], deltas), [short]);
  expect(redacted?.textDeltas).toBeUndefined();
  expect(commandsOf(redacted)).toEqual([
    { exitCode: 0, command: { text: "echo [REDACTED]", truncated: false } },
  ]);
});

it("keeps the changed rows without their texts when the redaction outgrows even the deltas", () => {
  const short = "Zq9wXy7k";
  const redacted = presentCodingToolTexts(
    toolContent([`echo ${short} ${short} ${short}`, "npm test"]),
    [short],
  );
  expect(JSON.stringify(redacted)).not.toContain(short);
  expect(commandsOf(redacted)).toEqual([
    { exitCode: 0, detailOmitted: true },
    { exitCode: 0, command: { text: "npm test", truncated: false } },
  ]);
});

it("measures the budget in UTF-8 bytes, not characters", () => {
  // Nine characters but ten bytes: the redaction adds a character and not a single byte.
  const wide = "Zq9wXy7kü";
  const deltas: CodingSafeActivityContent["textDeltas"] = [
    { messageId: "message", part: "answer", offset: 0, text: "answer" },
  ];
  const redacted = presentCodingToolTexts(toolContent([`echo ${wide}`], deltas), [wide]);
  expect(redacted?.textDeltas).toEqual(deltas);
  expect(commandsOf(redacted)).toEqual([
    { exitCode: 0, command: { text: "echo [REDACTED]", truncated: false } },
  ]);
});
