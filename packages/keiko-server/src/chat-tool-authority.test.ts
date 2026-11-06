import { describe, expect, it } from "vitest";
import type { ChatToolAuthorityEnvelope } from "@oscharko-dev/keiko-contracts";
import { acceptedChatToolAuthorityEnvelope } from "./chat-tool-authority.js";

// Frozen compatibility vectors from the existing three source adapters' issued envelope format.
// Changing a source adapter must not silently change an accepted turn's persisted proof identity.
const TURN = {
  chatId: "chat-authority-parity",
  userMessageId: "accepted-human-message",
  startedAtMs: 1793955600000,
  nowMs: 1793955600000,
  correlationId: "authority-parity",
};
const BUDGET = {
  maxRuntimeMs: 60_000,
  maxToolCalls: 2,
  maxPromptTokens: 1000,
  maxPatchBytes: 0,
} satisfies ChatToolAuthorityEnvelope["budget"];
const SUBJECT_BASE = { actorDigest: "a".repeat(64), chatId: TURN.chatId };
const CASES: readonly {
  readonly subject: ChatToolAuthorityEnvelope["subject"];
  readonly scopes: ChatToolAuthorityEnvelope["connectorScopes"];
  readonly proof: string;
}[] = [
  {
    subject: {
      ...SUBJECT_BASE,
      podId: "synthetic-jira-pod",
      bindingGeneration: 2,
      authenticationGeneration: 3,
    },
    scopes: ["issue-tracker.read", "issue-tracker.write"],
    proof: "c565f91a37cbe5856b423b16daf5ad7fab81e218f150801df473090bbdeef6ae",
  },
  {
    subject: { ...SUBJECT_BASE, kind: "configured-mcp", configurationDigest: "b".repeat(64) },
    scopes: ["mcp.tools"],
    proof: "5f884fc6f915f242acdaead0114fa8762df37d32c0b50ae0c3b41e87638e3398",
  },
  {
    subject: { ...SUBJECT_BASE, kind: "knowledge-pods", configurationDigest: "c".repeat(64) },
    scopes: ["knowledge.read"],
    proof: "6b5a48154791a48855ffb12d3b191d0effb0efb7b1f1f0160acb8816f16cdceb",
  },
];

describe("shared accepted Chat source envelope", () => {
  it.each(CASES)(
    "preserves source scope and persisted proof identity for $subject",
    ({ subject, scopes, proof }) => {
      expect(
        acceptedChatToolAuthorityEnvelope(
          TURN,
          subject,
          "governed-assist",
          "autonomous-delivery",
          BUDGET,
          scopes,
        ),
      ).toEqual({
        schemaVersion: "1",
        kind: "chat-tool-authority",
        runId: "chat-a6ff8f26a1c39598ea142d55d9d61d994e850e438b91133dde2d9e6e05b5c79c",
        subject,
        requestedMode: "governed-assist",
        deploymentCeiling: "autonomous-delivery",
        effectiveMode: "governed-assist",
        actionClasses: ["connector-access", "network-egress"],
        connectorScopes: scopes,
        budget: BUDGET,
        expiresAt: "2026-11-06T09:01:00.000Z",
        approvalProofDigest: proof,
      });
    },
  );
});
