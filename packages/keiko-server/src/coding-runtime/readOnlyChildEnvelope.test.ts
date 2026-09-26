import { describe, expect, it } from "vitest";
import { CODE_TASK_AUXILIARY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import type {
  AuxiliaryCapabilityRequestV1,
  AuxiliaryResearchScopeV1,
  CodeTaskChildRunId,
  CodeTaskSkillId,
  CodingWorkbenchAuthorityEnvelope,
} from "@oscharko-dev/keiko-contracts";
import {
  assertChildCannotSpawnChild,
  deriveReadOnlyChildEnvelope,
} from "./readOnlyChildEnvelope.js";
import type { ReadOnlyChildEnvelope } from "./readOnlyChildEnvelope.js";

const CHILD_RUN_ID = "chr_child-1" as CodeTaskChildRunId;
const DENY_ALL = { mode: "deny-all", allowLoopback: false, connectorScopes: [] } as const;

// A valid, deliberately broad parent authority: every action class plus a deny-all network posture.
// The derived child must strip everything but read.
function broadParent(): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: "1",
    runId: "run-2387",
    localUser: "local-operator",
    taskRefs: ["issue-2387"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "keiko-workspace",
      rootDigest: "a".repeat(64),
    },
    // Branch is irrelevant to the derivation (which reads runId, actionClasses, and networkPolicy
    // only); it just has to be a valid envelope. headRef/prefixes use approved evidence tokens.
    branch: {
      baseRef: "dev",
      headRef: "task-branch",
      allowDetachedHead: false,
      allowedPrefixes: ["task-"],
    },
    requestedMode: "supervised-coding",
    deploymentCeiling: "supervised-coding",
    effectiveMode: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    // A deny-all network posture forbids the network-egress class (cross-field invariant); the
    // egress-granting shape lives in egressParent(). This parent is still deliberately broad across
    // every other class so the strip tests prove the child collapses it to read-only.
    actionClasses: [
      "workspace-read",
      "workspace-write",
      "command-execution",
      "verification",
      "connector-access",
      "delivery-substrate",
    ],
    connectorScopes: ["source-control.read", "issue-tracker.read"],
    modelProfile: {
      profileId: "local-codex",
      source: "chatgpt-codex-subscription-profile",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: ["npm", "node"],
      deny: ["curl"],
      maxCommandTimeoutMs: 30_000,
      requirePerCommandApproval: true,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval", "verification-green", "artifact-review"],
    budget: {
      maxRuntimeMs: 120_000,
      maxToolCalls: 12,
      maxPromptTokens: 24_000,
      maxPatchBytes: 32_768,
    },
    expiresAt: "2026-07-08T12:00:00Z",
    approvalProofDigest: "b".repeat(64),
  };
}

// A valid parent that actually grants governed egress (read + network only) — the only shape that
// can widen a research-scoped child's network posture past deny-all.
function egressParent(): CodingWorkbenchAuthorityEnvelope {
  return {
    ...broadParent(),
    actionClasses: ["workspace-read", "network-egress"],
    connectorScopes: [],
    commandPolicy: {
      mode: "deny",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 1,
      requirePerCommandApproval: true,
    },
    networkPolicy: { mode: "governed-egress", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval"],
  };
}

function researchGrant(
  expiresAt: string,
  domains: readonly string[] = ["developer.mozilla.org"],
): AuxiliaryResearchScopeV1 {
  return {
    grantId: "grant-1" as AuxiliaryResearchScopeV1["grantId"],
    domains,
    expiresAt,
    queryTextDigest: { outcome: "known", value: "a".repeat(64) },
  };
}

function childRequest(): AuxiliaryCapabilityRequestV1 {
  return {
    taskId: "task-1" as AuxiliaryCapabilityRequestV1["taskId"],
    runId: "run-1" as AuxiliaryCapabilityRequestV1["runId"],
    workspaceId: "ws-1" as AuxiliaryCapabilityRequestV1["workspaceId"],
    stateRevision: 1,
    idempotencyKey: "idem-1" as AuxiliaryCapabilityRequestV1["idempotencyKey"],
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    capability: "child-agent",
    childRunId: CHILD_RUN_ID,
    maxToolCalls: 4,
  };
}

const NOW_LIVE = Date.parse("2026-07-17T00:00:00.000Z");

describe("deriveReadOnlyChildEnvelope", () => {
  it("narrows an over-broad parent to a read-only, one-layer, non-minting envelope", () => {
    const result = deriveReadOnlyChildEnvelope(broadParent(), CHILD_RUN_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.allowedActionClasses).toEqual(["workspace-read"]);
    expect(result.envelope.childDepth).toBe(1);
    expect(result.envelope.oneLayer).toBe(true);
    expect(result.envelope.canMintGrant).toBe(false);
    expect(result.envelope.networkPolicy).toEqual(DENY_ALL);
    expect(result.envelope.parentRunId).toBe("run-2387");
    expect(result.envelope.childRunId).toBe(CHILD_RUN_ID);
  });

  it("strips every write, delivery, command, verification, connector, and network class", () => {
    const result = deriveReadOnlyChildEnvelope(broadParent(), CHILD_RUN_ID);
    if (!result.ok) throw new Error("expected ok");
    for (const stripped of [
      "workspace-write",
      "delivery-substrate",
      "command-execution",
      "verification",
      "connector-access",
      "network-egress",
    ] as const) {
      expect(result.envelope.allowedActionClasses).not.toContain(stripped);
    }
    // The result is always a subset of the parent — never a superset.
    for (const cls of result.envelope.allowedActionClasses) {
      expect(broadParent().actionClasses).toContain(cls);
    }
  });

  it("fails closed to the narrowest envelope when the parent lacks read authority", () => {
    const readless: CodingWorkbenchAuthorityEnvelope = {
      ...broadParent(),
      actionClasses: ["workspace-write"],
      connectorScopes: [],
      commandPolicy: {
        mode: "deny",
        allow: [],
        deny: [],
        maxCommandTimeoutMs: 1,
        requirePerCommandApproval: true,
      },
    };
    const result = deriveReadOnlyChildEnvelope(readless, CHILD_RUN_ID);
    if (!result.ok) throw new Error("expected ok");
    expect(result.envelope.allowedActionClasses).toEqual([]);
    expect(result.envelope.networkPolicy).toEqual(DENY_ALL);
  });

  it("returns an explicit error for a malformed parent envelope", () => {
    const malformed: CodingWorkbenchAuthorityEnvelope = {
      ...broadParent(),
      budget: { ...broadParent().budget, maxToolCalls: 0 },
    };
    expect(deriveReadOnlyChildEnvelope(malformed, CHILD_RUN_ID)).toEqual({
      ok: false,
      reasonCode: "parent-envelope-invalid",
    });
  });

  it("returns an explicit error for a hostile non-object parent", () => {
    const hostile = undefined as unknown as CodingWorkbenchAuthorityEnvelope;
    expect(deriveReadOnlyChildEnvelope(hostile, CHILD_RUN_ID)).toEqual({
      ok: false,
      reasonCode: "parent-envelope-invalid",
    });
  });

  it("rejects a child run id that is not a well-formed chr_ id", () => {
    expect(deriveReadOnlyChildEnvelope(broadParent(), "run-1" as CodeTaskChildRunId)).toEqual({
      ok: false,
      reasonCode: "child-run-id-invalid",
    });
  });

  it("grants governed egress only for a live grant on an egress-granting parent", () => {
    const result = deriveReadOnlyChildEnvelope(egressParent(), CHILD_RUN_ID, {
      research: researchGrant("2026-07-20T00:00:00.000Z"),
      nowMs: NOW_LIVE,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.envelope.networkPolicy).toEqual({
      mode: "governed-egress",
      allowLoopback: false,
      connectorScopes: [],
    });
    expect(result.envelope.allowedActionClasses).toEqual(["workspace-read", "network-egress"]);
  });

  it("denies egress when the research grant has expired", () => {
    const result = deriveReadOnlyChildEnvelope(egressParent(), CHILD_RUN_ID, {
      research: researchGrant("2026-07-16T00:00:00.000Z"),
      nowMs: NOW_LIVE,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.envelope.networkPolicy).toEqual(DENY_ALL);
    expect(result.envelope.allowedActionClasses).toEqual(["workspace-read"]);
  });

  it("denies egress when no clock reading proves the grant live", () => {
    const result = deriveReadOnlyChildEnvelope(egressParent(), CHILD_RUN_ID, {
      research: researchGrant("2026-07-20T00:00:00.000Z"),
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.envelope.networkPolicy).toEqual(DENY_ALL);
  });

  it("denies egress when the parent itself does not grant governed egress", () => {
    const result = deriveReadOnlyChildEnvelope(broadParent(), CHILD_RUN_ID, {
      research: researchGrant("2026-07-20T00:00:00.000Z"),
      nowMs: NOW_LIVE,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.envelope.networkPolicy).toEqual(DENY_ALL);
    expect(result.envelope.allowedActionClasses).toEqual(["workspace-read"]);
  });

  it("denies egress for a hostile grant that names no domains", () => {
    const result = deriveReadOnlyChildEnvelope(egressParent(), CHILD_RUN_ID, {
      research: researchGrant("2026-07-20T00:00:00.000Z", []),
      nowMs: NOW_LIVE,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.envelope.networkPolicy).toEqual(DENY_ALL);
  });
});

describe("assertChildCannotSpawnChild", () => {
  const originChild: ReadOnlyChildEnvelope = {
    parentRunId: "run-2387",
    childRunId: CHILD_RUN_ID,
    childDepth: 1,
    oneLayer: true,
    allowedActionClasses: ["workspace-read"],
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    canMintGrant: false,
  };

  it("admits a child-agent request from a root task context", () => {
    const request = childRequest();
    const admission = assertChildCannotSpawnChild(request, undefined);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    expect(admission.request).toBe(request);
    expect(admission.request.capability).toBe("child-agent");
  });

  it("denies a nested child-agent request originating from a child context", () => {
    expect(assertChildCannotSpawnChild(childRequest(), originChild)).toEqual({
      ok: false,
      reasonCode: "nested-child-denied",
    });
  });

  it("rejects a non-child-agent request routed here by mistake", () => {
    const skill: AuxiliaryCapabilityRequestV1 = {
      taskId: "task-1" as AuxiliaryCapabilityRequestV1["taskId"],
      runId: "run-1" as AuxiliaryCapabilityRequestV1["runId"],
      workspaceId: "ws-1" as AuxiliaryCapabilityRequestV1["workspaceId"],
      stateRevision: 1,
      idempotencyKey: "idem-1" as AuxiliaryCapabilityRequestV1["idempotencyKey"],
      schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
      capability: "skill",
      skillId: "skl_docs-search@1" as CodeTaskSkillId,
      invocation: "explicit",
    };
    expect(assertChildCannotSpawnChild(skill, undefined)).toEqual({
      ok: false,
      reasonCode: "not-a-child-agent-request",
    });
  });
});
