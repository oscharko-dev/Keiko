import { expect, it } from "vitest";
import {
  CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
  unavailableCodingSafeActivityFeed,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import type { CodingSafeActivityContent } from "./coding-runtime/codingSafeActivityProjection.js";
import { presentCodingReasoning } from "./coding-reasoning-continuation.js";

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
