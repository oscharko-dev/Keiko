// Unit tests for the governed Git mutation evidence builder (Issue #474, Epic #470).
// Proves: AC1 — every terminal lifecycle outcome (succeeded, blocked, rejected, failed,
// recovery-required, approval-required) projects to a correlatable evidence record; AC3 — the
// recovery disposition + reused action hint are derived per outcome without string parsing; AC2 —
// remote identifiers, the provider external id, and the repository identity are HASHED, never recorded
// raw, and the approval token never appears (only its hash). The builder is deterministic.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  GitDeliveryActionEnvelope,
  GitDeliveryExecutionResult,
  GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import { buildGitDeliveryEvidenceRecord } from "./git-mutation-evidence.js";
import type {
  GitDeliveryEvidenceBuildInput,
  GitDeliveryEvidenceSnapshot,
} from "./git-mutation-evidence.js";
import type {
  GitMutationLifecycleResult,
  GitMutationOutcome,
} from "./git-mutation-orchestrator.js";
import type { GitMutationLifecyclePhase } from "./git-mutation-taxonomy.js";

const NOW = 1_700_000_000_000;
const WORKFLOW_RUN_ID = "wf-run-123";

const COMMIT_INPUTS: GitDeliveryResolvedInputs = {
  kind: "commit",
  messageByteLength: 42,
  stagedPathCount: 2,
  allowEmptyCommit: false,
};

const SNAPSHOT: GitDeliveryEvidenceSnapshot = {
  headDetached: false,
  currentBranchName: "feature/x",
  stagedFileCount: 2,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
};

const EMPTY_PREFLIGHT = { ok: true, findings: [], blocking: [], advisory: [] } as const;

function envelope(overrides: Partial<GitDeliveryActionEnvelope> = {}): GitDeliveryActionEnvelope {
  return {
    schemaVersion: "1",
    actionId: "act-1",
    kind: "commit",
    resolvedInputs: COMMIT_INPUTS,
    policyDecision: { outcome: "allowed" },
    approvalRequirement: { required: false },
    preview: {
      schemaVersion: "1",
      affectedBranchName: "feature/x",
      estimatedFileCount: 2,
      wouldCreateRemoteBranch: false,
      wouldTriggerChecks: false,
    },
    ...overrides,
  } as GitDeliveryActionEnvelope;
}

function lifecycle(
  outcome: GitMutationOutcome,
  phaseReached: GitMutationLifecyclePhase,
  envelopeOverrides: Partial<GitDeliveryActionEnvelope> = {},
): GitMutationLifecycleResult {
  return {
    envelope: envelope(envelopeOverrides),
    outcome,
    phaseReached,
    preflight: EMPTY_PREFLIGHT,
  };
}

function build(
  result: GitMutationLifecycleResult,
  inputOverrides: Partial<GitDeliveryEvidenceBuildInput> = {},
): ReturnType<typeof buildGitDeliveryEvidenceRecord> {
  return buildGitDeliveryEvidenceRecord(
    { result, snapshot: SNAPSHOT, workflowRunId: WORKFLOW_RUN_ID, ...inputOverrides },
    { now: () => NOW },
  );
}

const SUCCEEDED_EXEC: GitDeliveryExecutionResult = {
  schemaVersion: "1",
  outcome: "succeeded",
  durationMs: 12,
};

interface Scenario {
  readonly name: string;
  readonly result: GitMutationLifecycleResult;
  readonly outcomeClass: string;
  readonly disposition: string;
  readonly actionHint?: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "succeeded",
    result: lifecycle({ status: "succeeded", executionResult: SUCCEEDED_EXEC }, "result", {
      executionResult: SUCCEEDED_EXEC,
    }),
    outcomeClass: "succeeded",
    disposition: "none",
  },
  {
    name: "approval-required",
    result: lifecycle({ status: "approval-required", requiredApprovers: ["lead"] }, "policy", {
      policyDecision: { outcome: "approval-gated", requiredApprovers: ["lead"] },
    }),
    outcomeClass: "approval-required",
    disposition: "user-fixable",
    actionHint: "request-approval",
  },
  {
    name: "blocked-policy",
    result: lifecycle(
      { status: "blocked", category: "policy-block", blockReason: "protected-branch" },
      "policy",
      { policyDecision: { outcome: "blocked", reason: "protected-branch" } },
    ),
    outcomeClass: "blocked",
    disposition: "policy-forbidden",
    actionHint: "adjust-policy-target",
  },
  {
    name: "blocked-preflight",
    result: lifecycle(
      {
        status: "blocked",
        category: "preflight-block",
        findings: [
          {
            code: "no-changes-to-stage",
            severity: "blocking",
            remediation: "user-actionable",
            phase: "preflight",
          },
        ],
      },
      "preflight",
    ),
    outcomeClass: "blocked",
    disposition: "user-fixable",
    actionHint: "stage-changes",
  },
  {
    name: "failed-execution",
    result: lifecycle(
      {
        status: "failed",
        category: "execution-failure",
        executionResult: {
          schemaVersion: "1",
          outcome: "failed",
          durationMs: 8,
          errorCode: "timeout",
        },
      },
      "result",
      {
        executionResult: {
          schemaVersion: "1",
          outcome: "failed",
          durationMs: 8,
          errorCode: "timeout",
        },
      },
    ),
    outcomeClass: "failed",
    disposition: "retryable",
    actionHint: "retry",
  },
  {
    name: "rejected-provider",
    result: lifecycle(
      {
        status: "failed",
        category: "provider-failure",
        executionResult: {
          schemaVersion: "1",
          outcome: "failed",
          durationMs: 8,
          errorCode: "provider-rejected",
        },
      },
      "result",
      {
        executionResult: {
          schemaVersion: "1",
          outcome: "failed",
          durationMs: 8,
          errorCode: "provider-rejected",
        },
      },
    ),
    outcomeClass: "rejected",
    disposition: "user-fixable",
    actionHint: "resolve-conflicts",
  },
  {
    name: "recovery-required",
    result: lifecycle(
      {
        status: "recovery-required",
        category: "recovery-required",
        executionResult: {
          schemaVersion: "1",
          outcome: "failed",
          durationMs: 8,
          errorCode: "conflict",
        },
      },
      "result",
      {
        executionResult: {
          schemaVersion: "1",
          outcome: "failed",
          durationMs: 8,
          errorCode: "conflict",
        },
      },
    ),
    outcomeClass: "recovery-required",
    disposition: "user-fixable",
    actionHint: "recover-via-strategy",
  },
];

describe("buildGitDeliveryEvidenceRecord — AC1 every outcome is correlatable", () => {
  for (const scenario of SCENARIOS) {
    it(`records ${scenario.name} with a workflow correlation`, () => {
      const record = build(scenario.result);
      expect(record.outcomeClass).toBe(scenario.outcomeClass);
      expect(record.correlation.actionId).toBe("act-1");
      expect(record.correlation.workflowRunIdHash).toBe(sha256Hex(WORKFLOW_RUN_ID));
      expect(record.evidenceId.startsWith("gde-")).toBe(true);
      expect(record.recordedAtMs).toBe(NOW);
      expect(record.schemaVersion).toBe("1");
    });
  }
});

describe("buildGitDeliveryEvidenceRecord — AC3 recovery disposition + hint", () => {
  for (const scenario of SCENARIOS) {
    it(`classifies ${scenario.name} as ${scenario.disposition}`, () => {
      const record = build(scenario.result);
      expect(record.recovery.disposition).toBe(scenario.disposition);
      expect(record.recovery.actionHint).toBe(scenario.actionHint);
    });
  }
});

describe("buildGitDeliveryEvidenceRecord — AC2 content-free hashing", () => {
  const PUSH_INPUTS: GitDeliveryResolvedInputs = {
    kind: "push",
    sourceBranchName: "feature/x",
    remoteAlias: "confidential-remote",
    remoteBranchName: "main",
    forcePush: false,
    setUpstreamTracking: true,
  };
  const EXTERNAL_ID = "pr-4242-internal";
  const REPO_ID = "/Users/secretuser/private-repo";
  const pushExec: GitDeliveryExecutionResult = {
    schemaVersion: "1",
    outcome: "succeeded",
    durationMs: 30,
    externalId: EXTERNAL_ID,
  };
  const pushResult = lifecycle({ status: "succeeded", executionResult: pushExec }, "result", {
    kind: "push",
    resolvedInputs: PUSH_INPUTS,
    executionResult: pushExec,
  });

  it("hashes the remote ref, external id, and repo identity", () => {
    const record = build(pushResult, { repoId: REPO_ID });
    expect(record.repoContext.remoteRefHash).toBe(sha256Hex("confidential-remote/main"));
    expect(record.repoContext.repoIdHash).toBe(sha256Hex(REPO_ID));
    expect(record.execution?.externalIdHash).toBe(sha256Hex(EXTERNAL_ID));
  });

  it("never serialises a raw remote alias, external id, or repo path", () => {
    const json = JSON.stringify(build(pushResult, { repoId: REPO_ID }));
    expect(json).not.toContain("confidential-remote");
    expect(json).not.toContain(EXTERNAL_ID);
    expect(json).not.toContain(REPO_ID);
    expect(json).not.toContain("secretuser");
  });

  it("carries the approval token hash but no raw token, and keeps approver provenance", () => {
    const tokenHash = "f".repeat(64);
    const granted = lifecycle({ status: "succeeded", executionResult: SUCCEEDED_EXEC }, "result", {
      executionResult: SUCCEEDED_EXEC,
      approvalRequirement: {
        required: true,
        approvalTokenHash: tokenHash,
        approvedByUserId: "approver-1",
        approvedAtMs: NOW - 1000,
      },
    });
    const record = build(granted);
    expect(record.approval.required).toBe(true);
    expect(record.approval.approvalTokenHash).toBe(tokenHash);
    expect(record.approval.approvedByUserId).toBe("approver-1");
  });
});

function scenario(name: string): Scenario {
  const found = SCENARIOS.find((s) => s.name === name);
  if (found === undefined) {
    throw new Error(`unknown scenario: ${name}`);
  }
  return found;
}

describe("buildGitDeliveryEvidenceRecord — sections and determinism", () => {
  it("includes the preview and execution sections when present", () => {
    const record = build(scenario("succeeded").result);
    expect(record.preview?.affectedBranchName).toBe("feature/x");
    expect(record.execution?.outcome).toBe("succeeded");
    expect(record.execution?.durationMs).toBe(12);
  });

  it("omits the execution section for a blocked attempt", () => {
    const record = build(scenario("blocked-policy").result);
    expect(record.execution).toBeUndefined();
    expect(record.blockReason).toBe("protected-branch");
  });

  it("is deterministic for identical inputs", () => {
    const a = build(scenario("succeeded").result);
    const b = build(scenario("succeeded").result);
    expect(a).toStrictEqual(b);
    expect(a.evidenceId).toBe(b.evidenceId);
  });

  it("records the risk class and severity for the action kind", () => {
    const record = build(scenario("succeeded").result);
    expect(record.riskClass).toBe("local-mutation");
    expect(record.riskSeverity).toBe(1);
  });

  // Regression: the kernel evaluates policy eagerly even when preflight halts first, so a
  // preflight-blocked envelope can carry a "blocked" policyDecision. That policy reason must NOT
  // become the record's blockReason — it would contradict the preflight disposition.
  it("does not attach a policy block reason to a preflight-blocked attempt", () => {
    const preflightBlockedWithPolicyDenial = lifecycle(
      {
        status: "blocked",
        category: "preflight-block",
        findings: [
          {
            code: "no-changes-to-stage",
            severity: "blocking",
            remediation: "user-actionable",
            phase: "preflight",
          },
        ],
      },
      "preflight",
      { policyDecision: { outcome: "blocked", reason: "risk-class-ceiling" } },
    );
    const record = build(preflightBlockedWithPolicyDenial);
    expect(record.outcomeClass).toBe("blocked");
    expect(record.phaseReached).toBe("preflight");
    expect(record.policyOutcome).toBe("blocked");
    expect(record.blockReason).toBeUndefined();
    expect(record.recovery.disposition).toBe("user-fixable");
    expect(record.recovery.actionHint).toBe("stage-changes");
  });

  it("strips bidirectional/zero-width format characters from echoed branch names", () => {
    // U+202E (right-to-left override) via escape so no bidi char appears in this source file.
    const rtlOverride = "\u202E";
    const spoofed = lifecycle({ status: "succeeded", executionResult: SUCCEEDED_EXEC }, "result", {
      executionResult: SUCCEEDED_EXEC,
      preview: {
        schemaVersion: "1",
        affectedBranchName: `feature/${rtlOverride}evil`,
        wouldCreateRemoteBranch: false,
        wouldTriggerChecks: false,
      },
    });
    const record = build(spoofed);
    expect(record.preview?.affectedBranchName).toBe("feature/evil");
    expect(record.repoContext.targetBranchName).toBe("feature/x");
  });
});
