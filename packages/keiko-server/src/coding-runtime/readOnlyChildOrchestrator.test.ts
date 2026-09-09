import { describe, expect, it, vi } from "vitest";
import { CODE_TASK_AUXILIARY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type {
  AuxiliaryCapabilityRequestV1,
  CodeTaskChildRunId,
  CodeTaskSkillId,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import {
  createReadOnlyChildOrchestrator,
  ReadOnlyChildTrustViolationError,
} from "./readOnlyChildOrchestrator.js";
import type {
  ReadOnlyChildBudgetCharger,
  ReadOnlyChildCancellationSource,
  ReadOnlyChildInvocationContext,
  ReadOnlyChildOrchestratorDeps,
  ReadOnlyChildRunner,
  ReadOnlyChildRunnerResult,
  ReadOnlyChildStopReason,
  ReadOnlyChildToolAttempt,
} from "./readOnlyChildOrchestrator.js";
import type { ReadOnlyChildEnvelope } from "./readOnlyChildEnvelope.js";
import type { ServerLogEvent } from "../observability/server-log.js";

const CHILD_RUN_ID = "chr_child-1" as CodeTaskChildRunId;
const READ: ReadOnlyChildToolAttempt = { toolClass: "workspace-read" };

function parentAuthority(): CodingWorkbenchAuthorityEnvelope {
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
    branch: {
      baseRef: "dev",
      headRef: "issue/2387",
      allowDetachedHead: false,
      allowedPrefixes: ["issue/", "codex/"],
    },
    requestedMode: "supervised-coding",
    deploymentCeiling: "supervised-coding",
    effectiveMode: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write", "verification"],
    connectorScopes: [],
    modelProfile: {
      profileId: "local-codex",
      source: "chatgpt-codex-subscription-profile",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "deny",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 1,
      requirePerCommandApproval: true,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval", "verification-green"],
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

function childRequest(maxToolCalls = 4): AuxiliaryCapabilityRequestV1 {
  return {
    taskId: "task-1" as AuxiliaryCapabilityRequestV1["taskId"],
    runId: "run-1" as AuxiliaryCapabilityRequestV1["runId"],
    workspaceId: "ws-1" as AuxiliaryCapabilityRequestV1["workspaceId"],
    stateRevision: 1,
    idempotencyKey: "idem-1" as AuxiliaryCapabilityRequestV1["idempotencyKey"],
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    capability: "child-agent",
    childRunId: CHILD_RUN_ID,
    maxToolCalls,
  };
}

// A runner that routes a fixed script of tool attempts through the gate, stopping at the first
// refusal, and reports the number of admitted reads.
function scriptedRunner(attempts: readonly ReadOnlyChildToolAttempt[]): ReadOnlyChildRunner {
  return {
    run: async (input): Promise<ReadOnlyChildRunnerResult> => {
      await Promise.resolve();
      let admitted = 0;
      for (const attempt of attempts) {
        const decision = input.gate(attempt);
        if (!decision.ok) break;
        admitted += 1;
      }
      return { resultCount: admitted, resultDigest: { outcome: "absent" } };
    },
  };
}

interface Harness {
  readonly events: CodingWorkbenchRuntimeEvent[];
  readonly logs: ServerLogEvent[];
  readonly deps: ReadOnlyChildOrchestratorDeps;
}

function harness(
  runner: ReadOnlyChildRunner,
  overrides: {
    charger?: ReadOnlyChildBudgetCharger;
    cancellation?: ReadOnlyChildCancellationSource;
    clock?: { now: () => number };
  } = {},
): Harness {
  const events: CodingWorkbenchRuntimeEvent[] = [];
  const logs: ServerLogEvent[] = [];
  let seq = 0;
  return {
    events,
    logs,
    deps: {
      runner,
      charger: overrides.charger ?? { chargeParentToolCall: () => true },
      cancellation: overrides.cancellation ?? { stopReason: () => undefined },
      emit: (event): void => {
        events.push(event);
      },
      activityLog: { write: (event): void => void logs.push(event) },
      clock: overrides.clock ?? { now: () => 0 },
      newEventId: () => `event-run-${String((seq += 1))}`,
    },
  };
}

function contextFor(
  extra: {
    parentAuthority?: CodingWorkbenchAuthorityEnvelope;
    deadlineMs?: number;
    signal?: AbortSignal;
    originChildEnvelope?: ReadOnlyChildEnvelope;
  } = {},
): ReadOnlyChildInvocationContext {
  const base = {
    parentAuthority: extra.parentAuthority ?? parentAuthority(),
    objective: "Inspect repository structure",
    modelId: "test-model",
    workspaceRoot: "/workspace",
    deadlineMs: extra.deadlineMs ?? 10_000,
    signal: extra.signal ?? new AbortController().signal,
  };
  return extra.originChildEnvelope === undefined
    ? base
    : { ...base, originChildEnvelope: extra.originChildEnvelope };
}

function eventOfKind(
  events: readonly CodingWorkbenchRuntimeEvent[],
  kind: CodingWorkbenchRuntimeEvent["kind"],
): CodingWorkbenchRuntimeEvent {
  const found = events.find((event) => event.kind === kind);
  if (found === undefined) throw new Error(`missing ${kind} event`);
  return found;
}

function logOfOp(logs: readonly ServerLogEvent[], op: string): ServerLogEvent {
  const found = logs.find((log) => log.op === op);
  if (found === undefined) throw new Error(`missing log with op ${op}`);
  return found;
}

const CHILD_ORIGIN: ReadOnlyChildEnvelope = {
  parentRunId: "run-2387",
  childRunId: "chr_parent-child" as CodeTaskChildRunId,
  childDepth: 1,
  oneLayer: true,
  allowedActionClasses: ["workspace-read"],
  networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
  canMintGrant: false,
};

describe("createReadOnlyChildOrchestrator", () => {
  it("accepts a bounded read-only run and charges every tool call to the parent", async () => {
    let charges = 0;
    const charger: ReadOnlyChildBudgetCharger = {
      chargeParentToolCall: () => {
        charges += 1;
        return true;
      },
    };
    const { events, logs, deps } = harness(scriptedRunner([READ, READ, READ]), { charger });
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(charges).toBe(3);
    expect(outcome).toMatchObject({
      status: "accepted",
      capability: "child-agent",
      childResultCount: { outcome: "known", value: 3 },
    });
    expect(events.map((event) => event.kind)).toEqual(["child-run-started", "child-run-completed"]);
    const completed = eventOfKind(events, "child-run-completed");
    expect(completed).toMatchObject({ auxiliaryOutcome: "accepted", childResultCount: 3 });
    expect(validateCodingWorkbenchRuntimeEvent(completed).ok).toBe(true);
    // §AC7: a healthy primary sink attempts exactly one durable terminal write, on the ACCEPTED
    // path too — not only on a crash/denial.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      op: "coding-runtime.read-only-child.completed",
      correlationId: "run-2387",
      level: "info",
      extra: { childRunId: CHILD_RUN_ID, terminal: "accepted" },
    });
  });

  it("treats an explicit zero result count as a valid accepted outcome", async () => {
    const { events, deps } = harness(scriptedRunner([]));
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toMatchObject({
      status: "accepted",
      childResultCount: { outcome: "known", value: 0 },
    });
    expect(eventOfKind(events, "child-run-completed")).toMatchObject({
      auxiliaryOutcome: "accepted",
      childResultCount: 0,
    });
  });

  it("denies a mutation attempt from within the read-only child", async () => {
    const { logs, deps } = harness(scriptedRunner([{ toolClass: "workspace-write" }]));
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toEqual({
      schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
      status: "denied",
      capability: "child-agent",
      reasonCode: "workspace-write-denied",
    });
    // §AC7: an ordinary gate denial is a durable terminal too, not only a crash/trust-violation.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      op: "coding-runtime.read-only-child.completed",
      level: "warn",
      extra: { childRunId: CHILD_RUN_ID, terminal: "denied", reasonCode: "workspace-write-denied" },
    });
  });

  it("denies a delivery attempt from within the read-only child", async () => {
    const { deps } = harness(scriptedRunner([{ toolClass: "delivery-substrate" }]));
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toMatchObject({ status: "denied", reasonCode: "delivery-denied" });
  });

  it("denies a nested child requested from within a running child (gate path)", async () => {
    const attempt: ReadOnlyChildToolAttempt = { toolClass: "child-agent" };
    const { deps } = harness(scriptedRunner([attempt]));
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toMatchObject({ status: "denied", reasonCode: "nested-child-denied" });
  });

  it("denies a nested child before any run when the caller is itself a child, and still audits it", async () => {
    const { events, logs, deps } = harness(scriptedRunner([READ]));
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor({ originChildEnvelope: CHILD_ORIGIN }),
    );
    expect(outcome).toMatchObject({ status: "denied", reasonCode: "nested-child-denied" });
    expect(events.map((event) => event.kind)).toEqual(["child-run-completed"]);
    const completed = eventOfKind(events, "child-run-completed");
    expect(completed).toMatchObject({ auxiliaryOutcome: "denied", childResultCount: 0 });
    expect(validateCodingWorkbenchRuntimeEvent(completed).ok).toBe(true);
    // §AC7: admission denial (never reaching runChild at all) is a durable terminal too — this is
    // the path the crash-only fix left unaudited on the primary activity sink.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      op: "coding-runtime.read-only-child.completed",
      correlationId: "run-2387",
      extra: { childRunId: CHILD_RUN_ID, terminal: "denied", reasonCode: "nested-child-denied" },
    });
  });

  it("reports limit-reached when the parent budget is exhausted mid-run", async () => {
    let charges = 0;
    const charger: ReadOnlyChildBudgetCharger = {
      chargeParentToolCall: () => {
        charges += 1;
        return charges <= 2;
      },
    };
    const { logs, deps } = harness(scriptedRunner([READ, READ, READ, READ]), { charger });
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(8),
      contextFor(),
    );
    expect(charges).toBe(3);
    expect(outcome).toMatchObject({
      status: "limit-reached",
      reasonCode: "parent-budget-exceeded",
    });
    // §AC7: an exhausted-budget terminal is a durable terminal too.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      op: "coding-runtime.read-only-child.completed",
      extra: {
        childRunId: CHILD_RUN_ID,
        terminal: "limit-reached",
        reasonCode: "parent-budget-exceeded",
      },
    });
  });

  it("reports limit-reached when the request's own tool-call bound is hit first", async () => {
    const { deps } = harness(scriptedRunner([READ, READ, READ]));
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(2),
      contextFor(),
    );
    expect(outcome).toMatchObject({ status: "limit-reached", reasonCode: "child-max-tool-calls" });
  });

  it("cascades a parent stop to a stopped outcome with no orphan tool call", async () => {
    let charges = 0;
    const cancelState: { reason: ReadOnlyChildStopReason | undefined } = { reason: undefined };
    const runner: ReadOnlyChildRunner = {
      run: async (input): Promise<ReadOnlyChildRunnerResult> => {
        await Promise.resolve();
        cancelState.reason = "parent-stopped";
        input.gate(READ);
        input.gate(READ);
        return { resultCount: 0, resultDigest: { outcome: "absent" } };
      },
    };
    const charger: ReadOnlyChildBudgetCharger = {
      chargeParentToolCall: () => {
        charges += 1;
        return true;
      },
    };
    const { events, logs, deps } = harness(runner, {
      charger,
      cancellation: { stopReason: () => cancelState.reason },
    });
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toMatchObject({ status: "stopped", reasonCode: "parent-stopped" });
    expect(charges).toBe(0);
    expect(eventOfKind(events, "child-run-completed")).toMatchObject({
      auxiliaryOutcome: "stopped",
    });
    // §AC7: a cascaded stop is a durable terminal too.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      op: "coding-runtime.read-only-child.completed",
      extra: { childRunId: CHILD_RUN_ID, terminal: "stopped", reasonCode: "parent-stopped" },
    });
  });

  it("cascades a wall-clock timeout to a stopped outcome", async () => {
    const clockValue = { current: 0 };
    const runner: ReadOnlyChildRunner = {
      run: async (input): Promise<ReadOnlyChildRunnerResult> => {
        await Promise.resolve();
        clockValue.current = 5_000;
        input.gate(READ);
        return { resultCount: 0, resultDigest: { outcome: "absent" } };
      },
    };
    const { deps } = harness(runner, { clock: { now: () => clockValue.current } });
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor({ deadlineMs: 1_000 }),
    );
    expect(outcome).toMatchObject({ status: "stopped", reasonCode: "timeout" });
  });

  it("stops before starting when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { events, deps } = harness(scriptedRunner([READ]));
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor({ signal: controller.signal }),
    );
    expect(outcome).toMatchObject({ status: "stopped", reasonCode: "parent-stopped" });
    // A stop before starting is still audited: the denied spawn is visible on the event hub.
    expect(eventOfKind(events, "child-run-completed")).toMatchObject({
      auxiliaryOutcome: "stopped",
      childResultCount: 0,
    });
  });

  it("fails closed to unavailable when the parent authority is invalid, and still audits it", async () => {
    const invalid: CodingWorkbenchAuthorityEnvelope = {
      ...parentAuthority(),
      budget: { ...parentAuthority().budget, maxToolCalls: 0 },
    };
    const { events, deps } = harness(scriptedRunner([READ]));
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor({ parentAuthority: invalid }),
    );
    expect(outcome).toMatchObject({ status: "unavailable", reasonCode: "parent-envelope-invalid" });
    expect(eventOfKind(events, "child-run-completed")).toMatchObject({
      auxiliaryOutcome: "unavailable",
      childResultCount: 0,
    });
  });

  it("denies a non-child-agent request routed to the child orchestrator", async () => {
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
    const { events, deps } = harness(scriptedRunner([READ]));
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      skill,
      contextFor(),
    );
    expect(outcome).toMatchObject({ status: "denied", reasonCode: "not-a-child-agent-request" });
    expect(events).toEqual([]);
  });

  it("fails closed to unavailable when the bounded runner throws", async () => {
    const runner: ReadOnlyChildRunner = {
      run: () => Promise.reject(new Error("runner fault")),
    };
    const { events, deps } = harness(runner);
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toMatchObject({ status: "unavailable", reasonCode: "child-runner-error" });
    expect(eventOfKind(events, "child-run-completed")).toMatchObject({
      auxiliaryOutcome: "unavailable",
    });
  });

  // Residual finding from the #3407 catalog migration review: the child's mandatory tool-catalog
  // bind now rejects a fabricated tool call or malformed arguments strictly before any tool -- and
  // so before any workspace read -- ever executes (productionReadOnlyChildRunner.test.ts: "fails
  // closed when the model calls a tool it was never given" / "fails closed on a non-string
  // relativePath"). That refusal never reaches this orchestrator's gate, so a runner MUST signal it
  // with `ReadOnlyChildTrustViolationError` rather than an opaque throw -- a trust-boundary refusal
  // is a closed `denied`, never the `unavailable` this file reserves for lost infrastructure.
  it("classifies a fabricated tool call as denied, not unavailable, charging nothing", async () => {
    let charges = 0;
    const charger: ReadOnlyChildBudgetCharger = {
      chargeParentToolCall: () => {
        charges += 1;
        return true;
      },
    };
    const runner: ReadOnlyChildRunner = {
      run: () => Promise.reject(new ReadOnlyChildTrustViolationError("fabricated-tool-denied")),
    };
    const { events, logs, deps } = harness(runner, { charger });
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toMatchObject({ status: "denied", reasonCode: "fabricated-tool-denied" });
    // No tool call was ever charged against the parent budget -- nothing reached the point where a
    // read could have touched the workspace.
    expect(charges).toBe(0);
    expect(eventOfKind(events, "child-run-completed")).toMatchObject({
      auxiliaryOutcome: "denied",
      childResultCount: 0,
    });
    // §AC7: the crash/trust-violation path keeps its richer diagnostic write (runner-failed) AND
    // now also gets the same generic durable terminal write every other terminal gets
    // (completed) — one additional diagnostic line, not a replacement.
    expect(logs).toHaveLength(2);
    expect(logOfOp(logs, "coding-runtime.read-only-child.runner-failed")).toMatchObject({
      correlationId: "run-2387",
      errorKind: "ReadOnlyChildTrustViolationError",
      extra: {
        childRunId: CHILD_RUN_ID,
        terminal: "denied",
        reasonCode: "fabricated-tool-denied",
      },
    });
    expect(logOfOp(logs, "coding-runtime.read-only-child.completed")).toMatchObject({
      correlationId: "run-2387",
      extra: { childRunId: CHILD_RUN_ID, terminal: "denied", reasonCode: "fabricated-tool-denied" },
    });
  });

  it("classifies malformed tool arguments as denied, not unavailable, charging nothing", async () => {
    let charges = 0;
    const charger: ReadOnlyChildBudgetCharger = {
      chargeParentToolCall: () => {
        charges += 1;
        return true;
      },
    };
    const runner: ReadOnlyChildRunner = {
      run: () =>
        Promise.reject(new ReadOnlyChildTrustViolationError("malformed-tool-arguments-denied")),
    };
    const { events, deps } = harness(runner, { charger });
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toMatchObject({
      status: "denied",
      reasonCode: "malformed-tool-arguments-denied",
    });
    expect(charges).toBe(0);
    expect(eventOfKind(events, "child-run-completed")).toMatchObject({
      auxiliaryOutcome: "denied",
      childResultCount: 0,
    });
  });

  it("still latches a governance terminal reached before a trust-violation-shaped throw", async () => {
    // If the gate already latched a real governance terminal (e.g. a parent stop) before the
    // runner rejects, that latched terminal is authoritative -- never overridden by the error the
    // runner happened to throw on its way out.
    const runner: ReadOnlyChildRunner = {
      run: (input) => {
        input.gate({ toolClass: "workspace-write" });
        return Promise.reject(new ReadOnlyChildTrustViolationError("fabricated-tool-denied"));
      },
    };
    const { deps } = harness(runner);
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toMatchObject({ status: "denied", reasonCode: "workspace-write-denied" });
  });

  it("emits a content-free redacted diagnostic tying the opaque runner fault to an event id", async () => {
    const runner: ReadOnlyChildRunner = {
      run: () => Promise.reject(new Error("secret stack trace: sk-should-never-leak")),
    };
    const { events, logs, deps } = harness(runner);
    await createReadOnlyChildOrchestrator(deps).handleChildRequest(childRequest(), contextFor());
    const diagnostic = eventOfKind(events, "failure-redacted");
    expect(diagnostic).toMatchObject({ failureCode: "failure-redacted", retryable: false });
    expect(typeof diagnostic.eventId).toBe("string");
    expect(diagnostic.eventId.length).toBeGreaterThan(0);
    expect(validateCodingWorkbenchRuntimeEvent(diagnostic).ok).toBe(true);
    expect(logs).toHaveLength(2);
    const runnerFailed = logOfOp(logs, "coding-runtime.read-only-child.runner-failed");
    expect(runnerFailed).toMatchObject({
      correlationId: "run-2387",
      errorKind: "Error",
      extra: {
        childRunId: CHILD_RUN_ID,
        terminal: "unavailable",
        reasonCode: "child-runner-error",
      },
    });
    expect(Array.isArray(runnerFailed.extra?.frames)).toBe(true);
    expect(Array.isArray(runnerFailed.extra?.causeChain)).toBe(true);
    expect(logOfOp(logs, "coding-runtime.read-only-child.completed")).toMatchObject({
      correlationId: "run-2387",
      extra: {
        childRunId: CHILD_RUN_ID,
        terminal: "unavailable",
        reasonCode: "child-runner-error",
      },
    });
    expect(JSON.stringify(logs)).not.toContain("sk-should-never-leak");
  });

  it("re-checks authority after the runner resolves: a mid-run revocation yields stopped, not accepted", async () => {
    const cancelState: { reason: ReadOnlyChildStopReason | undefined } = { reason: undefined };
    const runner: ReadOnlyChildRunner = {
      run: () => {
        // The runner never calls the gate again after this point, so nothing latches state — the
        // revocation is only visible to a post-resolution authority re-check.
        cancelState.reason = "authority-revoked";
        return Promise.resolve({ resultCount: 3, resultDigest: { outcome: "absent" } });
      },
    };
    const { events, deps } = harness(runner, {
      cancellation: { stopReason: () => cancelState.reason },
    });
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor(),
    );
    expect(outcome).toMatchObject({ status: "stopped", reasonCode: "authority-revoked" });
    expect(eventOfKind(events, "child-run-completed")).toMatchObject({
      auxiliaryOutcome: "stopped",
    });
  });

  it("re-checks authority after the runner resolves: a deadline elapsed mid-run yields stopped", async () => {
    const clockValue = { current: 0 };
    const runner: ReadOnlyChildRunner = {
      run: () => {
        // No gate call at all here either — only the post-resolution check can catch this.
        clockValue.current = 5_000;
        return Promise.resolve({ resultCount: 1, resultDigest: { outcome: "absent" } });
      },
    };
    const { deps } = harness(runner, { clock: { now: () => clockValue.current } });
    const outcome = await createReadOnlyChildOrchestrator(deps).handleChildRequest(
      childRequest(),
      contextFor({ deadlineMs: 1_000 }),
    );
    expect(outcome).toMatchObject({ status: "stopped", reasonCode: "timeout" });
  });

  it("actually aborts the runner's signal at the wall-clock deadline, not just reports it late", async () => {
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const runner: ReadOnlyChildRunner = {
        run: (input) =>
          new Promise((resolve) => {
            input.signal.addEventListener("abort", () => {
              sawAbort = true;
            });
            setTimeout(() => {
              resolve({ resultCount: 0, resultDigest: { outcome: "absent" } });
            }, 5_000);
          }),
      };
      const { deps } = harness(runner);
      const outcomePromise = createReadOnlyChildOrchestrator(deps).handleChildRequest(
        childRequest(),
        contextFor({ deadlineMs: 1_000 }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sawAbort).toBe(true);
      await vi.advanceTimersByTimeAsync(4_000);
      await outcomePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps the request's tool-call bound to the parent authority's budget ceiling", async () => {
    let receivedMaxToolCalls: number | undefined;
    const runner: ReadOnlyChildRunner = {
      run: (input) => {
        receivedMaxToolCalls = input.maxToolCalls;
        return Promise.resolve({ resultCount: 0, resultDigest: { outcome: "absent" } });
      },
    };
    const { deps } = harness(runner);
    await createReadOnlyChildOrchestrator(deps).handleChildRequest(childRequest(999), contextFor());
    expect(receivedMaxToolCalls).toBe(parentAuthority().budget.maxToolCalls);
  });
});
