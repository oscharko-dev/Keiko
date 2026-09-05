import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { createDraftRun, AT, DIGEST } from "../gitDelivery/ciObservationTest/_support.js";
import type { DraftDeliveryDependencies } from "../gitDelivery/draftDeliveryTypes.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { redactLogFields } from "../observability/log-redaction.js";
import { createCodingRuntimeCiRepairBudgetStore } from "./codingRuntimeCiRepairBudgetStore.js";
import type {
  CodingRuntimeSnapshot,
  CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";
import { createProductionCiRepairBudget } from "./productionCiRepairRuntime.js";
import type {
  VerifiedCommitRuntimeBinding,
  VerifiedCommitRuntimeDependencies,
} from "./productionVerifiedCommitRuntime.js";
import {
  createCodingToolGovernedDelegate,
  type CodingToolGovernedPorts,
} from "./codingToolGovernedDelegate.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const workspace: WorkspaceInfo = {
  root: "/managed/worktree",
  selectedRoot: "/managed/worktree",
  name: "fixture",
  version: undefined,
  testFramework: "vitest",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};
function binding(snapshot: CodingRuntimeSnapshot): VerifiedCommitRuntimeBinding {
  return {
    runId: snapshot.runId,
    envelopeDigest: DIGEST,
    stillAuthorized: () => true,
    signal: new AbortController().signal,
    context: {
      runId: snapshot.runId,
      operatorId: "operator-1",
      taskId: "task-1",
      projectId: "project-1",
      projectDigest: snapshot.taskDigest,
      workspaceId: "workspace-1",
      workspaceRoot: workspace.root,
      branchRef: "feature/issue-1",
      branchHeadDigest: DIGEST,
      repositoryIdentity: { kind: "local", digest: DIGEST },
      ...(snapshot.issueBinding === undefined ? {} : { issueBinding: snapshot.issueBinding }),
      branch: {
        baseRef: "dev",
        headRef: "feature/issue-1",
        allowDetachedHead: false,
        allowedPrefixes: ["feature/"],
      },
      deploymentCeiling: "autonomous-delivery",
      runtimeSource: "keiko-sidecar",
      actionClasses: ["workspace-read", "workspace-write", "verification"],
      connectorScopes: [],
      modelProfile: {
        profileId: "profile-1",
        source: "keiko-model-gateway",
        supportsStreaming: true,
        supportsToolCalling: true,
      },
      commandPolicy: {
        mode: "governed",
        allow: [],
        deny: [],
        maxCommandTimeoutMs: 60_000,
        requirePerCommandApproval: false,
      },
      networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
      gates: [],
      budget: { maxRuntimeMs: 60_000, maxToolCalls: 1, maxPromptTokens: 1000, maxPatchBytes: 1024 },
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
}
function recover(snapshots: CodingRuntimeSnapshotStore): CodingRuntimeSnapshot {
  const source = snapshots.get("run-1");
  if (source?.draftDelivery === undefined) throw new Error("Missing initial draft");
  snapshots.markNonterminalRecoveryRequired(AT);
  snapshots.acknowledgeRecovery("run-1", AT);
  snapshots.releaseRecoveryForRetry("run-1", AT);
  const {
    draftDelivery,
    verifiedCommitResult: _receipt,
    ciReadiness: _readiness,
    ...shared
  } = source;
  expect(_receipt?.status).toBe("succeeded");
  expect(_readiness).toBeUndefined();
  snapshots.create({
    ...shared,
    runId: "run-2",
    predecessorRunId: "run-1",
    revision: 0,
    authorityDigest: "b".repeat(64),
  });
  return snapshots.adoptDraftDeliveryFromPredecessor({
    ...draftDelivery,
    revision: 0,
    phase: "recovery-required",
    reason: "restart-reconciliation",
    proposalId: "recovery-2",
    binding: {
      ...draftDelivery.binding,
      runId: "run-2",
      runtimeAuthorityDigest: "b".repeat(64),
      envelopeDigest: "b".repeat(64),
    },
  });
}
function dependencies(
  snapshots: CodingRuntimeSnapshotStore,
  events: ServerLogEvent[],
): {
  readonly deps: DraftDeliveryDependencies;
  readonly verified: VerifiedCommitRuntimeDependencies;
} {
  const shared = {
    snapshots,
    mutationDeps: {
      redactor: (value: unknown): unknown => value,
      evidenceStore: {
        put: (): string => "evidence",
        get: (): undefined => undefined,
        list: (): readonly string[] => [],
        delete: (): void => undefined,
      },
    },
    execution: {
      now: (): number => Date.parse(AT),
      activityLog: {
        write: (event: ServerLogEvent): void => {
          events.push(event);
        },
      },
    },
  };
  return {
    deps: {
      ...shared,
      resolveTarget: () => Promise.resolve({ ok: true, repository: "owner/repository" }),
      inspectionAdapter: () => undefined,
      publishSeams: () => ({}),
      pullRequestSeams: () => ({}),
    },
    verified: {
      ...shared,
      resolveWorkspace: () => workspace,
      buffersClean: () => true,
      messageAllowed: () => Promise.resolve(true),
    },
  };
}
function fixture(recovered: boolean): {
  readonly snapshots: CodingRuntimeSnapshotStore;
  readonly current: VerifiedCommitRuntimeBinding;
  readonly deps: DraftDeliveryDependencies;
  readonly verified: VerifiedCommitRuntimeDependencies;
  readonly events: ServerLogEvent[];
} {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const snapshots = createDraftRun(db);
  const initial = snapshots.get("run-1");
  if (initial?.draftDelivery === undefined) throw new Error("Missing initial draft");
  const events: ServerLogEvent[] = [];
  const store = createCodingRuntimeCiRepairBudgetStore({
    db,
    snapshots,
    now: () => Date.parse(AT),
    activityLog: {
      write: (event): void => {
        events.push(event);
      },
    },
  });
  const context = {
    runId: "run-1",
    remoteDigest: DIGEST,
    prNumber: 17,
    correlationId: "run-1",
    stillAuthorized: (): boolean => true,
    limits: { maxRuntimeMs: 60000, maxToolCalls: 1, maxPromptTokens: 1000 },
  };
  expect(
    store.begin(context, {
      attemptId: "attempt-1",
      failureSignatureDigest: DIGEST,
      kind: "verification",
      headSha: initial.draftDelivery.binding.headSha,
      baseSha: initial.draftDelivery.binding.baseSha,
      expectedRevision: null,
    }).status,
  ).toBe("recorded");
  expect(
    store.charge(context, {
      attemptId: "attempt-1",
      chargeId: "call-1",
      toolCalls: 1,
      promptTokens: 0,
      expectedRevision: 0,
    }),
  ).toMatchObject({ status: "blocked", reason: "tool-budget-exhausted" });
  return {
    snapshots,
    current: binding(recovered ? recover(snapshots) : initial),
    ...dependencies(snapshots, events),
    events,
  };
}
function ports(run: () => Promise<{ readonly status: "completed" }>): CodingToolGovernedPorts {
  const port = { execute: run };
  return {
    repositoryRead: port,
    repositoryDiscover: port,
    editorChangeset: port,
    commandRunner: port,
    verificationRunner: port,
    gitAuthority: port,
    deliveryAuthority: port,
    connectorAuthority: port,
    egressAuthority: port,
  };
}
const request = {
  action: "verification",
  verifierId: "test",
  actionId: "next",
  idempotencyKey: "next",
} as const;
describe("production CI repair accounting availability", () => {
  it.each([
    [false, "ciRepairBudget"],
    [true, "ciRepairBudget"],
    [false, "ciReadiness"],
    [true, "ciReadiness"],
  ] as const)(
    "blocks confirmed PR work with recovered=%s and missing %s",
    async (recovered, missing) => {
      const test = fixture(recovered);
      const snapshots = { ...test.snapshots };
      if (missing === "ciReadiness") delete snapshots.ciReadiness;
      else delete snapshots.ciRepairBudget;
      const budget = createProductionCiRepairBudget(
        { ...test.deps, snapshots },
        test.verified,
        test.current,
      );
      const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));
      const delegate = createCodingToolGovernedDelegate(ports(run), budget);
      expect(await delegate.execute(request, undefined, { check: () => true })).toMatchObject({
        outcome: "failed",
      });
      expect(run).not.toHaveBeenCalled();
      expect(budget?.chargePrompt(1)).toBe(false);
      expect(budget?.chargeDelegatedRead?.("child", "read")).toBe(false);
      expect(test.events.find((event) => event.extra?.phase === "availability")).toMatchObject({
        op: "git.ci-repair.budget",
        correlationId: test.current.runId,
        extra: { phase: "availability", reason: "storage-unavailable" },
      });
      const event = test.events.at(-1);
      expect(redactLogFields(event?.extra ?? {})).toEqual(event?.extra);
      expect(JSON.stringify(test.events)).not.toContain(workspace.root);
    },
  );
  it("preserves explicit pre-PR work, then denies when its confirmed draft appears", () => {
    const test = fixture(false);
    const snapshot = test.snapshots.get("run-1");
    if (snapshot === undefined) throw new Error("Missing run");
    let confirmed = false;
    const { draftDelivery: _draft, ...prePr } = snapshot;
    expect(_draft?.pullRequest?.number).toBe(17);
    const snapshots = {
      ...test.snapshots,
      get: (): CodingRuntimeSnapshot => (confirmed ? snapshot : prePr),
    };
    delete snapshots.ciRepairBudget;
    const budget = createProductionCiRepairBudget(
      { ...test.deps, snapshots },
      test.verified,
      test.current,
    );
    expect(budget?.admitTool(request)?.check()).toBe(true);
    expect(budget?.chargePrompt(1)).toBe(true);
    confirmed = true;
    expect(budget?.admitTool(request)).toBeUndefined();
    expect(budget?.chargePrompt(1)).toBe(false);
  });
  it("retains a recovered predecessor's confirmed PR before current-run adoption appears", () => {
    const test = fixture(true);
    const current = test.snapshots.get("run-2");
    if (current === undefined) throw new Error("Missing recovered run");
    const { draftDelivery, ...awaitingAdoption } = current;
    expect(draftDelivery?.pullRequest?.number).toBe(17);
    const snapshots = {
      ...test.snapshots,
      get: (runId: string): CodingRuntimeSnapshot | undefined =>
        runId === "run-2" ? awaitingAdoption : test.snapshots.get(runId),
    };
    delete snapshots.ciRepairBudget;
    const budget = createProductionCiRepairBudget(
      { ...test.deps, snapshots },
      test.verified,
      test.current,
    );
    expect(budget?.admitTool(request)).toBeUndefined();
    expect(budget?.chargePrompt(1)).toBe(false);
  });
  it("requires predecessor PR adoption even when both accounting stores are healthy", () => {
    const test = fixture(true);
    const current = test.snapshots.get("run-2");
    if (current === undefined) throw new Error("Missing recovered run");
    const { draftDelivery, ...awaitingAdoption } = current;
    expect(draftDelivery?.pullRequest?.number).toBe(17);
    const snapshots = {
      ...test.snapshots,
      get: (runId: string): CodingRuntimeSnapshot | undefined =>
        runId === "run-2" ? awaitingAdoption : test.snapshots.get(runId),
    };
    const budget = createProductionCiRepairBudget(
      { ...test.deps, snapshots },
      test.verified,
      test.current,
    );
    expect(budget?.admitTool(request)).toBeUndefined();
    expect(budget?.chargePrompt(1)).toBe(false);
    expect(budget?.chargeDelegatedRead?.("child", "read")).toBe(false);
  });
  it("fails closed on a missing current snapshot with healthy accounting dependencies", () => {
    const test = fixture(true);
    const snapshots = { ...test.snapshots, get: (): undefined => undefined };
    const budget = createProductionCiRepairBudget(
      { ...test.deps, snapshots },
      test.verified,
      test.current,
    );
    expect(budget?.admitTool(request)).toBeUndefined();
    expect(budget?.chargePrompt(1)).toBe(false);
  });
  it("keeps ordinary generic work available without introducing repair accounting", () => {
    const test = fixture(false);
    const { issueBinding, ...genericContext } = test.current.context;
    expect(issueBinding).toBeDefined();
    const budget = createProductionCiRepairBudget(undefined, undefined, {
      ...test.current,
      context: genericContext,
    });
    expect(budget?.admitTool(request)?.check()).toBe(true);
    expect(budget?.chargePrompt(1)).toBe(true);
  });
  it("does not infer pre-PR status from missing issue-bound history", () => {
    const test = fixture(true);
    const budget = createProductionCiRepairBudget(undefined, undefined, test.current);
    expect(budget?.chargePrompt(1)).toBe(false);
    expect(budget?.admitTool(request)).toBeUndefined();
  });
});
