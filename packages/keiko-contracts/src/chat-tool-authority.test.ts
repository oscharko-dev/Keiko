import { describe, expect, it } from "vitest";
import { CODING_WORKBENCH_MODES, resolveEffectiveCodingWorkbenchMode } from "./coding-workbench.js";
import { validateCodingWorkbenchAuthorityEnvelope } from "./coding-workbench-validation.js";
import {
  validateChatToolAuthorityEnvelope,
  validateChatToolAuthoritySubject,
  type ChatToolAuthorityEnvelope,
} from "./chat-tool-authority.js";

function envelope(): ChatToolAuthorityEnvelope {
  return {
    schemaVersion: "1",
    kind: "chat-tool-authority",
    runId: "chat-authority-1",
    subject: {
      actorDigest: "a".repeat(64),
      chatId: "chat-1",
      podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
      bindingGeneration: 2,
      authenticationGeneration: 3,
    },
    requestedMode: "governed-assist",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "governed-assist",
    actionClasses: ["connector-access", "network-egress"],
    connectorScopes: ["issue-tracker.read", "issue-tracker.write"],
    budget: { maxRuntimeMs: 60_000, maxToolCalls: 20, maxPromptTokens: 50_000, maxPatchBytes: 0 },
    expiresAt: "2026-10-27T15:00:00.000Z",
    approvalProofDigest: "b".repeat(64),
  };
}

describe("ordinary Chat tool authority contract (#4084)", () => {
  it("accepts Chat identity without a Coding workspace, branch or session", () => {
    const value = envelope();
    expect(validateChatToolAuthorityEnvelope(value)).toEqual({ ok: true, value });
    expect(validateCodingWorkbenchAuthorityEnvelope(value).ok).toBe(false);
    expect(validateChatToolAuthoritySubject(value.subject)).toEqual({
      ok: true,
      value: value.subject,
    });
  });

  it.each(CODING_WORKBENCH_MODES)("keeps the shared mode ordering for %s", (requestedMode) => {
    for (const deploymentCeiling of CODING_WORKBENCH_MODES) {
      const value = {
        ...envelope(),
        requestedMode,
        deploymentCeiling,
        effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling),
      };
      expect(validateChatToolAuthorityEnvelope(value).ok).toBe(true);
      const different = CODING_WORKBENCH_MODES.find((mode) => mode !== value.effectiveMode);
      expect(validateChatToolAuthorityEnvelope({ ...value, effectiveMode: different }).ok).toBe(
        false,
      );
    }
  });

  it.each([
    { actorDigest: "not-a-digest" },
    { chatId: "" },
    { podId: "not-a-pod" },
    { bindingGeneration: 0 },
    { authenticationGeneration: -1 },
    { bindingGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { authenticationGeneration: 1.5 },
    { credentialRef: "credential-1" },
    { workspaceRoot: "/workspace" },
  ])("rejects malformed or widened subjects %j", (patch) => {
    const subject = { ...envelope().subject, ...patch };
    expect(validateChatToolAuthoritySubject(subject).ok).toBe(false);
    expect(validateChatToolAuthorityEnvelope({ ...envelope(), subject }).ok).toBe(false);
  });

  it.each([
    { kind: "coding-authority" },
    { schemaVersion: "2" },
    { runId: "" },
    { requestedMode: "invalid" },
    { deploymentCeiling: "invalid" },
    { actionClasses: ["connector-access", "network-egress", "file-edit"] },
    { actionClasses: ["connector-access"] },
    { connectorScopes: [] },
    { connectorScopes: ["knowledge-base.read"] },
    { connectorScopes: ["issue-tracker.read", "issue-tracker.read"] },
    { expiresAt: "2026-02-30T00:00:00.000Z" },
    { expiresAt: "tomorrow" },
    { approvalProofDigest: "" },
    { workspace: { root: "/workspace" } },
    { branch: { headRef: "dev" } },
    { authRef: "credential-1" },
  ])("rejects invalid policy or extra authority fields %j", (patch) => {
    expect(validateChatToolAuthorityEnvelope({ ...envelope(), ...patch }).ok).toBe(false);
  });

  it.each([
    { maxToolCalls: 0 },
    { maxToolCalls: Number.POSITIVE_INFINITY },
    { maxPromptTokens: -1 },
    { maxRuntimeMs: 1.5 },
    { maxPatchBytes: 1 },
    { maxNetworkCalls: 1 },
  ])("rejects invalid budgets and any file patch authority %j", (patch) => {
    const value = envelope();
    expect(
      validateChatToolAuthorityEnvelope({ ...value, budget: { ...value.budget, ...patch } }).ok,
    ).toBe(false);
  });

  it("accepts a narrower read-only connector scope", () => {
    expect(
      validateChatToolAuthorityEnvelope({ ...envelope(), connectorScopes: ["issue-tracker.read"] })
        .ok,
    ).toBe(true);
  });

  it.each([null, undefined, [], "authority", 1])("fails closed on non-record input %j", (value) => {
    expect(validateChatToolAuthorityEnvelope(value).ok).toBe(false);
    expect(validateChatToolAuthoritySubject(value).ok).toBe(false);
  });

  it("does not echo hostile keys or values in validation errors", () => {
    const privateText = "private-customer-data";
    const result = validateChatToolAuthorityEnvelope({ ...envelope(), [privateText]: privateText });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });

  it.each(["envelope", "subject", "budget"] as const)("rejects inherited %s facts", (target) => {
    const value = envelope();
    const inherited: unknown = Object.create(target === "envelope" ? value : value[target]);
    const candidate = target === "envelope" ? inherited : { ...value, [target]: inherited };
    expect(validateChatToolAuthorityEnvelope(candidate).ok).toBe(false);
  });
});
