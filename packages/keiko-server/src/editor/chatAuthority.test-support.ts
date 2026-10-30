import type { JiraChatAuthorityEnvelope as ChatToolAuthorityEnvelope } from "../atlassian/jiraChatAuthority.js";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

export const CHAT_AUTHORITY_TEST_NOW = "2026-07-09T12:00:00.000Z";

export function chatAuthorityFixture(
  overrides: Partial<ChatToolAuthorityEnvelope> = {},
): ChatToolAuthorityEnvelope {
  const requestedMode = overrides.requestedMode ?? "autonomous-delivery";
  const deploymentCeiling = overrides.deploymentCeiling ?? "autonomous-delivery";
  return {
    schemaVersion: "1",
    kind: "chat-tool-authority",
    runId: "run-1",
    requestedMode,
    deploymentCeiling,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling),
    expiresAt: "2026-07-09T13:00:00.000Z",
    approvalProofDigest: "a".repeat(64),
    subject: {
      actorDigest: "c".repeat(64),
      chatId: "chat-1",
      podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
      bindingGeneration: 2,
      authenticationGeneration: 3,
    },
    actionClasses: ["connector-access", "network-egress"],
    connectorScopes: ["issue-tracker.read", "issue-tracker.write"],
    budget: { maxRuntimeMs: 60_000, maxToolCalls: 20, maxPromptTokens: 10_000, maxPatchBytes: 0 },
    ...overrides,
  };
}
