import { describe, expect, it } from "vitest";
import { buildEvidenceManifest } from "../../src/audit/build.js";
import type { EvidenceBuildInput } from "../../src/audit/types.js";
import type {
  HarnessEvent,
  HarnessLimits,
  RunManifest,
  RunResult,
  TaskInput,
} from "../../src/harness/types.js";
import { DEFAULT_LIMITS } from "../../src/harness/types.js";
import type { AuditSummary } from "../../src/workspace/types.js";
import type { VerificationAuditSummary } from "../../src/verification/summary.js";

const RUN_ID = "run-abc";
const FP = "fp-1";

// A secret-shaped fixture built non-contiguously so push-protection does not block the push.
const GITHUB = `ghp_${"A".repeat(36)}`;
const ENV_SECRET = "env-secret-value-987654321";

function base(
  seq: number,
  ts: number,
): { schemaVersion: "1"; runId: string; fingerprint: string; seq: number; ts: number } {
  return { schemaVersion: "1", runId: RUN_ID, fingerprint: FP, seq, ts };
}

function fullEventMix(): readonly HarnessEvent[] {
  return [
    {
      ...base(0, 100),
      type: "run:started",
      taskType: "investigate-bug",
      modelId: "m1",
      limits: DEFAULT_LIMITS,
    },
    {
      ...base(1, 110),
      type: "state:transition",
      from: "intake",
      to: "planning",
      reason: `plan ${GITHUB}`,
    },
    {
      ...base(2, 120),
      type: "model:call:completed",
      modelId: "m1",
      finishReason: "stop",
      toolCallCount: 1,
      usage: { requestId: "r", promptTokens: 10, completionTokens: 5, latencyMs: 30 },
    },
    { ...base(3, 130), type: "tool:call:started", toolName: "grep", toolCallId: "t1" },
    {
      ...base(4, 140),
      type: "tool:call:completed",
      toolName: "grep",
      toolCallId: "t1",
      durationMs: 12,
    },
    {
      ...base(5, 150),
      type: "tool:call:failed",
      toolName: "read",
      toolCallId: "t2",
      errorCode: "TOOL_ARGUMENT",
      message: "boom",
    },
    {
      ...base(6, 160),
      type: "sandbox:configured",
      envAllowlist: ["PATH", "TZ"],
      network: "inherit",
      maxOutputBytes: 1_048_576,
      timeoutMs: 30_000,
      terminationGraceMs: 2_000,
      cwdRequested: true,
    },
    {
      ...base(7, 165),
      type: "command:executed",
      executable: "node",
      argCount: 2,
      exitCode: 0,
      timedOut: false,
      durationMs: 40,
    },
    {
      ...base(8, 170),
      type: "patch:proposed",
      targetFile: "src/x.ts",
      patchBytes: 64,
      diff: `--- a\n+++ b\n+const k = "${GITHUB}";`,
    },
    { ...base(9, 180), type: "patch:applied", changedFiles: 1, created: 0, deleted: 0 },
    {
      ...base(10, 190),
      type: "verification:result",
      passed: true,
      detail: `verified ${GITHUB}`,
    },
    {
      ...base(11, 195),
      type: "reasoning:trace",
      phase: "planning",
      rationale: `mentions ${ENV_SECRET}`,
      modelResponse: "ok",
    },
    { ...base(12, 200), type: "run:completed", report: "done" },
  ];
}

function makeResult(events: readonly HarnessEvent[], over: Partial<RunResult> = {}): RunResult {
  return {
    runId: RUN_ID,
    fingerprint: FP,
    outcome: "completed",
    taskType: "investigate-bug",
    startedAt: 100,
    finishedAt: 200,
    events,
    ...over,
  };
}

function makeManifest(events: readonly HarnessEvent[]): RunManifest {
  const taskInput: TaskInput = { taskType: "investigate-bug", input: { description: "x" } };
  const limits: HarnessLimits = DEFAULT_LIMITS;
  return {
    runId: RUN_ID,
    fingerprint: FP,
    harnessVersion: "0.1.5",
    taskType: "investigate-bug",
    taskInput,
    limits,
    modelId: "m1",
    workingDirectory: "/repo",
    dryRun: true,
    startedAt: "2026-05-29T00:00:00.000Z",
    events,
  };
}

function inputFor(
  events: readonly HarnessEvent[],
  over: Partial<EvidenceBuildInput> = {},
): EvidenceBuildInput {
  return { result: makeResult(events), manifest: makeManifest(events), ...over };
}

describe("buildEvidenceManifest — full event mix mapping", () => {
  const manifest = buildEvidenceManifest(inputFor(fullEventMix()), {});

  it("maps run identity with computed duration", () => {
    expect(manifest.evidenceSchemaVersion).toBe("1");
    expect(manifest.run).toMatchObject({
      runId: RUN_ID,
      fingerprint: FP,
      harnessVersion: "0.1.5",
      taskType: "investigate-bug",
      outcome: "completed",
      startedAt: 100,
      finishedAt: 200,
      durationMs: 100,
    });
  });

  it("recovers the model + cost class and aggregates usage", () => {
    expect(manifest.model.modelId).toBe("m1");
    expect(manifest.model.costClass).toBe("unknown");
    expect(manifest.usageTotals).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      requestCount: 1,
      totalLatencyMs: 30,
    });
  });

  it("maps state transitions with seq preserved", () => {
    expect(manifest.stateTransitions).toHaveLength(1);
    expect(manifest.stateTransitions[0]?.seq).toBe(1);
    expect(manifest.stateTransitions[0]?.from).toBe("intake");
  });

  it("maps tool calls (completed + failed) preserving seq and outcome", () => {
    expect(manifest.toolCalls).toHaveLength(2);
    expect(manifest.toolCalls[0]).toMatchObject({
      seq: 4,
      toolName: "grep",
      outcome: "completed",
      durationMs: 12,
    });
    expect(manifest.toolCalls[1]).toMatchObject({
      seq: 5,
      toolName: "read",
      outcome: "failed",
      errorCode: "TOOL_ARGUMENT",
    });
  });

  it("maps command executions", () => {
    expect(manifest.commandExecutions).toHaveLength(1);
    expect(manifest.commandExecutions[0]).toMatchObject({
      executable: "node",
      argCount: 2,
      exitCode: 0,
      timedOut: false,
    });
  });

  it("maps sandbox configurations with names and limits only", () => {
    expect(manifest.sandboxConfigurations).toHaveLength(1);
    expect(manifest.sandboxConfigurations?.[0]).toMatchObject({
      seq: 6,
      envAllowlist: ["PATH", "TZ"],
      network: "inherit",
      maxOutputBytes: 1_048_576,
      timeoutMs: 30_000,
      terminationGraceMs: 2_000,
      cwdRequested: true,
    });
    expect(JSON.stringify(manifest.sandboxConfigurations)).not.toContain(ENV_SECRET);
  });

  it("maps patch counts and excludes the diff by default", () => {
    expect(manifest.patch).toMatchObject({
      proposed: true,
      applied: true,
      targetFileCount: 1,
      patchBytes: 64,
      changedFiles: 1,
    });
    expect(manifest.patch?.redactedDiff).toBeUndefined();
  });

  it("maps verification results and redacts their detail", () => {
    expect(manifest.verificationResults).toHaveLength(1);
    expect(manifest.verificationResults?.[0]).toMatchObject({
      seq: 10,
      passed: true,
    });
    expect(manifest.verificationResults?.[0]?.detail).not.toContain(GITHUB);
  });

  it("omits reasoning by default", () => {
    expect(manifest.reasoning).toBeUndefined();
  });
});

describe("buildEvidenceManifest — absent sections are undefined", () => {
  it("omits patch / verification / context / failure / reasoning when no source", () => {
    const events: readonly HarnessEvent[] = [
      {
        ...base(0, 100),
        type: "run:started",
        taskType: "explain-plan",
        modelId: "m1",
        limits: DEFAULT_LIMITS,
      },
      { ...base(1, 200), type: "run:completed", report: "done" },
    ];
    const m = buildEvidenceManifest(inputFor(events), {});
    expect(m.patch).toBeUndefined();
    expect(m.verification).toBeUndefined();
    expect(m.context).toBeUndefined();
    expect(m.failure).toBeUndefined();
    expect(m.reasoning).toBeUndefined();
    expect(m.toolCalls).toEqual([]);
    expect(m.commandExecutions).toEqual([]);
    expect(m.sandboxConfigurations).toBeUndefined();
    expect(m.verificationResults).toBeUndefined();
    expect(m.stateTransitions).toEqual([]);
  });
});

describe("buildEvidenceManifest — opt-ins", () => {
  it("includes a redacted diff when includeDiff is true", () => {
    const m = buildEvidenceManifest(
      inputFor(fullEventMix(), { options: { includeDiff: true } }),
      {},
    );
    expect(m.patch?.redactedDiff).toBeDefined();
    expect(m.patch?.redactedDiff).not.toContain(GITHUB);
    expect(m.patch?.redactedDiff).toContain("[REDACTED]");
  });

  it("includes redacted reasoning entries when includeReasoning is true", () => {
    const env = { LEAK: ENV_SECRET };
    const m = buildEvidenceManifest(
      inputFor(fullEventMix(), {
        options: { includeReasoning: true },
        redaction: { redactEnvValues: ["LEAK"] },
      }),
      { env },
    );
    expect(m.reasoning).toHaveLength(1);
    expect(m.reasoning?.[0]?.seq).toBe(11);
    expect(m.reasoning?.[0]?.rationale).not.toContain(ENV_SECRET);
    expect(m.reasoning?.[0]?.rationale).toContain("[REDACTED]");
  });
});

describe("buildEvidenceManifest — redaction by construction", () => {
  it("redacts the GitHub token in a state-transition reason", () => {
    const m = buildEvidenceManifest(inputFor(fullEventMix()), {});
    expect(m.stateTransitions[0]?.reason).not.toContain(GITHUB);
    expect(m.stateTransitions[0]?.reason).toContain("[REDACTED]");
  });

  it("redacts the failure message and keeps the category", () => {
    const events: readonly HarnessEvent[] = [
      {
        ...base(0, 100),
        type: "run:started",
        taskType: "explain-plan",
        modelId: "m1",
        limits: DEFAULT_LIMITS,
      },
      {
        ...base(1, 200),
        type: "run:failed",
        atState: "model-call",
        failure: {
          category: "HARNESS_MODEL_ERROR",
          message: `leak ${GITHUB}`,
          detail: "secret detail",
        },
      },
    ];
    const m = buildEvidenceManifest(
      inputFor(events, {
        result: makeResult(events, {
          outcome: "failed",
          failure: { category: "HARNESS_MODEL_ERROR", message: `leak ${GITHUB}` },
        }),
      }),
      {},
    );
    expect(m.failure?.category).toBe("HARNESS_MODEL_ERROR");
    expect(m.failure?.message).not.toContain(GITHUB);
    expect(m.failure?.message).toContain("[REDACTED]");
  });
});

describe("buildEvidenceManifest — embedded summaries", () => {
  it("embeds the context and verification summaries verbatim", () => {
    const context: AuditSummary = {
      workspaceRoot: "/repo",
      totalCandidates: 3,
      usedBytes: 100,
      budgetBytes: 200,
      droppedForBudget: 1,
      entries: [],
    };
    const verification: VerificationAuditSummary = {
      workspaceRoot: "/repo",
      overallStatus: "passed",
      durationMs: 50,
      counts: {
        passed: 1,
        failed: 0,
        skipped: 0,
        denied: 0,
        "timed-out": 0,
        cancelled: 0,
        "resource-exceeded": 0,
      },
      results: [],
    };
    const m = buildEvidenceManifest(inputFor(fullEventMix(), { context, verification }), {});
    expect(m.context).toEqual(context);
    expect(m.verification).toEqual(verification);
  });

  it("redacts a configured literal + env-value embedded in the summaries IN THE BUILDER (C2)", () => {
    const LITERAL = "internal.corp.example";
    const context: AuditSummary = {
      workspaceRoot: `/repo on host ${LITERAL}`,
      totalCandidates: 1,
      usedBytes: 1,
      budgetBytes: 1,
      droppedForBudget: 0,
      entries: [
        {
          path: `src/${LITERAL}.ts`,
          sizeBytes: 1,
          excerptBytes: 0,
          selectionReason: "source",
          truncated: false,
        },
      ],
    };
    const verification: VerificationAuditSummary = {
      workspaceRoot: `/repo via ${ENV_SECRET}`,
      overallStatus: "passed",
      durationMs: 1,
      counts: {
        passed: 1,
        failed: 0,
        skipped: 0,
        denied: 0,
        "timed-out": 0,
        cancelled: 0,
        "resource-exceeded": 0,
      },
      results: [],
    };
    const m = buildEvidenceManifest(
      inputFor(fullEventMix(), {
        context,
        verification,
        redaction: { sensitiveLiterals: [LITERAL], redactEnvValues: ["LEAK"] },
      }),
      { env: { LEAK: ENV_SECRET } },
    );
    // A direct builder caller (not via persistEvidence) must already see a redacted manifest.
    const json = JSON.stringify(m);
    expect(json).not.toContain(LITERAL);
    expect(json).not.toContain(ENV_SECRET);
    expect(m.context?.workspaceRoot).toContain("[REDACTED]");
    expect(m.context?.entries[0]?.path).toContain("[REDACTED]");
    expect(m.verification?.workspaceRoot).toContain("[REDACTED]");
  });
});
